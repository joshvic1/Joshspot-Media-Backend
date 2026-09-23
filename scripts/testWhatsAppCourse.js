const assert=require('node:assert/strict');
const Invoice=require('../models/Invoice');const axios=require('axios');
const c=require('../controllers/invoiceController');
let saved;
Invoice.create=async data=>saved={...data,_id:'test',status:'draft',save:async()=>{}};
axios.post=async(url,payload)=>{assert.equal(payload.amount,1000000);return {data:{data:{reference:'test-ref',account_number:'123',status:'pending'}}}};
axios.get=async()=>({data:{data:{status:'pending'}}});
const res=()=>({code:200,status(n){this.code=n;return this},json(v){this.data=v;return this}});
(async()=>{
let r=res();await c.createInvoice({body:{product:'whatsapp-course',amount:1,customerName:'Test',customerPhone:'+2348000000000',note:'Course purchase - WhatsApp: +2348000000000'},headers:{}},r);assert.equal(r.code,201);assert.equal(saved.amount,10000);assert.equal(saved.product,'whatsapp-course');assert.equal(r.data.invoice.contactUrl,undefined);
Invoice.findOne=async()=>({...saved,status:'paid',amount:10000});r=res();await c.getInvoice({params:{token:saved.token}},r);assert.equal(r.data.contactUrl,'https://t.me/+LimBMFUxVvphZTU0');assert.equal(r.data.courses,undefined);
console.log('WhatsApp price enforcement and paid access checks passed; no real payment created.');
})().catch(e=>{console.error(e);process.exitCode=1});
