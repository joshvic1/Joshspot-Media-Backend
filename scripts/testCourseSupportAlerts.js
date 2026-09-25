const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
let row,sends=[],paid=false,verifyFails=false,emailFails=false;
const Invoice={
  async findOneAndUpdate(q,u){if(row.status!=='pending'||row.supportAlertSentAt||row.supportAlertClaimedAt||row.supportAlertDueAt>q.supportAlertDueAt.$lte)return null;Object.assign(row,u.$set);return {...row};},
  async findOne(){return row.status==='pending'?row:null;},
  async updateOne(q,u){Object.assign(row,u.$set);for(const k of Object.keys(u.$unset||{}))delete row[k];},
};
const moduleStub={exports:{}};
const deps={
  '../models/Invoice':Invoice,'./courseAccess':require('../utils/courseAccess'),
  '../controllers/invoiceController':{refreshInvoiceStatus:async(i,strict)=>{assert.equal(strict,true);if(verifyFails)throw Error('offline');if(paid)row.status='paid';}},
  resend:{Resend:class{emails={send:async(payload,options)=>{sends.push({payload,options});return {data:{id:'email'},error:emailFails?{}:null};}}}},
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../utils/courseSupportAlerts.js'),'utf8'),{module:moduleStub,require:k=>deps[k],process:{env:{RESEND_API_KEY:'mock'}},Date});
const {sendSupportAlert,alertContent}=moduleStub.exports;
function reset(){row={_id:'checkout',product:'whatsapp-course',status:'pending',customerName:'Ada <Test>',customerPhone:'+2348000000000',customerEmail:'ada@example.com',createdAt:new Date(Date.now()-960000),supportAlertDueAt:new Date(Date.now()-60000)};sends=[];paid=false;verifyFails=false;emailFails=false;}
(async()=>{
  reset();await Promise.all([sendSupportAlert(row._id),sendSupportAlert(row._id)]);assert.equal(sends.length,1);assert.equal(sends[0].payload.to,'ptricia1310@gmail.com');assert.ok(row.supportAlertSentAt);
  assert.ok(sends[0].payload.html.includes('tel:+2348000000000'));assert.ok(sends[0].payload.html.includes('https://wa.me/2348000000000?text='));assert.ok(sends[0].payload.html.includes('Ada &lt;Test&gt;'));assert.ok(sends[0].payload.text.includes('WhatsApp Status ads'));assert.ok(sends[0].payload.text.includes('(Lagos)'));
  await sendSupportAlert(row._id);assert.equal(sends.length,1);
  reset();row.supportAlertDueAt=new Date(Date.now()+60000);assert.equal(await sendSupportAlert(row._id),'skipped');assert.equal(sends.length,0);
  reset();paid=true;await sendSupportAlert(row._id);assert.equal(sends.length,0);
  reset();verifyFails=true;assert.equal(await sendSupportAlert(row._id),'retry');assert.equal(sends.length,0);assert.ok(row.supportAlertRetryAt);
  reset();emailFails=true;assert.equal(await sendSupportAlert(row._id),'retry');assert.equal(row.supportAlertSentAt,undefined);assert.equal(sends[0].options.idempotencyKey,'course-support/checkout');
  reset();row.customerPhone='';assert.ok(!alertContent(row).html.includes('href="tel:'));row.product='ads-course';assert.ok(alertContent(row).text.includes('TikTok, Facebook & Instagram ads'));
  console.log('Support alert checks passed: 15-minute eligibility, one alert, concurrent workers, paid suppression, verification/email retries, recipient, contact buttons and both courses. No real emails sent.');
})().catch(e=>{console.error(e);process.exitCode=1;});
