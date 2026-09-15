const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const auth = require("../middleware/staffAuth");
const remove = require("../controllers/crmDeletionController");
const models = [require("../models/Client"), require("../models/AdsClient"), require("../models/VerificationClient")];
const response = () => ({ code: 200, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } });
(async () => {
  let calls = 0;
  models.forEach((model) => { model.findByIdAndDelete = async () => { calls++; return { _id: "507f1f77bcf86cd799439011" }; }; });
  for (const role of ["SS", "CSS", "SES", "ADMIN"]) {
    const req = { headers: { authorization: jwt.sign({ staffId: "staff", role }, process.env.JWT_SECRET || "joshspotsecret") }, params: { kind: "clients", id: "507f1f77bcf86cd799439011" } };
    auth(req, response(), () => {});
    const res = response(); await remove(req, res); assert.equal(res.code, 403);
  }
  assert.equal(calls, 0);
  for (const kind of ["clients", "ads-clients", "verification-clients"]) {
    const req = { headers: { authorization: jwt.sign({ admin: true }, process.env.JWT_SECRET || "joshspotsecret") }, params: { kind, id: "507f1f77bcf86cd799439011" } };
    auth(req, response(), () => {});
    assert.equal(req.staff.admin, true);
    const res = response(); await remove(req, res); assert.equal(res.code, 200);
    req.params.id = "invalid"; const invalid = response(); await remove(req, invalid); assert.equal(invalid.code, 400);
  }
  assert.equal(calls, 3);
  const rejected = response(); auth({ headers: { authorization: "fake" } }, rejected, () => assert.fail("Invalid token accepted")); assert.equal(rejected.code, 401);
  console.log("CRM deletion authorization checks passed (mocked database).");
})().catch((error) => { console.error(error); process.exitCode = 1; });
