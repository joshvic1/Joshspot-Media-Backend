const assert = require("node:assert/strict");
const Invoice = require("../models/Invoice");
const controller = require("../controllers/invoiceController");
let delivered = 0, current;
Invoice.findById = async () => current;
controller.emailCourseAccess = async (req, res) => {
  assert.equal(req.params.token, "private-token");
  assert.equal(req.body.email, "buyer@example.com");
  delivered++; return res.json({ message: "sent" });
};
const { resendCourseEmail } = require("../controllers/courseAdminController");
const response = () => ({ code: 200, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } });
(async () => {
  const base = { product: "ads-course", status: "paid", token: "private-token", customerEmail: "buyer@example.com" };
  for (const [invoice, expected] of [[null,404],[{...base,status:"pending"},403],[{...base,deletedAt:new Date()},404],[{...base,product:"other"},404],[{...base,customerEmail:""},400],[base,200]]) {
    current = invoice; const res = response();
    await resendCourseEmail({params:{id:"record"}},res);
    assert.equal(res.code,expected);
  }
  assert.equal(delivered,1);
  console.log("Paid course resend checks passed; no real email sent.");
})().catch(error => { console.error(error); process.exitCode = 1; });
