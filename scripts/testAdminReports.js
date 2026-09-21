const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const load = (file, dependencies) => {
  const exports = {};
  const module = { exports };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, file), "utf8"), {
    exports, module, console, Buffer, process:{env:{PAYSTACK_SECRET:"test"}}, require:(name) => {
      if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`);
      return dependencies[name];
    },
  }); return module.exports;
};
const res = () => ({ code:200, setHeader(){}, status(code){this.code=code;return this;}, json(data){this.data=data;return this;}, sendStatus(code){this.code=code;return this;} });
const paidDate = new Date("2026-09-14T23:30:00Z");
const bookings = [
  {_id:"b1",name:"Paid buyer",paid:true,paymentVerifiedAt:paidDate,paidAt:paidDate,price:20000,paymentReference:"booking-1",serviceTitle:"Consultation",createdAt:paidDate},
  {_id:"b2",name:"Legacy",paid:true,price:50000,serviceTitle:"Consultation",createdAt:paidDate},
  {_id:"b3",name:"Unpaid",paid:false,price:10000,createdAt:paidDate},
];
const invoices = [
  {_id:"i1",status:"paid",amount:8000,product:"ads-course",reference:"course-1",paidAt:paidDate},
  {_id:"i2",status:"paid",amount:20000,reference:"booking-1",paidAt:paidDate},
  {_id:"i3",status:"paid",amount:15000,note:"Video script purchase",reference:"script-1",paidAt:paidDate},
];
let deleted = false;
const invoiceModel = {find:(query) => { assert.equal(query.deletedAt,null);assert.equal(query.status,"paid");return {lean:async()=>invoices,sort:()=>({lean:async()=>invoices})};},findByIdAndUpdate:async(id,update)=>{deleted=!!update.$set?.deletedAt;return {_id:id};}};
const reports = load("../controllers/adminReportsController.js", {
  "../models/Booking":{find:(query)=>{assert.equal(query.deletedAt,null);return {lean:async()=>bookings};}},
  "../models/Invoice":invoiceModel, "../models/GrowthAssessment":{find:()=>({lean:async()=>[{score:80,createdAt:paidDate}]})},
  "../utils/courseAccess":require("../utils/courseAccess"), "../utils/bookingPayment":{}, "./invoiceController":{},
});
async function verifyPayment(transaction, callback = false) {
  const helper = load("../utils/bookingPayment.js", {axios:{get:async()=>({data:{data:transaction}})}});
  let saves = 0;
  const booking = {_id:"booking-id",price:8000,paid:false,paymentReference:callback?undefined:"test-ref",save:async()=>{saves++;}};
  await helper.refreshBookingPayment(booking, callback?"test-ref":undefined);
  return {booking,saves,helper};
}
(async()=>{
  let response = res(); await reports.overview({query:{}},response);
  assert.equal(response.data.revenue,43000,"Combine verified bookings and invoices without counting a shared reference twice");
  assert.equal(response.data.bookingRevenue,20000);assert.equal(response.data.invoiceRevenue,23000);assert.equal(response.data.courseRevenue,8000);
  assert.equal(response.data.unverifiedBookings,1);assert.equal(response.data.payments,3);
  response=res();await reports.overview({query:{service:"Ads course"}},response);assert.equal(response.data.revenue,8000);
  response=res();await reports.overview({query:{from:"2026-09-14",to:"2026-09-14"}},response);assert.equal(response.data.revenue,0,"Date filter uses Lagos day boundaries");
  response=res();await reports.overview({query:{from:"2026-09-15",to:"2026-09-15"}},response);assert.equal(response.data.revenue,43000);
  response=res();await reports.paidInvoices({query:{min:"10000"}},response);assert.equal(response.data.total,2);assert.equal(response.data.revenue,35000);
  response=res();await reports.paidInvoices({query:{from:"2026-10-01",to:"2026-09-01"}},response);assert.equal(response.code,400);
  assert.equal(reports.paginate(Array.from({length:25},(_,i)=>i),{page:3,pageSize:10}).records.length,5);
  response=res();await reports.deleteRecord({params:{kind:"invoices",id:"a".repeat(24)},method:"DELETE"},response);assert.equal(deleted,true);
  response=res();await reports.deleteRecord({params:{kind:"invoices",id:"a".repeat(24)},method:"POST"},response);assert.equal(deleted,false);
  const success={status:"success",amount:800000,currency:"NGN",reference:"test-ref",paid_at:paidDate.toISOString()};
  assert.equal((await verifyPayment(success)).booking.paid,true);
  for (const change of [{amount:1},{currency:"USD"},{reference:"other"},{status:"pending"}]) assert.equal((await verifyPayment({...success,...change})).booking.paid,false);
  assert.equal((await verifyPayment({...success,metadata:{bookingId:"someone-else"}},true)).booking.paid,false);
  assert.equal((await verifyPayment({...success,metadata:{bookingId:"booking-id"}},true)).booking.paid,true);
  let webhookPaid=false;
  invoices.push({_id:"whatsapp",status:"paid",amount:10000,product:"whatsapp-course",reference:"whatsapp-1",paidAt:paidDate});
  response=res();await reports.overview({query:{service:"WhatsApp Status ads course"}},response);assert.equal(response.data.revenue,10000);
  invoices.pop();
  const webhook=load("../controllers/paymentWebhookController.js",{
    "../utils/deliverCourseEmail":{queueCourseEmail:async()=>{}},
    "node:crypto":crypto,"../models/Invoice":{findOne:async()=>null},
    "../models/Booking":{findOne:async()=>({price:8000,paymentReference:"test-ref"}),updateOne:async(query,update)=>{webhookPaid=update.$set.paid;}},
    "../utils/bookingPayment":(await verifyPayment(success)).helper,
  });
  const body={event:"charge.success",data:success},rawBody=Buffer.from(JSON.stringify(body));
  await webhook.paystackWebhook({body,rawBody,headers:{"x-paystack-signature":crypto.createHmac("sha512","test").update(rawBody).digest("hex")}},res());assert.equal(webhookPaid,true);
  const controller=load("../controllers/bookingController.js",{
    "../models/Booking":{findOne:async()=>({paid:false})},"../utils/sendBookingEmail":async()=>{throw new Error("Must not email unpaid bookings");},
    "../utils/bookingPayment":{refreshBookingPayment:async()=>{}},
  });
  response=res();await controller.completeBooking({body:{token:"test",date:"2027-01-01",time:"10am"}},response);assert.equal(response.code,402);
  console.log("Admin report tests passed: combined revenue, no duplicate references, paid-only invoices, Lagos dates, filters, pagination, deletion/undo, automatic Paystack booking verification, signed webhook, and unpaid booking rejection.");
})().catch((error)=>{console.error(error);process.exitCode=1;});
