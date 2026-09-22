const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const crypto = require("node:crypto");
const env = { TIKTOK_ACCESS_TOKEN: "mock-token", TIKTOK_PIXEL_ID: "D8PHSLRC77UCDHMP5VU0" };
let row, updates = [], requests = [], rejected = false;
const Invoice = {
  async updateOne(query, update) {
    updates.push({query,update});
    Object.assign(row, update.$set || {});
    for (const key of Object.keys(update.$unset || {})) delete row[key];
  },
  async findOneAndUpdate(query, update) {
    if (row.status !== "paid" || row.tiktokPurchaseSentAt || row.tiktokPurchaseClaimedAt || row.deletedAt || !row.tiktokPurchaseQueuedAt) return null;
    Object.assign(row, update.$set); return {...row};
  },
};
const moduleStub = {exports:{}};
const deps = {
  "node:crypto":crypto, "../models/Invoice":Invoice, "./courseAccess":require("../utils/courseAccess"),
  axios:{post:async (url,payload,options) => { requests.push({url,payload,options}); return {data:{code:rejected ? 40001 : 0}}; }},
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../utils/tiktokEvents.js"),"utf8"),{
  module:moduleStub,require:name => deps[name],process:{env},console,Date,
});
const api = moduleStub.exports;
const invoice = () => ({_id:"one",token:"private-course-access",product:"ads-course",amount:8000,status:"paid",paidAt:"2026-09-22T12:00:00Z",customerEmail:" BUYER@EXAMPLE.COM ",customerPhone:"+234 800 000 0000"});
(async () => {
  row=invoice();
  for (const changes of [{status:"pending"},{product:"whatsapp-course"},{deletedAt:new Date()},{amount:100}]) {
    await api.queueTikTokPurchase({...row,...changes});
  }
  assert.equal(updates.length,0);
  await api.queueTikTokPurchase(row);
  assert.ok(row.tiktokPurchaseQueuedAt);
  const results = await Promise.all([api.deliverTikTokPurchase(row._id),api.deliverTikTokPurchase(row._id)]);
  assert.ok(results.includes("sent")); assert.equal(requests.length,1);
  const {payload,options} = requests[0];
  assert.equal(options.headers["Access-Token"],"mock-token");
  assert.equal(payload.event_source_id,env.TIKTOK_PIXEL_ID);
  assert.equal(payload.data[0].event,"Purchase");
  assert.equal(payload.data[0].event_id,`course-${crypto.createHash("sha256").update(row.token).digest("hex")}`);
  assert.equal(payload.data[0].properties.value,8000);
  assert.equal(payload.data[0].event_time,Date.parse(row.paidAt)/1000);
  assert.equal(payload.data[0].user.email,crypto.createHash("sha256").update("buyer@example.com").digest("hex"));
  assert.equal(JSON.stringify(payload).includes(row.token),false);
  assert.equal(JSON.stringify(payload).includes("buyer@example.com"),false);
  assert.equal(await api.deliverTikTokPurchase(row._id),"skipped");
  row=invoice(); await api.queueTikTokPurchase(row); rejected=true;
  assert.equal(await api.deliverTikTokPurchase(row._id),"retry");
  assert.ok(row.tiktokPurchaseRetryAt); assert.equal(row.tiktokPurchaseSentAt,undefined);
  assert.equal(row.tiktokPurchaseClaimedAt,undefined);
  assert.equal(row.status,"paid");
  delete env.TIKTOK_ACCESS_TOKEN;
  assert.equal(await api.deliverTikTokPurchase(row._id),"disabled");
  console.log("TikTok purchase tests passed: paid-only queue, deduplication ID, hashed matching, concurrency, retry, disabled configuration.");
})().catch(error => {console.error(error);process.exitCode=1;});
