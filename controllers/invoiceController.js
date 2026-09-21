const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const Invoice = require("../models/Invoice");
const { canEmailCourse, deliverCourseEmail, queueCourseEmail } = require("../utils/deliverCourseEmail");
const { courses, isPaidCourse } = require("../utils/courseAccess");

const PAYSTACK_BASE_URL = "https://api.paystack.co";
const INVOICE_LIFETIME_HOURS = 8;
const sanitizeAttribution = require("../utils/courseAttribution");

const paystackHeaders = () => ({
  Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`,
  "Content-Type": "application/json",
});

const getPublicInvoice = (invoice) => ({
  token: invoice.token,
  amount: invoice.amount,
  customerName: invoice.customerName,
  note: invoice.note,
  status: invoice.status,
  accountName: invoice.accountName,
  accountNumber: invoice.accountNumber,
  bankName: invoice.bankName,
  expiresAt: invoice.expiresAt,
  paidAt: invoice.paidAt,
  createdAt: invoice.createdAt,
  ...(invoice.product === "whatsapp-course" && invoice.status === "paid" && invoice.amount === 10000 ? { contactUrl: "https://wa.me/2348143017102?text=I%20just%20paid" } : isPaidCourse(invoice) ? { courses } : {}),
});

const refreshInvoiceStatus = async (invoice, strict = false) => {
  if (invoice.status === "paid") { await queueCourseEmail(invoice); return invoice; }

  if (!invoice.reference && invoice.expiresAt && new Date(invoice.expiresAt) < new Date()) {
    invoice.status = "expired";
    await invoice.save();
    return invoice;
  }

  if (!invoice.reference) return invoice;

  try {
    const response = await axios.get(
      `${PAYSTACK_BASE_URL}/transaction/verify/${invoice.reference}`,
      { headers: paystackHeaders(), timeout: 10000 },
    );

    const transaction = response.data.data;
    invoice.paystackStatus = transaction.status;
    invoice.paymentCheckedAt = new Date();

    if (transaction.status === "success" &&
        transaction.amount === invoice.amount * 100 &&
        transaction.currency === "NGN") {
      invoice.status = "paid";
      invoice.paidAt = transaction.paid_at || new Date();
    } else if (transaction.status === "failed" || transaction.status === "abandoned") {
      invoice.status = "failed";
    } else if (invoice.expiresAt && new Date(invoice.expiresAt) < new Date()) {
      invoice.status = "expired";
    }

    await invoice.save();
    if (invoice.status === "paid") await queueCourseEmail(invoice);
  } catch (error) {
    if (strict) throw error;
    console.log("PAYSTACK VERIFY ERROR:", error.response?.data || error.message);
  }

  return invoice;
};

const generateInvoiceTransfer = async (invoice) => {
  const refreshedInvoice = await refreshInvoiceStatus(invoice);

  if (refreshedInvoice.status === "paid" || refreshedInvoice.status === "expired") {
    return refreshedInvoice;
  }

  if (refreshedInvoice.accountNumber && refreshedInvoice.status === "pending") {
    return refreshedInvoice;
  }

  const reference = `invoice-${Date.now()}-${uuidv4().slice(0, 8)}`;
  const expiresAt = new Date(
    Date.now() + INVOICE_LIFETIME_HOURS * 60 * 60 * 1000,
  );
  const email =
    refreshedInvoice.customerEmail ||
    `invoice-${refreshedInvoice.token}@joshspotmedia.com`;

  // Preserve the reference if Paystack accepts the charge but the response is lost.
  refreshedInvoice.reference = reference;
  await refreshedInvoice.save();

  const response = await axios.post(
    `${PAYSTACK_BASE_URL}/charge`,
    {
      email,
      amount: refreshedInvoice.amount * 100,
      reference,
      bank_transfer: {
        account_expires_at: expiresAt.toISOString(),
      },
      metadata: {
        invoiceId: refreshedInvoice._id,
        invoiceToken: refreshedInvoice.token,
        customerName: refreshedInvoice.customerName,
        note: refreshedInvoice.note,
      },
    },
    { headers: paystackHeaders() },
  );

  const charge = response.data.data;

  refreshedInvoice.reference = charge.reference || reference;
  refreshedInvoice.status = "pending";
  refreshedInvoice.paystackStatus = charge.status;
  refreshedInvoice.accountName = charge.account_name;
  refreshedInvoice.accountNumber = charge.account_number;
  refreshedInvoice.bankName = charge.bank?.name;
  refreshedInvoice.expiresAt = charge.account_expires_at || expiresAt;

  await refreshedInvoice.save();

  return refreshedInvoice;
};

exports.createInvoice = async (req, res) => {
  let invoice;
  try {
    const coursePurchase = ["ads-course", "whatsapp-course"].includes(req.body.product) || String(req.body.note || "").startsWith("Course purchase - WhatsApp:");
    const whatsappCourse = req.body.product === "whatsapp-course";
    const amount = whatsappCourse ? 10000 : coursePurchase ? 8000 : Number(req.body.amount);
    const customerEmail = String(req.body.customerEmail || "").trim().toLowerCase();
    const customerName = String(req.body.customerName || "").trim();
    const customerPhone = String(req.body.customerPhone || "").trim();
    if (customerEmail && (customerEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail))) {
      return res.status(400).json({ message: "Please enter a valid email address." });
    }
    if (coursePurchase && (!customerName || customerName.length > 150 || !/^\+?\d{7,15}$/.test(customerPhone || String(req.body.note).split("WhatsApp:")[1]?.trim() || ""))) {
      return res.status(400).json({ message: "Please enter your name and a valid WhatsApp number." });
    }

    if (!amount || amount < 100) {
      return res.status(400).json({ message: "Please enter a valid amount." });
    }

    invoice = await Invoice.create({
      token: uuidv4(),
      amount,
      customerName,
      customerEmail,
      customerPhone,
      product: whatsappCourse ? "whatsapp-course" : coursePurchase ? "ads-course" : "",
      ...(coursePurchase ? { attribution: sanitizeAttribution(req.body.attribution) } : {}),
      note: req.body.note || "",
      expiresAt: new Date(Date.now() + INVOICE_LIFETIME_HOURS * 60 * 60 * 1000),
    });

    const invoiceWithTransfer = await generateInvoiceTransfer(invoice);
    const clientUrl =
      process.env.CLIENT_URL || req.headers.origin || "http://localhost:3000";

    res.status(201).json({
      invoice: getPublicInvoice(invoiceWithTransfer),
      invoiceUrl: `${clientUrl}/pay-invoice/${invoice.token}`,
    });
  } catch (error) {
    if (invoice) {
      invoice.status = "failed";
      await invoice.save().catch(() => {});
    }
    console.log("CREATE INVOICE ERROR:", error.response?.data || error);
    res.status(500).json({ message: "Unable to create invoice" });
  }
};

exports.getInvoice = async (req, res) => {
  try {
    const invoice = await Invoice.findOne({ token: req.params.token });

    if (!invoice) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    let refreshedInvoice = await refreshInvoiceStatus(invoice);

    if (
      refreshedInvoice.status !== "paid" &&
      refreshedInvoice.status !== "expired" &&
      !refreshedInvoice.accountNumber
    ) {
      refreshedInvoice = await generateInvoiceTransfer(refreshedInvoice);
    }

    res.json(getPublicInvoice(refreshedInvoice));
  } catch (error) {
    console.log("GET INVOICE ERROR:", error.response?.data || error);
    res.status(500).json({ message: "Unable to fetch invoice" });
  }
};

exports.startInvoiceTransfer = async (req, res) => {
  try {
    const invoice = await Invoice.findOne({ token: req.params.token });

    if (!invoice) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    const invoiceWithTransfer = await generateInvoiceTransfer(invoice);

    if (invoiceWithTransfer.status === "expired") {
      return res.status(410).json({ message: "This invoice has expired." });
    }

    res.json(getPublicInvoice(invoiceWithTransfer));
  } catch (error) {
    console.log("START INVOICE TRANSFER ERROR:", error.response?.data || error);
    res.status(500).json({ message: "Unable to generate payment account" });
  }
};

exports.listInvoices = async (req, res) => {
  try {
    const invoices = await Invoice.find({ deletedAt: null }).sort({ createdAt: -1 });
    res.json(invoices);
  } catch (error) {
    console.log("LIST INVOICES ERROR:", error);
    res.status(500).json({ message: "Unable to fetch invoices" });
  }
};

exports.emailCourseAccess = async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: "Please enter a valid email address." });
    const invoice = await Invoice.findOne({ token: req.params.token });
    if (!invoice) return res.status(404).json({ message: "Invoice not found." });
    await refreshInvoiceStatus(invoice);
    if (!canEmailCourse(invoice)) return res.status(403).json({ message: "Your course payment must be confirmed first." });
    await Invoice.updateOne({ _id: invoice._id }, { $set: { customerEmail: email } });
    const result = await deliverCourseEmail(invoice._id, { resend: true });
    if (result === "busy") return res.status(429).json({ message: "Your email is being sent, or was just sent. Please check your inbox and spam folder." });
    return res.json({ message: "The video links has been sent to your email. Also check your spam folder too incase you can't find it in your inbox." });
  } catch {
    return res.status(503).json({ message: "Email delivery is delayed. Your address is saved and we will retry automatically. You can also use the access button on this page." });
  }
};
exports.refreshInvoiceStatus = refreshInvoiceStatus;

