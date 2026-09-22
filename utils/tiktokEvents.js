const axios = require("axios");
const { createHash } = require("node:crypto");
const Invoice = require("../models/Invoice");
const { isPaidCourse } = require("./courseAccess");

const hash = value => createHash("sha256").update(value).digest("hex");
const configured = () => Boolean(process.env.TIKTOK_ACCESS_TOKEN && process.env.TIKTOK_PIXEL_ID);
const eligible = invoice => invoice && !invoice.deletedAt && isPaidCourse(invoice) && invoice.token;

function purchasePayload(invoice) {
  const user = {};
  const email = String(invoice.customerEmail || "").trim().toLowerCase();
  const phone = String(invoice.customerPhone || "").replace(/[^\d+]/g, "");
  if (email) user.email = hash(email);
  if (/^\+[1-9]\d{7,14}$/.test(phone)) user.phone = hash(phone);
  return {
    event_source: "web",
    event_source_id: process.env.TIKTOK_PIXEL_ID,
    ...(process.env.TIKTOK_TEST_EVENT_CODE ? { test_event_code: process.env.TIKTOK_TEST_EVENT_CODE } : {}),
    data: [{
      event: "Purchase",
      // Must match frontend/utils/coursePixel.js for browser/server deduplication.
      event_id: `course-${hash(invoice.token)}`,
      event_time: Math.floor(new Date(invoice.paidAt || invoice.tiktokPurchaseQueuedAt).getTime() / 1000),
      user,
      page: { url: "https://www.joshspotmedia.com/course" },
      properties: {
        currency: "NGN", value: Number(invoice.amount), content_type: "product",
        contents: [{ content_id: "ads-course", content_name: "TikTok, Facebook & Instagram Ads Course", quantity: 1, price: Number(invoice.amount) }],
      },
    }],
  };
}

async function queueTikTokPurchase(invoice) {
  if (!configured() || !eligible(invoice)) return;
  try {
    await Invoice.updateOne({ _id: invoice._id, status: "paid", deletedAt: null, tiktokPurchaseQueuedAt: null, tiktokPurchaseSentAt: null },
      { $set: { tiktokPurchaseQueuedAt: new Date() } });
  } catch { console.error("TikTok purchase could not be queued"); }
}

async function deliverTikTokPurchase(id) {
  if (!configured()) return "disabled";
  const now = new Date();
  const invoice = await Invoice.findOneAndUpdate({
    _id: id, status: "paid", deletedAt: null, tiktokPurchaseSentAt: null,
    tiktokPurchaseQueuedAt: { $ne: null },
    $and: [
      { $or: [{ tiktokPurchaseClaimedAt: null }, { tiktokPurchaseClaimedAt: { $lt: new Date(Date.now() - 120000) } }] },
      { $or: [{ tiktokPurchaseRetryAt: null }, { tiktokPurchaseRetryAt: { $lte: now } }] },
    ],
  }, { $set: { tiktokPurchaseClaimedAt: now } }, { new: true });
  if (!invoice) return "skipped";
  try {
    if (!eligible(invoice)) throw new Error("Ineligible invoice");
    const payload = purchasePayload(invoice);
    if (!Number.isFinite(payload.data[0].event_time)) throw new Error("Missing event time");
    const response = await axios.post("https://business-api.tiktok.com/open_api/v1.3/event/track/", payload, {
      headers: { "Access-Token": process.env.TIKTOK_ACCESS_TOKEN, "Content-Type": "application/json" }, timeout: 10000,
    });
    if (response.data?.code !== 0) throw new Error("TikTok rejected event");
    await Invoice.updateOne({ _id: id, tiktokPurchaseClaimedAt: now }, {
      $set: { tiktokPurchaseSentAt: new Date() },
      $unset: { tiktokPurchaseClaimedAt: 1, tiktokPurchaseRetryAt: 1, tiktokPurchaseError: 1 },
    });
    return "sent";
  } catch {
    // Never log the Axios error: its config contains the access token and customer data.
    await Invoice.updateOne({ _id: id, tiktokPurchaseClaimedAt: now }, {
      $set: { tiktokPurchaseRetryAt: new Date(Date.now() + 300000), tiktokPurchaseError: "Delivery delayed; check TikTok configuration" },
      $unset: { tiktokPurchaseClaimedAt: 1 },
    });
    return "retry";
  }
}

let running = false;
async function retryTikTokPurchases() {
  if (running || !configured()) return;
  running = true;
  try {
    const invoices = await Invoice.find({ status: "paid", deletedAt: null, tiktokPurchaseSentAt: null,
      tiktokPurchaseQueuedAt: { $ne: null },
      $or: [{ tiktokPurchaseRetryAt: null }, { tiktokPurchaseRetryAt: { $lte: new Date() } }],
    }).sort({ tiktokPurchaseQueuedAt: 1 }).limit(20);
    for (const invoice of invoices) await deliverTikTokPurchase(invoice._id);
  } finally { running = false; }
}

module.exports = { purchasePayload, queueTikTokPurchase, deliverTikTokPurchase, retryTikTokPurchases };
