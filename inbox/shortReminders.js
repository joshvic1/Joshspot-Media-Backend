const mongoose=require('mongoose');
const {Conversation,Contact,Message}=require('./models');
const Invoice=require('../models/Invoice');
const policy=require('./policy');
const schema=new mongoose.Schema({key:{type:String,unique:true},conversation:mongoose.Schema.Types.ObjectId,source:mongoose.Schema.Types.ObjectId,invoice:mongoose.Schema.Types.ObjectId,product:String,kind:String,dueAt:Date,inputId:mongoose.Schema.Types.ObjectId,state:{type:String,default:'pending'},reason:String},{timestamps:true});
schema.index({state:1,dueAt:1});
const Job=mongoose.model('InboxShortReminder',schema);
function links(text){return [...String(text||'').matchAll(/https?:\/\/[^\s<>]+/g)].map(m=>{try{return new URL(m[0].replace(/[).,!?]+$/,''));}catch{return null;}}).filter(u=>u&&['joshspotmedia.com','www.joshspotmedia.com'].includes(u.hostname));}
async function schedule(message){
 if(!message.sentAt||message.shortReminder||message.automation?.followup||message.courseReminder?.invoice||!['sent','delivered','read'].includes(message.status))return;
 const c=await Conversation.findById(message.conversation);if(!c||c.deleting)return;
 const urls=links(message.text);const invoices=[];
 if(message.invoiceDelivery)invoices.push(message.invoiceDelivery);
 for(const url of urls.filter(u=>u.pathname.startsWith('/pay-invoice/'))){const row=await Invoice.findOne({token:url.pathname.split('/')[2],deletedAt:null}).select('_id');if(row)invoices.push(row._id);}
 for(const invoice of [...new Set(invoices.map(String))])await Job.updateOne({key:`invoice:${invoice}`},{$setOnInsert:{conversation:c._id,source:message._id,invoice,kind:'invoice',inputId:c.lastInboundId,dueAt:new Date(+new Date(message.sentAt)+3600000)}},{upsert:true});
 for(const product of [...new Set(urls.map(u=>u.pathname.replace(/\/$/,'')).map(p=>p==='/course'?'ads-course':p==='/whatsapp'?'whatsapp-course':null).filter(Boolean))])await Job.updateOne({key:`course:${c._id}:${product}:${new Date(message.sentAt).toISOString().slice(0,10)}`},{$setOnInsert:{conversation:c._id,source:message._id,product,kind:'course',inputId:c.lastInboundId,dueAt:new Date(+new Date(message.sentAt)+1800000)}},{upsert:true});
}
async function check(job){
 const c=await Conversation.findById(job.conversation).populate('contact');
 if(!c||c.deleting||c.status==='resolved'||!c.contact||c.contact.deleting||c.contact.whatsappReminderOptOut||!policy.windowOpen(c.lastInboundAt)||String(c.lastInboundId)!==String(job.inputId))return false;
 if(!await Message.exists({_id:job.source,status:{$in:['sent','delivered','read']}}))return false;
 if(job.kind==='invoice'){
  if(!(await require('./ai/config').getConfig()).data.followupsEnabled)return false;
  const latest=await require('./latestInvoice')(c);if(String(latest?._id)!==String(job.invoice)||latest.status==='paid'||latest.deletedAt)return false;
  const fresh=await require('../controllers/invoiceController').refreshInvoiceStatus(latest,true);if(fresh.status==='paid')return false;
 }else{
  const rows=await Invoice.find({customerPhone:require('./crmPhoneMatch')(c.contact.phone),product:job.product,deletedAt:null}).sort({createdAt:-1}).limit(10);
  if(await Invoice.exists({customerPhone:require('./crmPhoneMatch')(c.contact.phone),product:job.product,deletedAt:null,status:'paid'}))return false;
  // Once checkout starts, the existing unpaid-checkout reminder takes over.
  if(rows.some(row=>+new Date(row.createdAt)>=+new Date(job.createdAt)-1800000))return false;
 }
 return c;
}
async function beforeSend(message){const job=await Job.findById(message.shortReminder);if(!job||!['pending','queued'].includes(job.state)||!await check(job))throw Object.assign(new Error('Reminder cancelled: payment, customer reply or messaging window changed.'),{safe:true});}
let busy=false,last=0;
async function tick(){
 if(busy||Date.now()-last<60000||!require('./workerPolicy').workerEnabled())return;busy=true;last=Date.now();
 try{for(const job of await Job.find({state:'pending',dueAt:{$lte:new Date()}}).sort({dueAt:1}).limit(20)){
  try{const c=await check(job);if(!c){await Job.updateOne({_id:job._id},{$set:{state:'cancelled',reason:'No longer eligible'}});continue;}
   let text=job.kind==='course'?`Hi ${c.contact.name||'there'}, have you gotten the ${job.product==='whatsapp-course'?'WhatsApp':'TikTok + Facebook + Instagram'} course yet? Are you having any difficulty getting it? Let us know so we can help.`:'';
   if(job.kind==='invoice'){try{text=(await require('./ai/manualReminderTemplate')(c)).preview;}catch{text='Hi, your invoice is still awaiting payment.';}text+='\n\nAre you having any difficulty making the payment? Please let us know so we can help.';}
   await Message.updateOne({clientKey:`short-reminder:${job._id}`},{$setOnInsert:{conversation:c._id,direction:'outbound',type:'text',status:'queued',text,author:'admin',authorName:'Payment reminder',shortReminder:job._id,routingPhoneId:process.env.WHATSAPP_PHONE_NUMBER_ID}},{upsert:true});
   await Job.updateOne({_id:job._id},{$set:{state:'queued'}});
  }catch{await Job.updateOne({_id:job._id},{$set:{reason:'Verification unavailable; retrying safely'}});}
 }}finally{busy=false;}
}
module.exports={Job,links,schedule,check,beforeSend,tick};

