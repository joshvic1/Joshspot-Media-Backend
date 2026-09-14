const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const access = require("../utils/courseAccess");
const response = () => ({ code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; }, sendStatus(code) { this.code = code; return this; } });
const load = (file, dependencies, env = { RESEND_API_KEY: "test", PAYSTACK_SECRET: "test-secret" }) => {
  const exports = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, file), "utf8"), {
    exports, Buffer, console: { log() {} }, process: { env }, require: (name) => {
      if (name in dependencies) return dependencies[name];
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  return exports;
};
const base = { _id: "1", product: "ads-course", customerName: "Test Buyer", customerPhone: "+2348000000000", customerEmail: "test@example.com", amount: 8000, note: "", status: "pending", createdAt: new Date(Date.now() - 3600000) };

async function reminders(options = {}) {
  let sent = 0, released = false, saved = false;
  const invoice = { ...base, ...options.invoice };
  const admin = load("../controllers/courseAdminController.js", {
    "../models/Invoice": {
      findById: async () => invoice,
      exists: async () => options.otherPaid,
      findOneAndUpdate: async () => options.cooldown ? null : { ...invoice, reminderClaimedAt: new Date() },
      updateOne: async (query, update) => { if (update.$inc) saved = true; else released = true; },
    },
    "../utils/courseAccess": access,
    "./invoiceController": { refreshInvoiceStatus: async (record, strict) => {
      assert.equal(strict, true);
      if (options.verificationError) throw new Error("Paystack unavailable");
      if (options.justPaid) record.status = "paid";
    } },
    resend: { Resend: class { emails = { send: async (message) => {
      sent++; assert.equal(message.to, "test@example.com");
      assert.ok(message.text.includes("https://joshspotmedia.com/course"));
      assert.ok(!message.text.includes("t.me"));
      return { error: options.providerError ? {} : null };
    } }; } },
  });
  const res = response();
  await admin.remindCoursePayment({ params: { id: "1" } }, res);
  return { code: res.code, sent, saved, released };
}

async function webhook({ amount = 800000, currency = "NGN", signatureValid = true } = {}) {
  let updates = 0;
  const controller = load("../controllers/paymentWebhookController.js", {
    "node:crypto": crypto,
    "../models/Invoice": { findOne: async () => base, updateOne: async (query, update) => { assert.equal(update.$set.status, "paid"); updates++; } },
  });
  const body = { event: "charge.success", data: { status: "success", reference: "test", amount, currency } };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = crypto.createHmac("sha512", "test-secret").update(rawBody).digest("hex");
  const res = response();
  await controller.paystackWebhook({ body, rawBody, headers: { "x-paystack-signature": signatureValid ? signature : "invalid" } }, res);
  return { code: res.code, updates };
}

async function createCheckout(fail = false) {
  let saved;
  const controller = load("../controllers/invoiceController.js", {
    axios: { post: async () => {
      assert.ok(saved.reference, "Save the reference before contacting Paystack");
      if (fail) throw new Error("Network failure");
      return { data: { data: { reference: saved.reference, status: "pending", account_number: "1234567890" } } };
    } },
    uuid: { v4: () => "test-reference" }, resend: {}, "../utils/courseAccess": access,
    "../models/Invoice": { create: async (fields) => {
      saved = { ...fields, status: "draft", save: async () => {} }; return saved;
    } },
  });
  const res = response();
  await controller.createInvoice({ body: {
    product: "ads-course", amount: 100, customerName: " Test Buyer ", customerPhone: "+2348000000000",
    customerEmail: "TEST@example.com", note: "Course purchase - WhatsApp: +2348000000000",
  }, headers: {} }, res);
  assert.equal(saved.amount, 8000); assert.equal(saved.customerName, "Test Buyer");
  assert.equal(saved.customerPhone, "+2348000000000"); assert.equal(saved.customerEmail, "test@example.com");
  assert.equal(saved.product, "ads-course");
  assert.equal(res.code, fail ? 500 : 201);
  assert.equal(saved.status, fail ? "failed" : "pending");
}

(async () => {
  const records = [
    { ...base, status: "paid" }, { ...base, _id: "2", status: "pending", createdAt: new Date() },
    { ...base, _id: "3" }, { ...base, _id: "4", status: "failed" },
    { ...base, _id: "5", product: "", customerPhone: "", customerEmail: "", note: "Course purchase - WhatsApp: +2348123456789", status: "expired" },
  ];
  const admin = load("../controllers/courseAdminController.js", {
    "../models/Invoice": { find: () => ({ sort: () => ({ lean: async () => records }) }) },
    resend: {}, "./invoiceController": {}, "../utils/courseAccess": access,
  });
  let res = response();
  await admin.listCoursePayments({ query: { status: "abandoned" } }, res);
  assert.equal(res.code, 200); assert.equal(res.data.total, 2);
  assert.equal(res.data.summary.paid, 1); assert.equal(res.data.summary.revenue, 8000);
  assert.equal(res.data.summary.pending, 1); assert.equal(res.data.summary.failed, 1);
  assert.equal(res.data.records[1].phone, "+2348123456789"); assert.equal(res.data.records[1].email, "");
  res = response();
  await admin.listCoursePayments({ query: { search: "8123456789", page: "999" } }, res);
  assert.equal(res.data.total, 1); assert.equal(res.data.page, 1);
  for (const [options, expected] of [
    [{ invoice: { status: "paid" } }, 409], [{ justPaid: true }, 409], [{ otherPaid: true }, 409],
    [{ invoice: { customerEmail: "" } }, 400], [{ cooldown: true }, 429], [{ verificationError: true }, 502],
  ]) { const result = await reminders(options); assert.equal(result.code, expected); assert.equal(result.sent, 0); }
  assert.deepEqual(await reminders(), { code: 200, sent: 1, saved: true, released: false });
  assert.deepEqual(await reminders({ providerError: true }), { code: 502, sent: 1, saved: false, released: true });
  assert.deepEqual(await webhook(), { code: 200, updates: 1 });
  assert.deepEqual(await webhook({ signatureValid: false }), { code: 401, updates: 0 });
  assert.equal((await webhook({ amount: 100 })).updates, 0);
  assert.equal((await webhook({ currency: "USD" })).updates, 0);
  await createCheckout();
  await createCheckout(true);

  const adminAuth = require("../middleware/adminAuth");
  for (const authorization of [undefined, "invalid-token"]) {
    const authRes = response(); let allowed = false;
    adminAuth({ headers: { authorization } }, authRes, () => { allowed = true; });
    assert.equal(authRes.code, 401); assert.equal(allowed, false);
  }
  const Invoice = require("../models/Invoice");
  const document = new Invoice({ ...base, _id: undefined, token: "test" });
  assert.equal(document.validateSync(), undefined);
  assert.equal(document.customerEmail, "test@example.com");
  assert.equal(document.customerPhone, "+2348000000000");
  assert.equal(document.product, "ads-course");
  console.log("Course CRM checks passed: filters, counts, legacy contacts, blank emails, auth, reminder safeguards, provider failures, webhook signature/amount/currency and model contact fields.");
})().catch((error) => { console.error(error); process.exitCode = 1; });
