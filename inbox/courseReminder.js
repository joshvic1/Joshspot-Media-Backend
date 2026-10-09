const crypto=require('node:crypto');
const Invoice=require('../models/Invoice');
const {Contact,Conversation,Message,Template}=require('./models');
const policy=require('./policy');
const provider=require('./provider');
const reminderTemplate=require('./courseReminderTemplate');
const phoneMatch=require('./crmPhoneMatch');
const fail=message=>{throw Object.assign(new Error(message),{safe:true});};
// This automation is independent of the conversational AI engine. No model calls.
async function eligible(invoice){
 if(!invoice||invoice.deletedAt||!['ads-course','whatsapp-course'].includes(invoice.product)||invoice.status==='paid')return false;
 if(!invoice.courseWhatsappDueAt||new Date(invoice.courseWhatsappDueAt)>new Date()||new Date(invoice.createdAt)<new Date(Date.now()-86400000))return false;
 const phone=policy.phone(invoice.customerPhone);
 if(await Contact.exists({phone,$or:[{deleting:true},{whatsappReminderOptOut:true}]}))return false;
 if(await require('./deleteChat').wasDeleted(phone,Math.floor(new Date(invoice.createdAt).getTime()/1000)))return false;
 const scope={customerPhone:phoneMatch(phone),product:invoice.product,deletedAt:null};
 if(await Invoice.exists({...scope,status:'paid'}))return false;
 if(await Invoice.exists({...scope,_id:{$gt:invoice._id}}))return false;
 return true;
}
async function verifyUnpaid(invoice){
 if(!invoice.reference)return true; // Account generation failed before a payment reference existed.
 if(invoice.paymentProvider!=='flutterwave')return false; // Only new course checkouts are scheduled.
 try{const fresh=await require('../utils/flutterwaveCoursePayment').refresh(invoice,true);return fresh?.status!=='paid';}
 catch(error){
  // Flutterwave reports an unused transfer reference this way. Timeouts/auth failures are not unpaid evidence.
  if(error.response?.status===400&&/not found|no transaction/i.test(error.response?.data?.message||''))return true;
  throw Object.assign(new Error('Payment verification unavailable; reminder not sent.'),{safe:true});
 }
}
async function beforeSend(message){
 const invoice=await Invoice.findById(message.courseReminder.invoice);
 if(!await eligible(invoice))fail('Course reminder cancelled: payment or checkout eligibility changed.');
 if(!await verifyUnpaid(invoice))fail('Course reminder cancelled: payment received.');
 const fresh=await Invoice.findById(invoice._id);
 if(!await eligible(fresh))fail('Course reminder cancelled: payment or checkout eligibility changed.');
 const template=await Template.findOne({name:message.providerPayload?.name,language:message.providerPayload?.language?.code,status:'APPROVED'}).lean();
 const expected=reminderTemplate(template,fresh);
 if(JSON.stringify(expected.payload)!==JSON.stringify(message.providerPayload))fail('Course reminder cancelled: template or customer details changed.');
}
let running=false,lastRun=0;
async function tick(){
 if(running||Date.now()-lastRun<60000||!require('./workerPolicy').workerEnabled()||process.env.COURSE_WHATSAPP_REMINDERS_ENABLED==='false'||!provider.configuration().configured)return;
 running=true;lastRun=Date.now();
 try{
  const invoices=await Invoice.find({product:{$in:['ads-course','whatsapp-course']},deletedAt:null,status:{$ne:'paid'},courseWhatsappDueAt:{$lte:new Date()},courseWhatsappQueuedAt:null,createdAt:{$gte:new Date(Date.now()-86400000)}}).sort({createdAt:1}).limit(20);
  const templates=await Template.find({name:'course',status:'APPROVED'}).lean();
  const template=process.env.COURSE_WHATSAPP_TEMPLATE_LANGUAGE?templates.find(t=>t.language===process.env.COURSE_WHATSAPP_TEMPLATE_LANGUAGE):templates.length===1?templates[0]:null;
  for(const invoice of invoices){
   try{
    if(!await eligible(invoice)){await Invoice.updateOne({_id:invoice._id},{$unset:{courseWhatsappDueAt:1},$set:{courseWhatsappError:'Skipped: paid, opted out, deleted or superseded checkout.'}});continue;}
    const {payload,preview}=reminderTemplate(template,invoice);
    if(!await verifyUnpaid(invoice))continue;
    const phone=policy.phone(invoice.customerPhone);
    const contact=await require('./service').upsertContact(phone,invoice.customerName);
    if(contact.deleting||contact.whatsappReminderOptOut)continue;
    const conversation=await require('./service').openConversation(contact);
    if(conversation.deleting)continue;
    const recent=await Message.exists({conversation:conversation._id,'courseReminder.invoice':{$exists:true},createdAt:{$gte:new Date(Date.now()-86400000)}});
    const key=`course-reminder:${crypto.createHash('sha256').update(phone).digest('hex')}:${new Date().toISOString().slice(0,10)}`;
    if(!recent){
     const msg=await Message.findOneAndUpdate({clientKey:key},{$setOnInsert:{conversation:conversation._id,direction:'outbound',type:'template',status:'queued',author:'admin',authorName:'Course reminder',text:preview,providerPayload:payload,routingPhoneId:process.env.WHATSAPP_PHONE_NUMBER_ID,courseReminder:{invoice:invoice._id}}},{upsert:true,returnDocument:'after'});
     await Conversation.updateOne({_id:conversation._id,deleting:{$ne:true}},{$set:{lastMessageId:msg._id,lastMessageAt:msg.createdAt,preview:preview.slice(0,160)}});
     require('./live').notify();
    }
    await Invoice.updateOne({_id:invoice._id},{$set:{courseWhatsappQueuedAt:new Date(),courseWhatsappError:recent?'A reminder already exists within 24 hours.':''}});
   }catch(error){await Invoice.updateOne({_id:invoice._id},{$set:{courseWhatsappError:error.safe?error.message:'Reminder deferred: check approved course template and payment/provider configuration.'}});}
  }
 }finally{running=false;}
}
module.exports={tick,eligible,verifyUnpaid,beforeSend};
