const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
async function run({provider='flutterwave',error,status='pending',freshStatus='pending',action='remindCoursePayment',emailError=false}={}){
 let sent=0;const invoice={_id:'test',product:'ads-course',paymentProvider:provider,status:'pending',customerEmail:'buyer@example.test',customerPhone:'+2348000000000'};
 const exports={};vm.runInNewContext(fs.readFileSync(require.resolve('../controllers/courseAdminController'),'utf8'),{exports,process:{env:{RESEND_API_KEY:'mock'}},require:name=>({
 '../models/Invoice':{findById:async()=>({...invoice,status:freshStatus}),exists:async()=>false,findOneAndUpdate:async()=>({...invoice,reminderClaimedAt:new Date()}),updateOne:async()=>({})},
 '../utils/courseAccess':{isCourse:()=>true},
 './invoiceController':{refreshInvoiceStatus:async()=>{if(error)throw error;return {...invoice,status};}},
 resend:{Resend:class{emails={send:async()=>{sent++;return {data:{id:'mock'},error:emailError?{}:null};}}}}
 }[name])});
 const res={code:200,status(n){this.code=n;return this;},json(body){this.body=body;return this;}};await exports[action]({params:{id:'test'}},res);return {...res,sent};
}
const missing={response:{status:400,data:{message:'No transaction was found for this reference'}}};
test('unused Flutterwave reference permits manual unpaid reminder',async()=>{const r=await run({error:missing});assert.equal(r.code,200);assert.equal(r.sent,1);});
test('returned paid document blocks email and is shown by payment check',async()=>{assert.equal((await run({status:'paid'})).code,409);const r=await run({status:'paid',action:'checkCoursePayment'});assert.equal(r.body.record.status,'paid');});
test('payment webhook winning during missing-transaction check prevents reminder',async()=>{const r=await run({error:missing,freshStatus:'paid'});assert.equal(r.code,409);assert.equal(r.sent,0);});
test('provider outages auth errors and Paystack errors never become unpaid evidence',async()=>{for(const options of [{error:Error('timeout')},{error:{response:{status:401,data:{message:'not found'}}}},{error:missing,provider:'paystack'}]){const r=await run(options);assert.equal(r.code,502);assert.equal(r.sent,0);}});
test('email failure is distinguished from verification failure',async()=>{const r=await run({emailError:true});assert.equal(r.code,502);assert.match(r.body.message,/Payment checked/);});
