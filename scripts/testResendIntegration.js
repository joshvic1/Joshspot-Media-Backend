const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
function mailer(file, env, reject = false) {
  const module = { exports: {} }, calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, file),"utf8"), {
    module, process:{env}, require:(name)=>{
      assert.equal(name,"resend");
      return {Resend:class {constructor(key){assert.equal(key,"test-key");} emails={send:async(message,options)=>{
        calls.push({message,options});return reject?{error:{message:"invalid key"}}:{data:{id:"email-id"},error:null};
      }};}};
    },
  });
  return {send:module.exports,calls};
}
(async()=>{
  const env={RESEND_API_KEY:"test-key",RESEND_FROM_EMAIL:"Joshspot Media <booking@verified.example>",CLIENT_URL:"https://joshspotmedia.com"};
  const booking={_id:"booking-id",name:"Test",email:"test@example.com",date:"2026-09-20",time:"10am",serviceTitle:"Consultation",price:20000,paid:true,paymentVerifiedAt:new Date(),bookingToken:"test-token"};
  for(const file of ["../utils/sendBookingEmail.js","../utils/sendEmail.js"]){
    const test=mailer(file,env);assert.equal((await test.send(booking)).id,"email-id");
    assert.equal(test.calls[0].message.from,env.RESEND_FROM_EMAIL);assert.equal(test.calls[0].message.to,booking.email);
    assert.ok(test.calls[0].options.idempotencyKey);assert.ok(test.calls[0].message.text);
    await assert.rejects(()=>mailer(file,env,true).send(booking));
    await assert.rejects(()=>mailer(file,{}).send(booking));
  }
  const unpaid=mailer("../utils/sendEmail.js",env);await assert.rejects(()=>unpaid.send({...booking,paid:false}));assert.equal(unpaid.calls.length,0);
  console.log("Resend integration tests passed: backend key, configured sender, recipient, returned email ID, idempotency and visible provider failures; unpaid receipt blocked. No real emails sent.");
})().catch((error)=>{console.error(error);process.exitCode=1;});
