const test = require("node:test");
const assert = require("node:assert/strict");
const { _private } = require("./refundController");
const { isFullyRefunded, isPaidCourse } = require("../utils/courseAccess");

test("refund provider statuses only mark explicit final states as processed", () => {
  assert.equal(_private.normalizeProviderStatus("paystack", "processed"), "processed");
  assert.equal(_private.normalizeProviderStatus("paystack", "needs_attention"), "needs_attention");
  assert.equal(_private.normalizeProviderStatus("flutterwave", "completed"), "processing");
  assert.equal(_private.normalizeProviderStatus("flutterwave", "completed-bank-transfer"), "processed");
  assert.equal(_private.normalizeProviderStatus("flutterwave", "failed"), "failed");
});

test("refund matching uses a normalized customer number and never a name", () => {
  assert.equal(_private.normalizedInvoicePhone({ customerPhone: "0803 123 4567" }), "2348031234567");
  assert.equal(_private.normalizedInvoicePhone({ note: "Manual invoice\nWhatsApp: +234 803 123 4567" }), "2348031234567");
  assert.equal(_private.normalizedInvoicePhone({ customerPhone: "not a number" }), "");
});

test("a full refund removes paid-course eligibility but a partial refund does not", () => {
  const course = { status: "paid", product: "ads-course", amount: 8000, note: "Course purchase" };
  assert.equal(isFullyRefunded({ ...course, refundedAmount: 7999 }), false);
  assert.equal(isPaidCourse({ ...course, refundedAmount: 7999 }), true);
  assert.equal(isFullyRefunded({ ...course, refundedAmount: 8000 }), true);
  assert.equal(isPaidCourse({ ...course, refundedAmount: 8000 }), false);
});
