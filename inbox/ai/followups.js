const {randomUUID}=require('node:crypto');
const {Followup,Record,Log}=require('./models');
const {Conversation,Message}=require('../models');
const Invoice=require('../../models/Invoice');
const policy=require('../policy');

async function schedule(conversation,invoiceId,config){
  if(!config.structuredSales||!config.followupsEnabled)return;
  const invoice=await Invoice.findOne({_id:invoiceId,inboxConversation:conversation._id,status:'pending'}).lean();
  if(!invoice)return;
  for(let i=0;i<config.followupMaximum;i++) {
    const hours=i===0?config.followupFirstHours:config.followupSecondHours;
    await Followup.updateOne({conversation:conversation._id,invoice:invoice._id,sequence:i},{$setOnInsert:{phoneId:conversation.ai.phoneId,state:'pending',dueAt:new Date(Date.now()+hours*3600000),inputId:conversation.lastInboundId,version:conversation.ai.version}},{upsert:true});
  }
}
async function cancel(conversation,reason){await Followup.updateMany({conversation,state:{$in:['pending','processing']}},{$set:{state:'cancelled',reason}});}
async function eligibility(job,config){
  const c=await Conversation.findOne({_id:job.conversation,'ai.phoneId':process.env.WHATSAPP_PHONE_NUMBER_ID,'ai.active':{$ne:false},'ai.version':job.version,assignedTo:null,status:{$ne:'resolved'},deleting:{$ne:true},lastInboundId:job.inputId}).lean();
  if(!c||c.ai?.state?.salesPaused||c.ai?.state?.paymentStatus==='claimed'||String(c.ai?.state?.invoiceId)!==String(job.invoice))return {reason:'Conversation changed or is human-owned'};
  const invoice=await Invoice.findOne({_id:job.invoice,inboxConversation:c._id,status:'pending',deletedAt:null,expiresAt:{$gt:new Date()}}).lean();
  if(!invoice)return {reason:'Invoice is paid, expired or no longer pending'};
  const delivered=await Message.exists({conversation:c._id,clientKey:`ai:${c._id}:${job.inputId}`,status:{$in:['sent','delivered','read']}});
  if(!delivered)return {reason:'Invoice message has not been successfully sent'};
  if(!config.enabled||config.mode!=='LIVE'||!config.autoReply||!config.structuredSales||!config.followupsEnabled)return {reason:'Automatic follow-ups are disabled'};
  if(!policy.windowOpen(c.lastInboundAt))return {reason:'WhatsApp window closed; no approved reminder template configured'};
  return {conversation:c,invoice};
}
async function tick(configRow){
  const config=configRow.data;
  if(!config.structuredSales||!config.followupsEnabled||config.mode!=='LIVE'||!config.enabled||!config.autoReply)return;
  for(let i=0;i<3;i++){
    const token=randomUUID();
    const job=await Followup.findOneAndUpdate({phoneId:process.env.WHATSAPP_PHONE_NUMBER_ID,dueAt:{$lte:new Date()},$or:[{state:'pending'},{state:'processing',leaseUntil:{$lt:new Date()}}]},{$set:{state:'processing',leaseUntil:new Date(Date.now()+60000),token}},{returnDocument:'after',sort:{dueAt:1}});
    if(!job)break;
    try{
      const check=await eligibility(job,config);
      if(check.reason){await Followup.updateOne({_id:job._id,token},{$set:{state:'cancelled',reason:check.reason}});continue;}
      const recent=await Followup.findOne({conversation:job.conversation,_id:{$ne:job._id},state:'queued',updatedAt:{$gt:new Date(Date.now()-3600000)}}).lean();
      if(recent){await Followup.updateOne({_id:job._id,token},{$set:{state:'pending',dueAt:new Date(new Date(recent.updatedAt).getTime()+3600000)}});continue;}
      const entry=await Record.findOne({kind:'knowledge',key:'payment_followup',enabled:true,archived:false}).lean();
      if(!entry?.data.preferredResponse)throw new Error('Configure the payment_followup knowledge entry.');
      // No model call, no invented payment data, and no sending outside the window.
      const response=require('./engine').render(entry.data.preferredResponse,{price:require('./engine').money(check.invoice.amount)});
      const message=await Message.findOneAndUpdate({clientKey:`ai-followup:${job._id}`},{$setOnInsert:{conversation:job.conversation,type:'text',direction:'outbound',status:'queued',text:response,author:'ai',authorName:config.displayName,routingPhoneId:process.env.WHATSAPP_PHONE_NUMBER_ID,automation:{version:job.version,inputId:job.inputId,configRevision:configRow.revision,followup:job._id}}},{upsert:true,returnDocument:'after'});
      await Followup.updateOne({_id:job._id,token},{$set:{state:'queued',message:message._id}});
      await Log.create({kind:'followup',conversation:job.conversation,action:'queued',after:{invoice:job.invoice,sequence:job.sequence},configRevision:configRow.revision});
    }catch(error){await Followup.updateOne({_id:job._id,token},{$set:{state:'failed',reason:error.message}});await Log.create({kind:'followup',conversation:job.conversation,action:'failed',error:'Reminder could not be safely prepared.'});}
  }
}
async function canSend(message,config){
  const job=await Followup.findById(message.automation.followup).lean();
  if(!job||!['queued','processing'].includes(job.state))return false;
  return !(await eligibility(job,config)).reason;
}
module.exports={schedule,cancel,tick,canSend,eligibility};
