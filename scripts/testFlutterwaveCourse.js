const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const {MongoMemoryServer} = require('mongodb-memory-server');
const axios = require('axios');
// No dotenv: this test can only use its disposable database and stubbed providers.
process.env.FLUTTERWAVE_SECRET_KEY='test-key';
process.env.FLUTTERWAVE_WEBHOOK_SECRET='test-hash';
for(const file of ['../utils/tiktokEvents','../utils/deliverCourseEmail']) {
  require.cache[require.resolve(file)]={exports:{queueTikTokPurchase:async()=>{},queueCourseEmail:async()=>{},canEmailCourse:()=>false,deliverCourseEmail:async()=>{}}};
}
const Invoice=require('../models/Invoice');
const flw=require('../utils/flutterwaveCoursePayment');
const controller=require('../controllers/invoiceController');
let posts=0, gets=0, verified;
axios.post=async(url,body)=>{posts++;assert.ok(url.includes('flutterwave.com'));assert.equal(body.is_permanent,false);return {data:{status:'success',data:{account_number:'1234567890',bank_name:'Test bank',note:'Please make a bank transfer to Test Course',amount:body.amount+100,expiry_date:new Date(Date.now()+3600000).toISOString(),order_ref:'order'}}};};
axios.get=async(url)=>{gets++;assert.ok(url.includes('flutterwave.com'));return {data:{data:verified}};};
const response=()=>({code:200,status(n){this.code=n;return this},json(x){this.body=x;return this},sendStatus(n){this.code=n;return this}});
(async()=>{
 const mongo=await MongoMemoryServer.create();
 try {
  await mongoose.connect(mongo.getUri());
  for(const product of ['ads-course','whatsapp-course']) {
   const res=response();
   await controller.createInvoice({body:{product,customerName:'Test Buyer',customerPhone:'+2348000000000',amount:1},headers:{},get:()=>''},res);
   assert.equal(res.code,201,JSON.stringify(res.body));
   const i=await Invoice.findOne({token:res.body.invoice.token});
   assert.equal(i.paymentProvider,'flutterwave');assert.equal(i.amount,product==='ads-course'?8000:10000);assert.equal(i.transferAmount,i.amount+100);assert.equal(i.status,'pending');
  }
  let i=await Invoice.findOne({product:'ads-course'});const priorPosts=posts;
  verified={id:1,status:'pending',tx_ref:i.reference,currency:'NGN',amount:i.amount};
  await flw.generate(i);assert.equal(posts,priorPosts,'Account reused');
  for(const bad of [{tx_ref:'wrong'},{currency:'USD'},{amount:1}]) {
   verified={id:1,status:'successful',tx_ref:i.reference,currency:'NGN',amount:i.amount,...bad};
   await assert.rejects(()=>flw.refresh(i,true),/do not match/);
   assert.notEqual((await Invoice.findById(i._id)).status,'paid');
  }
  let res=response();await flw.webhook({headers:{'verif-hash':'wrong'},body:{}},res);assert.equal(res.code,401);
  res=response();await flw.webhook({headers:{'verif-hash':'test-hash'},body:{event:'charge.completed',data:{}}},res);assert.equal(res.code,400);
  verified={id:123,status:'successful',tx_ref:i.reference,currency:'NGN',amount:i.amount};
  for(let n=0;n<2;n++){res=response();await flw.webhook({headers:{'verif-hash':'test-hash'},body:{event:'charge.completed',data:{tx_ref:i.reference}}},res);assert.equal(res.code,200);}
  assert.equal((await Invoice.findById(i._id)).status,'paid');
  const fresh=await Invoice.create({token:'race',amount:8000,paymentProvider:'flutterwave',customerName:'Test'});
  const before=posts;const race=await Promise.allSettled([flw.generate(fresh),flw.generate(fresh)]);assert.equal(posts,before+1);assert.equal(race.filter(x=>x.status==='fulfilled').length,1);
  axios.post=async()=>{posts++;throw new Error('timeout')};
  const timed=await Invoice.create({token:'timeout',amount:8000,paymentProvider:'flutterwave'});
  await assert.rejects(()=>flw.generate(timed),/timeout/);const count=posts;
  await assert.rejects(()=>flw.generate(timed),/needs review/);assert.equal(posts,count);
  const legacy=await Invoice.create({token:'legacy',amount:8000,reference:'old',status:'pending'});
  axios.get=async(url)=>{assert.ok(url.startsWith('https://api.paystack.co/'));return {data:{data:{status:'pending'}}}};
  await controller.refreshInvoiceStatus(legacy,true);
  axios.post=async(url,body)=>{assert.ok(url.startsWith('https://api.paystack.co/'));assert.equal(body.amount,2500000);return {data:{data:{status:'pending',account_number:'legacy-account'}}}};
  const normal=response();await controller.createInvoice({body:{amount:25000,customerName:'Normal invoice'},headers:{}},normal);assert.equal(normal.code,201);assert.equal((await Invoice.findOne({token:normal.body.invoice.token})).paymentProvider,'paystack');
  console.log('PASS: course routing, amount/expiry, account reuse, verification, authenticated webhook, duplicate webhook, concurrent generation, ambiguous timeout and legacy Paystack');
 }finally{await mongoose.disconnect();await mongo.stop()}
})().catch(e=>{console.error(e);process.exitCode=1});

