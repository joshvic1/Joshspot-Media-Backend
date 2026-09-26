const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const receipt=require('../utils/paymentReceipt');
let row,sends=[],failure=false;
const Invoice={findById:async()=>row,findOneAndUpdate:async(q,u)=>{if(row.receiptClaimedAt||row.receiptSentAt)return null;Object.assign(row,u.$set);return {...row};},updateOne:async(q,u)=>{Object.assign(row,u.$set||{});for(const k of Object.keys(u.$unset||{}))delete row[k];for(const [k,v] of Object.entries(u.$inc||{}))row[k]=(row[k]||0)+v;}};
class MockResend {
  emails = {send:async(payload,options)=>{
    sends.push({payload,options});
    return {data:{id:'mock'},error:failure?{}:null};
  }};
}
const deps={'../models/Invoice':Invoice,'node:crypto':require('node:crypto'),'../utils/paymentReceipt':receipt,resend:{Resend:MockResend}};
const context={exports:{},require:k=>deps[k],process:{env:{RESEND_API_KEY:'mock'}},Date};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../controllers/receiptController.js'),'utf8'),context);
const response=()=>({code:200,status(n){this.code=n;return this;},json(v){this.data=v;return this;}});
function reset(){row={_id:'123456789012345678901234',status:'paid',customerName:'Ada <Buyer>',customerEmail:'',amount:135000,reference:'invoice-123',paidAt:'2026-09-26T10:00:00Z',note:'Ads management'};sends=[];failure=false;}
async function send(email,name){const res=response();await context.exports.sendReceipt({params:{id:row._id},body:{email,name}},res);return res;}
(async()=>{
  reset();row.status='pending';assert.equal((await send('ada@example.com')).code,409);assert.equal(sends.length,0);
  reset();assert.equal((await send('invalid')).code,400);assert.equal(row.customerEmail,'');
  reset();assert.equal((await send('ADA@example.com')).code,200);assert.equal(row.customerEmail,'ada@example.com');assert.equal(sends[0].payload.to,'ada@example.com');assert.ok(row.receiptSentAt);assert.equal(row.receiptSendCount,1);
  assert.ok(sends[0].payload.html.includes('Ada &lt;Buyer&gt;'));assert.ok(sends[0].payload.text.includes('135,000'));assert.ok(sends[0].payload.text.includes('invoice-123'));assert.ok(!sends[0].payload.html.includes('/pay-invoice/'));
  assert.equal((await send('other@example.com')).code,429);assert.equal(sends.length,1);
  reset();row.customerEmail='saved@example.com';await send('other@example.com');assert.equal(sends[0].payload.to,'saved@example.com');
  reset();failure=true;assert.equal((await send('ada@example.com')).code,502);assert.equal(row.customerEmail,'ada@example.com');assert.equal(row.receiptClaimedAt,undefined);assert.equal(row.receiptSentAt,undefined);
  const key=sends[0].options.idempotencyKey;failure=false;await send('ada@example.com');assert.equal(sends[1].options.idempotencyKey,key);
  reset();row.deletedAt=new Date();assert.equal((await send('ada@example.com')).code,404);
  reset();row.customerName='';assert.equal((await send('ada@example.com','')).code,400);assert.equal(sends.length,0);
  assert.equal((await send('ada@example.com','  Patricia Buyer  ')).code,200);assert.equal(row.customerName,'Patricia Buyer');assert.ok(sends[0].payload.html.includes('Patricia Buyer'));
  assert.ok(!/tax/i.test(sends[0].payload.html));assert.ok(!/tax/i.test(sends[0].payload.text));
  console.log('Receipt checks passed: paid-only, saved/missing email, validation, escaping, receipt fields, repeat protection, retry idempotency, deleted invoices. No emails sent.');
})().catch(error=>{console.error(error);process.exitCode=1;});
