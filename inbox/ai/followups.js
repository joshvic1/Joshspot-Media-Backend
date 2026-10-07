const {randomUUID}=require('node:crypto');
const {Followup,Record,Log}=require('./models');
const {Conversation,Message}=require('../models');
const Invoice=require('../../models/Invoice');
const policy=require('../policy');

async function schedule(conversation,invoiceId,config,sourceMessage=null){
  if(!config.followupsEnabled||(!sourceMessage&&!config.structuredSales))return;
  const invoice=await Invoice.findOne({_id:invoiceId,inboxConversation:conversation._id,status:sourceMessage?{$in:['pending','expired','failed']}:'pending'}).lean();
  if(!invoice)return;
  const latest=await require('../latestInvoice')(conversation);
  if(String(latest?._id)!==String(invoice._id))return;
  await Followup.updateMany({conversation:conversation._id,invoice:{$ne:invoice._id},state:{$in:['pending','processing','queued']}},{$set:{state:'cancelled',reason:'Superseded by a newer invoice'}});
  if(sourceMessage&&!sourceMessage.sentAt)return;
  if(sourceMessage){
    await Followup.updateMany({conversation:conversation._id,invoice:invoice._id,source:'manual',sequence:{$gt:0},state:{$in:['pending','processing','queued']}},{$set:{state:'cancelled',reason:'Manual invoices have one 22-hour reminder'}});
    await Followup.updateMany({conversation:conversation._id,invoice:invoice._id,source:'manual',sequence:0,state:'pending'},{$set:{dueAt:new Date(new Date(sourceMessage.sentAt).getTime()+22*3600000)}});
  }
  for(let i=0;i<(sourceMessage?1:config.followupMaximum);i++) {
    const hours=sourceMessage?22:i===0?config.followupFirstHours:config.followupSecondHours;
    await Followup.updateOne({conversation:conversation._id,invoice:invoice._id,sequence:i},{$setOnInsert:{source:sourceMessage?'manual':'ai',sourceMessage:sourceMessage?._id,assignedTo:conversation.assignedTo||null,phoneId:conversation.ai.phoneId||process.env.WHATSAPP_PHONE_NUMBER_ID,state:'pending',dueAt:new Date((sourceMessage?new Date(sourceMessage.sentAt).getTime():Date.now())+hours*3600000),inputId:conversation.lastInboundId,version:conversation.ai.version}},{upsert:true});
  }
}
async function cancel(conversation,reason){await Followup.updateMany({conversation,state:{$in:['pending','processing']}},{$set:{state:'cancelled',reason}});}
async function eligibility(job,config){
  if(job.source==='manual')return manualEligibility(job,config);
  const c=await Conversation.findOne({_id:job.conversation,'ai.phoneId':process.env.WHATSAPP_PHONE_NUMBER_ID,'ai.active':{$ne:false},'ai.version':job.version,assignedTo:null,status:{$ne:'resolved'},deleting:{$ne:true},lastInboundId:job.inputId}).lean();
  if(!c||c.ai?.state?.salesPaused||c.ai?.state?.paymentStatus==='claimed'||String(c.ai?.state?.invoiceId)!==String(job.invoice))return {reason:'Conversation changed or is human-owned'};
  const latest=await require('../latestInvoice')(c);
  if(String(latest?._id)!==String(job.invoice))return {reason:'Superseded by a newer invoice'};
  const invoice=await Invoice.findOne({_id:job.invoice,inboxConversation:c._id,status:'pending',deletedAt:null,expiresAt:{$gt:new Date()}}).lean();
  if(!invoice)return {reason:'Invoice is paid, expired or no longer pending'};
  const delivered=await Message.exists({conversation:c._id,clientKey:`ai:${c._id}:${job.inputId}`,status:{$in:['sent','delivered','read']}});
  if(!delivered)return {reason:'Invoice message has not been successfully sent'};
  if(!config.enabled||config.mode!=='LIVE'||!config.autoReply||!config.structuredSales||!config.followupsEnabled)return {reason:'Automatic follow-ups are disabled'};
  if(!policy.windowOpen(c.lastInboundAt))return {reason:'WhatsApp window closed; no approved reminder template configured'};
  return {conversation:c,invoice};
}
async function manualEligibility(job,config){
  if(!config.followupsEnabled)return {reason:'Automatic follow-ups are disabled'};
  const c=await Conversation.findOne({_id:job.conversation,deleting:{$ne:true},status:{$ne:'resolved'},lastInboundId:job.inputId,'ai.version':job.version,assignedTo:job.assignedTo||null}).lean();
  if(!c)return {reason:'Customer input or conversation ownership changed'};
  const invoice=await require('../latestInvoice')(c);
  if(String(invoice?._id)!==String(job.invoice))return {reason:'Superseded by a newer invoice'};
  if(!['pending','expired','failed'].includes(invoice.status))return {reason:'Invoice is paid or unavailable'};
  if(job.sequence!==0)return {reason:'Only one manual invoice reminder is allowed'};
  const source=await Message.findOne({_id:job.sourceMessage,conversation:c._id,status:{$in:['sent','delivered','read']}}).lean();
  if(!source?.sentAt||Date.now()<new Date(source.sentAt).getTime()+22*3600000)return {reason:'Manual invoice reminder is not due yet'};
  if(!source)return {reason:'Invoice message has not been successfully sent'};
  return {conversation:c,invoice};
}
async function tick(configRow,source='ai'){
  const config=configRow.data;
  if(!config.followupsEnabled||(source!=='manual'&&(!config.structuredSales||config.mode!=='LIVE'||!config.enabled||!config.autoReply)))return;
  for(let i=0;i<3;i++){
    const token=randomUUID();
    const job=await Followup.findOneAndUpdate({source:source==='manual'?'manual':{$ne:'manual'},phoneId:process.env.WHATSAPP_PHONE_NUMBER_ID,dueAt:{$lte:new Date()},$or:[{state:'pending'},{state:'processing',leaseUntil:{$lt:new Date()}}]},{$set:{state:'processing',leaseUntil:new Date(Date.now()+60000),token}},{returnDocument:'after',sort:{dueAt:1}});
    if(!job)break;
    try{
      const check=await eligibility(job,config);
      if(check.reason){await Followup.updateOne({_id:job._id,token},{$set:{state:'cancelled',reason:check.reason}});continue;}
      const current=await require('../../controllers/invoiceController').refreshInvoiceStatus(await Invoice.findById(job.invoice),true);
      if(job.source==='manual'? !['pending','expired','failed'].includes(current.status):current.status!=='pending'){await Followup.updateOne({_id:job._id,token},{$set:{state:'cancelled',reason:'Payment checked: invoice is no longer pending'}});continue;}
      const recent=await Followup.findOne({conversation:job.conversation,_id:{$ne:job._id},state:'queued',updatedAt:{$gt:new Date(Date.now()-3600000)}}).lean();
      if(recent){await Followup.updateOne({_id:job._id,token},{$set:{state:'pending',dueAt:new Date(new Date(recent.updatedAt).getTime()+3600000)}});continue;}
      const template=job.source==='manual'?await require('./manualReminderTemplate')(check.conversation):null;
      const entry=template?null:await Record.findOne({kind:'knowledge',key:'payment_followup',enabled:true,archived:false}).lean();
      if(!template&&!entry?.data.preferredResponse)throw new Error('Configure the payment_followup knowledge entry.');
      // Deterministic template for manual reminders; AI text reminders remain window-limited.
      const response=template?template.preview:require('./engine').render(entry.data.preferredResponse,{price:require('./engine').money(check.invoice.amount)});
      const message=await Message.findOneAndUpdate({clientKey:`ai-followup:${job._id}`},{$setOnInsert:{conversation:job.conversation,type:template?'template':'text',...(template?{providerPayload:template.payload}:{}),direction:'outbound',status:'queued',text:response,author:job.source==='manual'?'admin':'ai',authorName:config.displayName,routingPhoneId:process.env.WHATSAPP_PHONE_NUMBER_ID,automation:{version:job.version,inputId:job.inputId,configRevision:configRow.revision,followup:job._id}}},{upsert:true,returnDocument:'after'});
      await Followup.updateOne({_id:job._id,token},{$set:{state:'queued',message:message._id}});
      await Log.create({kind:'followup',conversation:job.conversation,action:'queued',after:{invoice:job.invoice,sequence:job.sequence},configRevision:configRow.revision});
    }catch(error){await Followup.updateOne({_id:job._id,token},{$set:{state:'failed',reason:error.message}});await Log.create({kind:'followup',conversation:job.conversation,action:'failed',error:'Reminder could not be safely prepared.'});}
  }
}
async function canSend(message,config){
  const job=await Followup.findById(message.automation.followup).lean();
  if(!job||!['queued','processing'].includes(job.state))return false;
  const check=await eligibility(job,config);if(check.reason)return false;
  // Recheck the provider immediately before sending, not just at scheduling time.
  const fresh=await require('../../controllers/invoiceController').refreshInvoiceStatus(await Invoice.findById(job.invoice),true);
  if(job.source==='manual'){
    if(message.type!=='template')return false;
    const expected=await require('./manualReminderTemplate')(check.conversation);
    const stored=await Message.findById(message._id).select('+providerPayload').lean();
    if(JSON.stringify(stored?.providerPayload)!==JSON.stringify(expected.payload))return false;
  }
  return (job.source==='manual'?['pending','expired','failed'].includes(fresh.status):fresh.status==='pending') && !(await eligibility(job,config)).reason;
}
module.exports={schedule,cancel,tick,canSend,eligibility};
