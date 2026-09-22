const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const crypto = require("node:crypto");
const access = require("../utils/courseAccess");
const content = require("../utils/courseEmailContent");
const { resolveService } = require("../utils/serviceCatalog");
let row, sends = [], reject = false;
const Invoice = {
  async findById() { return { ...row }; },
  async findOne() { return row; },
  async findOneAndUpdate(query, update) {
    if (row.status !== "paid" || row.courseEmailClaimedAt || row.customerEmail !== query.customerEmail) return null;
    if (row.courseEmailSentAt && Date.now() - new Date(row.courseEmailSentAt) < 60000) return null;
    Object.assign(row, update.$set); return { ...row };
  },
  async updateOne(query, update) {
    if (query.courseEmailSentAt === null && row.courseEmailSentAt) return;
    Object.assign(row, update.$set || {});
    for (const key of Object.keys(update.$unset || {})) delete row[key];
    for (const [key, amount] of Object.entries(update.$inc || {})) row[key] = (row[key] || 0) + amount;
  },
};
function load(file, deps) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), {
    module, exports: module.exports, require: name => {
      if (name === "../utils/tiktokEvents") return {queueTikTokPurchase:async () => {}};
      if (!(name in deps)) throw Error("Unexpected dependency: " + name);
      return deps[name];
    }, process: { env: { RESEND_API_KEY: "mock", PAYSTACK_SECRET: "mock" } }, Date, console, Buffer,
  });
  return module.exports;
}
const delivery = load("utils/deliverCourseEmail.js", {
  "../models/Invoice": Invoice, "node:crypto": crypto, "./courseAccess": access, "./courseEmailContent": content,
  resend: { Resend: class { constructor() { this.emails = { send: async (payload, options) => {
    sends.push({ payload, options }); return reject ? { error: { message: "temporary" } } : { data: { id: "mock-email" } };
  } }; } } },
});
function invoice(product = "ads-course", status = "paid", email = "test@example.com") {
  return { _id: "test", product, status, amount: product === "whatsapp-course" ? 10000 : 8000, customerEmail: email, reference: "test-ref" };
}
(async () => {
  row = invoice("ads-course", "pending");
  await delivery.queueCourseEmail(row); assert.equal(sends.length, 0);
  row = invoice("ads-course", "paid", "");
  await delivery.queueCourseEmail(row); assert.equal(sends.length, 0);
  row = invoice(); await Promise.all([delivery.queueCourseEmail(row), delivery.queueCourseEmail(row)]);
  assert.equal(sends.length, 1); assert.ok(row.courseEmailSentAt); assert.match(sends[0].payload.text, /t.me/);
  await delivery.queueCourseEmail(row); assert.equal(sends.length, 1);
  row = invoice("whatsapp-course"); await delivery.queueCourseEmail(row);
  assert.ok(sends.at(-1).payload.text.includes("https://wa.me/")); assert.ok(!sends.at(-1).payload.text.includes("https://t.me/"));
  row = invoice(); reject = true; await delivery.queueCourseEmail(row);
  assert.ok(row.courseEmailQueuedAt); assert.ok(row.courseEmailRetryAt); assert.equal(row.courseEmailSentAt, undefined);
  const retryKey = sends.at(-1).options.idempotencyKey;
  reject = false; await delivery.deliverCourseEmail(row._id);
  assert.equal(sends.at(-1).options.idempotencyKey, retryKey); assert.ok(row.courseEmailSentAt); assert.equal(row.courseEmailQueuedAt, undefined);
  assert.equal(await delivery.deliverCourseEmail(row._id, { resend: true }), "busy");
  row = invoice("whatsapp-course", "paid", ""); row.customerEmail = "later@example.com";
  await delivery.deliverCourseEmail(row._id, { resend: true }); assert.equal(sends.at(-1).payload.to, "later@example.com");

  let queued = 0;
  const webhook = load("controllers/paymentWebhookController.js", {
    "node:crypto": crypto, "../models/Invoice": Invoice, "../models/Booking": { findOne: async () => null },
    "../utils/bookingPayment": { matchesBookingPayment: () => false },
    "../utils/deliverCourseEmail": { queueCourseEmail: async invoice => { assert.equal(invoice.status, "paid"); queued++; } },
  });
  const response = () => ({ code: 0, sendStatus(code) { this.code = code; return this; } });
  row = invoice("whatsapp-course", "pending");
  const body = { event: "charge.success", data: { reference: "test-ref", currency: "NGN", status: "success", amount: 1000000 } };
  const rawBody = Buffer.from(JSON.stringify(body));
  const req = { body, rawBody, headers: { "x-paystack-signature": crypto.createHmac("sha512", "mock").update(rawBody).digest("hex") } };
  let res = response(); await webhook.paystackWebhook(req, res); assert.equal(res.code, 200); assert.equal(queued, 1);
  req.headers["x-paystack-signature"] = "invalid"; res = response(); await webhook.paystackWebhook(req, res);
  assert.equal(res.code, 401); assert.equal(queued, 1);
  for (const [label, price] of [["30 mins",30000],["1 hr",50000],["2 hrs",80000]]) assert.equal(resolveService({ id:1, packageSelected:label, calculatedPrice:1 }).price, price);
  assert.throws(() => resolveService({ id:2 }), /package or platform/);
  assert.equal(resolveService({ id:2, packageSelected:"TikTok" }).price, 20000);
  assert.equal(resolveService({ id:4, packageSelected:"TikTok and Meta" }).price, 150000);
  assert.equal(resolveService({ id:9, calculatedPrice:1 }).price, 100000);
  assert.throws(() => resolveService({ id:8 }), /available service/);
  console.log("PASS: paid-only delivery, both templates, duplicate protection, retry keys, later email, signed webhook and server prices. No real email, payment or database calls.");
})().catch(error => { console.error(error); process.exitCode = 1; });
