const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { courses, isPaidCourse } = require("../utils/courseAccess");

async function run({ status = "paid", amount = 8000, note = "Course purchase - WhatsApp: +2348000000000", email = "buyer@example.com", providerError = false, cooldown = false, payment } = {}) {
  let sent = 0;
  let released = false;
  const invoice = { _id: "test", status, amount, note, reference: "test", save: async () => {} };
  const exports = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../controllers/invoiceController.js"), "utf8"), {
    exports, process: { env: { RESEND_API_KEY: "test" } }, console,
    require: (name) => {
      if (name === "axios") return { get: async () => ({ data: { data: payment || { status: "pending" } } }) };
      if (name === "uuid") return { v4: () => "test" };
      if (name === "../utils/courseAccess") return { courses, isPaidCourse };
      if (name === "../models/Invoice") return {
        findOne: async () => invoice,
        findOneAndUpdate: async () => cooldown ? null : invoice,
        updateOne: async () => { released = true; },
      };
      if (name === "resend") return { Resend: class {
        emails = { send: async (message) => {
          sent++;
          for (const course of courses) assert.ok(message.text.includes(course.url));
          assert.equal(message.to, email.toLowerCase().trim());
          return { error: providerError ? { message: "Rejected" } : null };
        } };
      } };
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  const res = { code: 200, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
  await exports.emailCourseAccess({ params: { token: "test" }, body: { email } }, res);
  if (status === "paid" && amount === 8000 && note.startsWith("Course purchase - WhatsApp:") && email.includes("@")) {
    assert.equal(invoice.customerEmail, email.toLowerCase().trim(), "Save the email on the paid invoice, including when delivery fails");
  }
  return { code: res.code, sent, released };
}

(async () => {
  assert.equal(courses[0].url, "https://t.me/+zpLNcLN6nAhhNDY8");
  assert.equal(courses[1].url, "https://t.me/+RwLlZhhBUXk2ZDk0");
  assert.deepEqual(await run(), { code: 200, sent: 1, released: false });
  for (const options of [{ status: "pending" }, { amount: 100 }, { note: "Video script purchase" }]) {
    assert.equal((await run(options)).code, 403);
    assert.equal((await run(options)).sent, 0);
  }
  assert.equal((await run({ email: "invalid" })).code, 400);
  assert.equal((await run({ cooldown: true })).code, 429);
  assert.deepEqual(await run({ providerError: true }), { code: 500, sent: 1, released: true });
  assert.equal((await run({ status: "pending", payment: { status: "success", amount: 800000, currency: "NGN" } })).code, 200);
  for (const payment of [
    { status: "success", amount: 10000, currency: "NGN" },
    { status: "success", amount: 800000, currency: "USD" },
  ]) assert.equal((await run({ status: "pending", payment })).code, 403);
  console.log("Course access checks passed: paid-only access, both links, validation, cooldown, delivery errors, amount and currency verification.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
