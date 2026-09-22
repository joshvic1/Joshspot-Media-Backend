const assert = require("node:assert/strict");
const summarize = require("../utils/sourceAnalytics");
const result = summarize([
  {attribution:{source:"tiktok",sourceLabel:"TikTok 1",browser:"chrome"},status:"paid",amount:8000},
  {attribution:{source:"tiktok",sourceLabel:"tiktok 1"},status:"failed",amount:8000},
  {attribution:{source:"tiktok",sourceLabel:"TikTok 2"},status:"paid",amount:10000},
  {attribution:{source:"direct"},status:"pending",amount:10000},
  {status:"paid",amount:8000},
]);
assert.deepEqual(result.totals,{checkouts:5,purchases:3,revenue:26000,conversion:60});
assert.equal(result.rows[0].source,"TikTok 2");
assert.deepEqual(result.rows.find(row => row.source === "TikTok 1"),{source:"TikTok 1",checkouts:2,purchases:1,revenue:8000,conversion:50});
assert.equal(result.rows.find(row => row.source === "unknown").revenue,8000);
assert.equal(result.rows.find(row => row.source === "direct").purchases,0);
assert.equal(result.rows.some(row => row.source === "chrome"),false);
assert.equal(summarize([]).totals.conversion,0);
console.log("Source analytics checks passed");
const fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
const controller = {exports:{}};
let captured;
const dependencies = {
  "../models/Invoice": {find: query => {captured=query;return {select:() => ({lean:async() => []})};}},
  resend:{}, "./invoiceController":{}, "../utils/courseAccess":{}, "../utils/sourceAnalytics":summarize,
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../controllers/courseAdminController.js"),"utf8"),{exports:controller.exports,require:key => dependencies[key]});
const response = () => ({code:200,setHeader(){},status(code){this.code=code;return this;},json(data){this.data=data;return this;}});
(async () => {
  for (const query of [{course:"invalid"},{from:"2026-02-30"},{from:"2026-09-22",to:"2026-09-01"}]) {
    const res=response();await controller.exports.sourceAnalytics({query},res);assert.equal(res.code,400);
  }
  const res=response();
  await controller.exports.sourceAnalytics({query:{course:"whatsapp-course",from:"2026-09-01",to:"2026-09-22"}},res);
  assert.equal(res.code,200);
  assert.equal(captured.$and[0].deletedAt,null);
  assert.equal(captured.$and[1].product,"whatsapp-course");
  assert.equal(captured.$and[2].createdAt.$gte.toISOString(),"2026-08-31T23:00:00.000Z");
  assert.equal(captured.$and[2].createdAt.$lte.toISOString(),"2026-09-22T22:59:59.999Z");
  console.log("Source analytics course/date validation and Lagos boundaries passed");
})().catch(error => {console.error(error);process.exitCode=1;});
