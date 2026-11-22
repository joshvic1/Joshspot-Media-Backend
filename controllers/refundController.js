const axios = require("axios");
const Invoice = require("../models/Invoice");
const Refund = require("../models/Refund");
const Client = require("../models/Client");
const AdsClient = require("../models/AdsClient");
const VerificationClient = require("../models/VerificationClient");
const { phone: normalizePhone } = require("../inbox/policy");

const PAYSTACK_URL = "https://api.paystack.co";
const FLUTTERWAVE_URL = "https://api.flutterwave.com/v3";
const ACTIVE_REFUND_STATUSES = new Set(["initiating", "pending", "processing", "needs_attention"]);
const FINAL_REFUND_STATUSES = new Set(["processed", "failed"]);
const CRM_MODELS = {
  setup: { model: Client, label: "Setup client", name: (row) => row.businessName, service: (row) => row.servicePaidFor },
  ads: { model: AdsClient, label: "Ads client", name: (row) => row.businessName, service: (row) => row.servicePaidFor },
  verification: { model: VerificationClient, label: "Verification client", name: (row) => row.businessName || row.name, service: (row) => row.service || "Verification" },
};

const providerFor = (invoice) => {
  if (invoice.paymentProvider === "flutterwave") return "flutterwave";
  if (invoice.paymentProvider === "paystack" || !invoice.paymentProvider) return "paystack";
  return null;
};

const storedPhone = (invoice) => String(invoice.customerPhone || "").trim()
  || String(invoice.note || "").match(/WhatsApp:\s*([^\n]+)/i)?.[1]?.trim()
  || "";

function normalizedInvoicePhone(invoice) {
  try { return normalizePhone(storedPhone(invoice)); } catch { return ""; }
}

function normalizeProviderStatus(provider, value) {
  const status = String(value || "").trim().toLowerCase().replaceAll("_", "-");
  if (provider === "paystack") {
    if (["processed", "success", "successful"].includes(status)) return "processed";
    if (["failed", "cancelled", "canceled"].includes(status)) return "failed";
    if (["needs-attention", "needsattention"].includes(status)) return "needs_attention";
    if (["pending", "processing", "queued"].includes(status)) return status === "processing" ? "processing" : "pending";
    return "needs_attention";
  }
  // Flutterwave documents "completed" as initiated but still pending
  // disbursement. Only an explicit final result can retract CRM records.
  if (["successful", "processed", "completed-bank-transfer", "completed-card-refund", "completed-mobile-money-refund"].includes(status)) return "processed";
  if (["failed", "cancelled", "canceled", "rejected"].includes(status)) return "failed";
  if (["pending", "processing", "initiated", "completed"].includes(status)) return "processing";
  return "needs_attention";
}

function safeProviderResponse(data) {
  if (!data || typeof data !== "object") return null;
  const allowed = ["id", "status", "amount", "currency", "created_at", "updated_at", "transaction", "flw_ref", "reference"];
  return Object.fromEntries(allowed.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]));
}

function providerError(error) {
  const details = error?.response?.data?.message || error?.response?.data?.error || error?.message || "The payment provider could not process this refund.";
  return String(details).replace(/[\r\n]+/g, " ").slice(0, 300);
}

function isExplicitProviderFailure(error) {
  return Boolean(error?.response && error.response.status >= 400 && error.response.status < 500);
}

function renderRefund(refund) {
  return {
    id: String(refund._id), provider: refund.provider, amount: Number(refund.amount || 0), status: refund.status,
    providerStatus: refund.providerStatus || "", reason: refund.reason, createdAt: refund.createdAt,
    updatedAt: refund.updatedAt, errorMessage: refund.errorMessage || "", retractionsAppliedAt: refund.retractionsAppliedAt || null,
    selectedRecords: (refund.selectedRecords || []).map((row) => ({ kind: row.kind, id: String(row.record), label: row.label || "CRM record" })),
  };
}

function invoiceSummary(invoice) {
  return {
    id: String(invoice._id), name: invoice.customerName || "", email: invoice.customerEmail || "", phone: storedPhone(invoice),
    amount: Number(invoice.amount || 0), paidAt: invoice.paidAt || null, reference: invoice.reference || "",
    provider: providerFor(invoice), paymentProvider: invoice.paymentProvider || "paystack", status: invoice.status,
    refundedAmount: Number(invoice.refundedAmount || 0), refundReservedAmount: Number(invoice.refundReservedAmount || 0),
    refundStatus: invoice.refundStatus || "none",
  };
}

async function relatedRecords(invoice) {
  const phone = normalizedInvoicePhone(invoice);
  if (!phone) return [];
  const sources = await Promise.all(Object.entries(CRM_MODELS).map(async ([kind, source]) => {
    const rows = await source.model.find({ retractedAt: null }).select("businessName name clientNumber amountPaid servicePaidFor service createdAt").lean();
    return rows.flatMap((row) => {
      try {
        if (normalizePhone(row.clientNumber) !== phone) return [];
      } catch { return []; }
      return [{ kind, id: String(row._id), title: source.name(row) || "Unnamed client", category: source.label,
        service: source.service(row) || "—", amountPaid: Number(row.amountPaid || 0), createdAt: row.createdAt }];
    });
  }));
  return sources.flat().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

async function selectedRecords(invoice, rawRecords) {
  if (!Array.isArray(rawRecords)) throw Object.assign(new Error("Choose the CRM records to retract, or leave them unchecked."), { status: 400 });
  if (rawRecords.length > 30) throw Object.assign(new Error("Too many CRM records were selected."), { status: 400 });
  const available = await relatedRecords(invoice);
  const allowed = new Map(available.map((row) => [`${row.kind}:${row.id}`, row]));
  const seen = new Set();
  return rawRecords.map((record) => {
    const kind = String(record?.kind || "");
    const id = String(record?.id || "");
    const key = `${kind}:${id}`;
    if (seen.has(key) || !allowed.has(key)) throw Object.assign(new Error("One of the selected CRM records is no longer available for this customer."), { status: 400 });
    seen.add(key);
    const row = allowed.get(key);
    return { kind, record: id, label: `${row.category}: ${row.title}`.slice(0, 240) };
  });
}

async function refreshInvoiceRefundTotals(invoiceId) {
  const refunds = await Refund.find({ invoice: invoiceId }).select("amount status").lean();
  const refundedAmount = refunds.filter((row) => row.status === "processed").reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const refundReservedAmount = refunds.filter((row) => ACTIVE_REFUND_STATUSES.has(row.status)).reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const status = refundedAmount > 0 && refundReservedAmount === 0
    ? "processed"
    : refunds.some((row) => row.status === "needs_attention") ? "needs_attention"
      : refundReservedAmount > 0 ? "processing"
        : refunds.some((row) => row.status === "failed") ? "failed" : "none";
  const update = { refundedAmount, refundReservedAmount, refundStatus: status };
  if (refundedAmount > 0) update.refundCompletedAt = new Date();
  await Invoice.updateOne({ _id: invoiceId }, { $set: update });
  return Invoice.findById(invoiceId);
}

async function applyRetractions(refund) {
  if (refund.status !== "processed" || !refund.selectedRecords?.length || refund.retractionsAppliedAt) return;
  const now = new Date();
  const actor = refund.initiatedBy || "admin";
  await Promise.all(refund.selectedRecords.map((record) => {
    const source = CRM_MODELS[record.kind];
    if (!source) return null;
    return source.model.updateOne({ _id: record.record, retractedAt: null }, {
      $set: { retractedAt: now, retractedBy: actor, retractedByRefund: refund._id },
    });
  }));
  await Refund.updateOne({ _id: refund._id, retractionsAppliedAt: null }, { $set: { retractionsAppliedAt: now, updatedAt: now } });
}

async function saveProviderResult(refund, responseData, providerStatus) {
  const status = normalizeProviderStatus(refund.provider, providerStatus);
  const providerRefundId = String(responseData?.id || responseData?.refund_id || refund.providerRefundId || "");
  const update = {
    status, providerStatus: String(providerStatus || ""), providerRefundId,
    providerResponse: safeProviderResponse(responseData), errorCode: "", errorMessage: "", updatedAt: new Date(),
  };
  const saved = await Refund.findByIdAndUpdate(refund._id, { $set: update }, { returnDocument: "after" });
  const invoice = await refreshInvoiceRefundTotals(saved.invoice);
  if (saved.status === "processed") {
    await applyRetractions(saved);
    try { await require("../telegram/access").revokeRefundedInvoiceAccess(invoice); } catch (error) { console.error("REFUND TELEGRAM ACCESS REVIEW", { refund: String(saved._id), message: error.message }); }
  }
  return Refund.findById(saved._id);
}

async function failRefund(refund, message, status = "failed") {
  const saved = await Refund.findByIdAndUpdate(refund._id, {
    $set: { status, errorMessage: String(message || "Refund requires review.").slice(0, 300), updatedAt: new Date() },
  }, { returnDocument: "after" });
  await refreshInvoiceRefundTotals(saved.invoice);
  return saved;
}

function paystackHeaders() {
  if (!process.env.PAYSTACK_SECRET) throw Object.assign(new Error("Paystack refunds are not configured."), { status: 503 });
  return { Authorization: `Bearer ${process.env.PAYSTACK_SECRET}` };
}

function flutterwaveHeaders() {
  if (!process.env.FLUTTERWAVE_SECRET_KEY) throw Object.assign(new Error("Flutterwave refunds are not configured."), { status: 503 });
  return { Authorization: `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}` };
}

async function requestProviderRefund(refund, invoice) {
  if (refund.provider === "paystack") {
    const response = await axios.post(`${PAYSTACK_URL}/refund`, {
      transaction: invoice.reference,
      amount: Math.round(Number(refund.amount) * 100),
      currency: "NGN",
      customer_note: refund.reason,
      merchant_note: `Joshspot admin refund ${String(refund._id)}`,
      reference: `refund_${String(refund._id)}`,
    }, { headers: paystackHeaders(), timeout: 20000 });
    if (!response.data?.status) throw Object.assign(new Error(response.data?.message || "Paystack did not accept the refund."), { explicit: true });
    const data = response.data.data || {};
    return saveProviderResult(refund, data, data.status || "pending");
  }
  if (!invoice.flutterwaveTransactionId) throw Object.assign(new Error("This Flutterwave payment has no verified transaction ID, so it cannot be refunded safely from this panel."), { status: 409, explicit: true });
  const response = await axios.post(`${FLUTTERWAVE_URL}/transactions/${encodeURIComponent(invoice.flutterwaveTransactionId)}/refund`, {
    amount: Number(refund.amount), comments: refund.reason,
  }, { headers: flutterwaveHeaders(), timeout: 20000 });
  if (String(response.data?.status || "").toLowerCase() !== "success") throw Object.assign(new Error(response.data?.message || "Flutterwave did not accept the refund."), { explicit: true });
  const data = response.data.data || {};
  return saveProviderResult(refund, data, data.status || "pending");
}

async function refreshProviderRefund(refund) {
  if (!ACTIVE_REFUND_STATUSES.has(refund.status) || !refund.providerRefundId) return refund;
  let response;
  if (refund.provider === "paystack") response = await axios.get(`${PAYSTACK_URL}/refund/${encodeURIComponent(refund.providerRefundId)}`, { headers: paystackHeaders(), timeout: 15000 });
  else response = await axios.get(`${FLUTTERWAVE_URL}/refunds/${encodeURIComponent(refund.providerRefundId)}`, { headers: flutterwaveHeaders(), timeout: 15000 });
  if (refund.provider === "paystack" && !response.data?.status) throw new Error(response.data?.message || "Paystack could not refresh the refund.");
  const data = response.data?.data || {};
  return saveProviderResult(refund, data, data.status || refund.providerStatus || "pending");
}

function validId(value) { return /^[a-f\d]{24}$/i.test(String(value || "")); }

function actor(req) { return String(req.admin?.email || req.admin?.name || req.admin?.id || "admin").slice(0, 180); }

exports.preview = async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ message: "Invalid invoice." });
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice || invoice.deletedAt) return res.status(404).json({ message: "Invoice not found." });
    const provider = providerFor(invoice);
    const [records, prior] = await Promise.all([
      relatedRecords(invoice), Refund.find({ invoice: invoice._id }).sort({ createdAt: -1 }),
    ]);
    // A normal admin-page refresh can safely reconcile existing provider IDs.
    await Promise.all(prior.filter((row) => ACTIVE_REFUND_STATUSES.has(row.status) && row.providerRefundId).map((row) => refreshProviderRefund(row).catch(() => row)));
    const refunds = await Refund.find({ invoice: invoice._id }).sort({ createdAt: -1 });
    const current = await refreshInvoiceRefundTotals(invoice._id);
    const maximumAmount = Math.max(0, Number(current.amount || 0) - Number(current.refundedAmount || 0) - Number(current.refundReservedAmount || 0));
    return res.json({ invoice: invoiceSummary(current), supported: Boolean(provider), provider,
      reason: provider ? "" : "Manual Moniepoint transfers must be refunded outside this panel and then recorded separately.",
      maximumAmount, records, refunds: refunds.map(renderRefund) });
  } catch (error) { return res.status(error.status || 500).json({ message: error.message || "Unable to prepare this refund." }); }
};

exports.create = async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ message: "Invalid invoice." });
  const idempotencyKey = String(req.body?.idempotencyKey || "").trim();
  const reason = String(req.body?.reason || "").trim();
  const amount = Number(req.body?.amount);
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) return res.status(400).json({ message: "The refund request could not be identified safely. Please try again." });
  if (!Number.isSafeInteger(amount) || amount < 1) return res.status(400).json({ message: "Enter a whole-number refund amount in naira." });
  if (reason.length < 3 || reason.length > 500) return res.status(400).json({ message: "Add a brief refund reason (3–500 characters)." });
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice || invoice.deletedAt) return res.status(404).json({ message: "Invoice not found." });
    if (invoice.status !== "paid") return res.status(409).json({ message: "Only a verified paid invoice can be refunded." });
    const provider = providerFor(invoice);
    if (!provider) return res.status(409).json({ message: "This is a manual Moniepoint transfer. Refund it from the bank, then record it outside this panel." });
    const existing = await Refund.findOne({ invoice: invoice._id, idempotencyKey });
    if (existing) return res.json({ refund: renderRefund(existing), duplicate: true, message: "This refund request was already received." });

    await refreshInvoiceRefundTotals(invoice._id);
    const selected = await selectedRecords(invoice, req.body?.records || []);
    const claimed = await Invoice.findOneAndUpdate({
      _id: invoice._id, status: "paid", $expr: { $gte: [
        { $subtract: [{ $ifNull: ["$amount", 0] }, { $add: [{ $ifNull: ["$refundedAmount", 0] }, { $ifNull: ["$refundReservedAmount", 0] }] }] }, amount,
      ] },
    }, { $inc: { refundReservedAmount: amount }, $set: { refundStatus: "pending" } }, { returnDocument: "after" });
    if (!claimed) return res.status(409).json({ message: "The refundable balance changed. Refresh this invoice before trying again." });

    let refund;
    try {
      refund = await Refund.create({ invoice: invoice._id, provider, amount, reason, idempotencyKey, initiatedBy: actor(req), selectedRecords: selected });
    } catch (error) {
      await Invoice.updateOne({ _id: invoice._id }, { $inc: { refundReservedAmount: -amount } });
      if (error?.code === 11000) {
        const duplicate = await Refund.findOne({ invoice: invoice._id, idempotencyKey });
        if (duplicate) return res.json({ refund: renderRefund(duplicate), duplicate: true, message: "This refund request was already received." });
      }
      throw error;
    }

    try {
      const saved = await requestProviderRefund(refund, invoice);
      const message = saved.status === "processed"
        ? "Refund confirmed. Selected CRM records were retracted from active views."
        : "Refund request sent. The selected CRM records remain active until the payment provider confirms it.";
      return res.status(201).json({ refund: renderRefund(saved), message });
    } catch (error) {
      const status = isExplicitProviderFailure(error) || error.explicit ? "failed" : "needs_attention";
      const saved = await failRefund(refund, providerError(error), status);
      return res.status(status === "failed" ? 400 : 502).json({ refund: renderRefund(saved), message: status === "failed"
        ? saved.errorMessage : "The provider did not return a final result. No second refund was created; review this request before trying again." });
    }
  } catch (error) { return res.status(error.status || 500).json({ message: error.message || "Unable to create the refund." }); }
};

exports.refresh = async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ message: "Invalid refund." });
  try {
    const refund = await Refund.findById(req.params.id);
    if (!refund) return res.status(404).json({ message: "Refund not found." });
    if (FINAL_REFUND_STATUSES.has(refund.status)) return res.json({ refund: renderRefund(refund), message: "This refund is already final." });
    if (!refund.providerRefundId) return res.status(409).json({ refund: renderRefund(refund), message: "The refund has no provider ID. It needs provider review before another request is made." });
    const saved = await refreshProviderRefund(refund);
    return res.json({ refund: renderRefund(saved), message: saved.status === "processed"
      ? "Refund confirmed. Selected CRM records were retracted from active views." : "Refund status refreshed. CRM records remain active until it is confirmed." });
  } catch (error) { return res.status(error.status || 502).json({ message: providerError(error) }); }
};

exports.handlePaystackWebhook = async (data) => {
  const providerRefundId = String(data?.id || "");
  if (!providerRefundId) return false;
  const refund = await Refund.findOne({ provider: "paystack", providerRefundId });
  if (!refund) return false;
  await saveProviderResult(refund, data, data.status || "pending");
  return true;
};

exports._private = { normalizeProviderStatus, normalizedInvoicePhone, refreshInvoiceRefundTotals, relatedRecords };
