const Invoice = require("../models/Invoice");
const { Resend } = require("resend");
const { createHash } = require("node:crypto");
const { isPaidCourse } = require("./courseAccess");
const content = require("./courseEmailContent");

const canEmailCourse = invoice => !invoice.deletedAt && (isPaidCourse(invoice) ||
  (invoice.product === "whatsapp-course" && invoice.status === "paid" && invoice.amount === 10000));
const validEmail = email => typeof email === "string" && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

async function deliverCourseEmail(id, { resend = false } = {}) {
  const invoice = await Invoice.findById(id);
  if (!invoice || !canEmailCourse(invoice) || !validEmail(invoice.customerEmail)) return "skipped";
  if (!resend && invoice.courseEmailSentAt) return "sent";
  const now = new Date();
  const claimed = await Invoice.findOneAndUpdate({
    _id: id, status: "paid", customerEmail: invoice.customerEmail, deletedAt: null,
    $and: [
      { $or: [{ courseEmailClaimedAt: null }, { courseEmailClaimedAt: { $lt: new Date(Date.now() - 120000) } }] },
      resend ? { $or: [{ courseEmailSentAt: null }, { courseEmailSentAt: { $lt: new Date(Date.now() - 60000) } }] } : { courseEmailSentAt: null },
    ],
  }, { $set: { courseEmailClaimedAt: now, courseEmailQueuedAt: now } }, { new: true });
  if (!claimed) return "busy";
  try {
    if (!process.env.RESEND_API_KEY) throw new Error("Resend is not configured");
    const recipientKey = createHash("sha256").update(claimed.customerEmail).digest("hex").slice(0, 20);
    const { data, error } = await new Resend(process.env.RESEND_API_KEY).emails.send({
      from: process.env.RESEND_FROM_EMAIL || "Joshspot Media <booking@joshspotmedia.com>",
      to: claimed.customerEmail,
      ...content(claimed),
    }, { idempotencyKey: `course-access/${id}/${recipientKey}/${(claimed.courseEmailSendCount || 0) + 1}` });
    if (error) throw new Error("Email provider rejected delivery");
    await Invoice.updateOne({ _id: id, courseEmailClaimedAt: now }, {
      $set: { courseEmailSentAt: new Date(), courseEmailId: data?.id || "" },
      $inc: { courseEmailSendCount: 1 },
      $unset: { courseEmailClaimedAt: 1, courseEmailQueuedAt: 1, courseEmailRetryAt: 1, courseEmailError: 1 },
    });
    return "sent";
  } catch (error) {
    await Invoice.updateOne({ _id: id, courseEmailClaimedAt: now }, {
      $set: { courseEmailQueuedAt: now, courseEmailRetryAt: new Date(Date.now() + 300000), courseEmailError: "Delivery delayed; retry scheduled" },
      $unset: { courseEmailClaimedAt: 1 },
    }).catch(() => {});
    throw error;
  }
}

async function queueCourseEmail(invoice) {
  if (!canEmailCourse(invoice) || !validEmail(invoice.customerEmail) || invoice.courseEmailSentAt) return;
  if (invoice.courseEmailRetryAt && new Date(invoice.courseEmailRetryAt) > new Date()) return;
  await Invoice.updateOne({ _id: invoice._id, courseEmailSentAt: null }, { $set: { courseEmailQueuedAt: new Date() } });
  // Sending failures never roll back a verified payment. The persisted queue retries.
  try { await deliverCourseEmail(invoice._id); } catch { /* queued for retry */ }
}

let running = false;
async function retryCourseEmails() {
  if (running) return;
  running = true;
  try {
    const invoices = await Invoice.find({ status: "paid", deletedAt: null, courseEmailQueuedAt: { $exists: true },
      $or: [{ courseEmailRetryAt: null }, { courseEmailRetryAt: { $lte: new Date() } }],
    }).sort({ courseEmailQueuedAt: 1 }).limit(20);
    for (const invoice of invoices) {
      try { await deliverCourseEmail(invoice._id, { resend: !!invoice.courseEmailSentAt }); } catch { /* next pass */ }
    }
  } finally { running = false; }
}
module.exports = { canEmailCourse, deliverCourseEmail, queueCourseEmail, retryCourseEmails };
