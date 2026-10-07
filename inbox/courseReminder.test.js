const {test}=require('node:test'),assert=require('node:assert/strict');
const r=require('./courseReminder'),flw=require('../utils/flutterwaveCoursePayment'),policy=require('./policy');
test('reminders fail closed on verification errors and respect confirmed payment',async()=>{
 const original=flw.refresh;try{
  flw.refresh=async()=>({status:'paid'});assert.equal(await r.verifyUnpaid({reference:'x',paymentProvider:'flutterwave'}),false);
  flw.refresh=async()=>{throw Error('timeout')};await assert.rejects(r.verifyUnpaid({reference:'x',paymentProvider:'flutterwave'}),/verification unavailable/);
  flw.refresh=async()=>{throw {response:{status:400,data:{message:'No transaction found'}}}};assert.equal(await r.verifyUnpaid({reference:'x',paymentProvider:'flutterwave'}),true);
 }finally{flw.refresh=original;}
});
test('static approved buttons need no invented parameters; dynamic and call components remain unsupported',()=>{
 const t={name:'course',language:'en',status:'APPROVED',components:[{type:'BODY',text:'Get the course'},{type:'BUTTONS',buttons:[{type:'URL',text:'Buy',url:'https://joshspotmedia.com/course'}]}]};
 assert.deepEqual(policy.templatePayload(t,{}).payload.components,[]);
 t.components[1].buttons[0].url+='{{1}}';assert.equal(policy.templateFields(t),null);
 assert.equal(policy.templateFields({components:[{type:'CALL_PERMISSION_REQUEST'}]}),null);
});
