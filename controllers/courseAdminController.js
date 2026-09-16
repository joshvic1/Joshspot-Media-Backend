const Invoice = require("../models/Invoice");
const { Resend } = require("resend");
const { refreshInvoiceStatus } = require("./invoiceController");
const { isCourse } = require("../utils/courseAccess");
const courseQuery = { deletedAt: null, $or: [{ product: "ads-course" }, { note: /^Course purchase - WhatsApp:/ }] };
const phoneOf = (record) => record.customerPhone || (record.note || "").split("WhatsApp:")[1]?.trim() || "";
const statusOf = (record) => {
  if (record.status === "paid") return "paid";
  if (record.status === "failed") return "failed";
  if (record.status === "expired" || record.paystackStatus === "abandoned" ||
      Date.now() - new Date(record.createdAt).getTime() >= 30 * 60 * 1000) return "abandoned";
  return "pending";
};
const publicRecord = (record) => ({
  id: String(record._id), name: record.customerName, phone: phoneOf(record),
  attribution: record.attribution || { source: "unknown", browser: "unknown", method: "none" },
  email: record.customerEmail || "", amount: record.amount, status: statusOf(record),
  createdAt: record.createdAt, paidAt: record.paidAt, reminderSentAt: record.reminderSentAt,
  reminderCount: record.reminderCount || 0, paymentCheckedAt: record.paymentCheckedAt,
});

exports.listCoursePayments = async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const records = (await Invoice.find(courseQuery).sort({ createdAt: -1 }).lean()).map(publicRecord);
    const summary = { total: records.length, paid: 0, pending: 0, abandoned: 0, failed: 0, revenue: 0 };
    for (const record of records) {
      summary[record.status]++;
      if (record.status === "paid") summary.revenue += record.amount;
    }
    const query = String(req.query.search || "").trim().toLowerCase();
    const status = String(req.query.status || "all");
    const filtered = records.filter((record) => (status === "all" || record.status === status) &&
      (!query || [record.name, record.phone, record.email].some((value) => String(value || "").toLowerCase().includes(query))));
    const pages = Math.max(1, Math.ceil(filtered.length / 20));
    const page = Math.min(pages, Math.max(1, parseInt(req.query.page, 10) || 1));
    return res.json({ records: filtered.slice((page - 1) * 20, page * 20), summary, total: filtered.length, page, pages });
  } catch {
    return res.status(500).json({ message: "Unable to load course payments. Please try again." });
  }
};

exports.checkCoursePayment = async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice || invoice.deletedAt || !isCourse(invoice)) return res.status(404).json({ message: "Course payment not found." });
    await refreshInvoiceStatus(invoice, true);
    return res.json({ record: publicRecord(invoice), message: "Payment status checked." });
  } catch {
    return res.status(502).json({ message: "We could not verify this payment with Paystack. Please try again." });
  }
};

exports.remindCoursePayment = async (req, res) => {
  let claimed;
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice || invoice.deletedAt || !isCourse(invoice)) return res.status(404).json({ message: "Course payment not found." });
    await refreshInvoiceStatus(invoice, true);
    if (invoice.status === "paid") return res.status(409).json({ message: "This customer has already paid. No reminder was sent." });
    if (!invoice.customerEmail) return res.status(400).json({ message: "No email address was provided for this checkout." });
    const matches = [{ customerEmail: invoice.customerEmail }];
    if (phoneOf(invoice)) matches.push({ customerPhone: phoneOf(invoice) }, { note: `Course purchase - WhatsApp: ${phoneOf(invoice)}` });
    const paidPurchase = await Invoice.exists({ $and: [{ $or: courseQuery.$or }, { status: "paid" }, { $or: matches }] });
    if (paidPurchase) return res.status(409).json({ message: "This customer has another successful course payment. No reminder was sent." });
    if (!process.env.RESEND_API_KEY) return res.status(503).json({ message: "Email delivery is not configured." });
    const now = new Date();
    claimed = await Invoice.findOneAndUpdate({ _id: invoice._id, status: { $ne: "paid" }, $and: [
      { $or: [{ reminderSentAt: { $exists: false } }, { reminderSentAt: { $lt: new Date(Date.now() - 86400000) } }] },
      { $or: [{ reminderClaimedAt: { $exists: false } }, { reminderClaimedAt: { $lt: new Date(Date.now() - 300000) } }] },
    ] }, { $set: { reminderClaimedAt: now } }, { new: true });
    if (!claimed) return res.status(429).json({ message: "A reminder was already sent in the last 24 hours, or is being sent now." });
    const retryUrl = `${(process.env.CLIENT_URL || "https://joshspotmedia.com").replace(/\/$/, "")}/course`;
    const { data: emailResult, error } = await new Resend(process.env.RESEND_API_KEY).emails.send({
      from: process.env.RESEND_FROM_EMAIL || "Joshspot Media <booking@joshspotmedia.com>", to: invoice.customerEmail,
      subject: "Still want to learn TikTok, Facebook and Instagram ads?",
      text: `Hi ${invoice.customerName || "there"},\n\nYou started signing up for my TikTok, Facebook and Instagram ads course, but your payment has not been completed.\n\nWere you having a problem making the payment? You can go back to the course page and try again whenever you are ready:\n\n${retryUrl}\n\nOnce your payment is confirmed, you will get access to the course channels immediately.\n\nIf you have already paid, please check your payment status before making another payment.\n\nSee you inside the channels!\nJosh`,
    }, { idempotencyKey: `course-reminder/${invoice._id}/${(invoice.reminderCount || 0) + 1}` });
    if (error) throw new Error("Resend email delivery failed");
    await Invoice.updateOne({ _id: invoice._id, reminderClaimedAt: now }, {
      $set: { reminderSentAt: now, reminderEmailId: emailResult?.id || "" }, $unset: { reminderClaimedAt: 1 }, $inc: { reminderCount: 1 },
    });
    return res.json({ message: "Reminder email sent." });
  } catch {
    if (claimed) await Invoice.updateOne({ _id: claimed._id, reminderClaimedAt: claimed.reminderClaimedAt }, { $unset: { reminderClaimedAt: 1 } }).catch(() => {});
    return res.status(502).json({ message: "Unable to verify payment or send the reminder. Please try again." });
  }
};

exports.statusOf = statusOf;
