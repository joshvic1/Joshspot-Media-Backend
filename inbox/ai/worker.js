const {randomUUID}=require('node:crypto');
const {Conversation,Message,Notification}=require('../models');
const Staff=require('../../models/Staff');
const {Config,Log,Usage}=require('./models');
const settings=require('./config');
const engine=require('./engine');
const {redact}=require('./privacy');
const live=require('../live');
const policy=require('../policy');
async function pause(conversation,actor,reason='HUMAN_TAKEOVER',assign=false) {
  const previous=await Conversation.findOneAndUpdate({_id:conversation},{$set:{'ai.active':false,'ai.draft':null,'ai.handoffPending':null,'ai.assignmentError':'','ai.handoffReason':reason,...(assign?{assignedTo:actor.admin?null:actor.id}:{})},$inc:{'ai.version':1}});
  if(previous && previous.ai?.active!==false)await require('../service').activity(conversation,actor,`AI paused: ${reason==='HUMAN_TYPING'?'a staff member started typing':reason==='HUMAN_REPLY'?'a staff member sent a reply':reason==='HUMAN_TAKEOVER'?'a staff member took over':reason}.`);
  await require('./followups').cancel(conversation,reason);
  await Message.updateMany({conversation,author:'ai',status:'queued'},{$set:{status:'failed',error:'AI reply cancelled because a human took over.'}});
  live.notify();
}
async function eligible(message) {
  const config=await settings.getConfig();
  if(message.automation.followup&&!await require('./followups').canSend(message,config.data))return false;
  const conversation=await Conversation.findOne({_id:message.conversation,status:{$ne:'resolved'},deleting:{$ne:true},...(message.automation.handoff?{'ai.active':false,'ai.needsHuman':true}:{'ai.active':{$ne:false},assignedTo:null}),'ai.version':message.automation.version,lastInboundId:message.automation.inputId}).lean();
  return Boolean(conversation && config.revision===message.automation.configRevision && config.data.enabled && config.data.autoReply && config.data.mode==='LIVE');
}
async function handoff(conversation,result,config,guard={}) {
  const row=await settings.getConfig();
  // Persist the handoff before assignment/notification/outbox side effects. Recovery
  // finishes interrupted handoffs without another model call or duplicate message.
  const current=await Conversation.findOneAndUpdate({_id:conversation._id,status:{$ne:'resolved'},deleting:{$ne:true},...guard},{$set:{'ai.active':false,'ai.pending':false,'ai.draft':null,'ai.needsHuman':true,'ai.priority':Boolean(result.priority),'ai.handoffReason':result.handoff,'ai.state':result.state || conversation.ai?.state || {},'ai.handoffPending':{result,configRevision:row.revision,inputId:conversation.lastInboundId,mode:config.mode},'ai.handoffRetryAt':new Date(),status:'open'},$inc:{'ai.version':1,revision:1}},{returnDocument:'after'});
  if(current){await require('./followups').cancel(current._id,result.handoff);await finishHandoff(current,row);}
}
async function finishHandoff(conversation,configRow) {
  const pending=conversation.ai?.handoffPending;if(!pending)return;
  const result=pending.result,config=configRow.data;
  const guard={_id:conversation._id,status:{$ne:'resolved'},deleting:{$ne:true},'ai.version':conversation.ai.version,'ai.active':false,'ai.needsHuman':true,'ai.handoffPending.inputId':pending.inputId};
  const rule=result.handoffRule && await require('./models').Record.findOne({kind:'handoff',key:result.handoffRule,enabled:true,archived:false}).lean();
  const team=result.handoffTeam || rule?.data.team || config.handoffTeam;
  let assigned=conversation.assignedTo;
  if(assigned && !await Staff.exists({_id:assigned,role:{$in:['CSS','SS']}}))assigned=null;
  const preferred=rule?.data.agent || (result.priority?config.paymentAgent:'') || config.fallbackAgent;
  if(!assigned && preferred)assigned=(await Staff.findOne({_id:preferred,role:team}))?._id;
  if(!assigned) {
    const staff=await Staff.find({role:team}).select('_id').sort({_id:1}).lean();
    if(config.assignment==='round_robin' && staff.length) {
      const sequence=await Usage.findOneAndUpdate({key:'assignment'},{$inc:{calls:1}},{upsert:true,returnDocument:'after'});assigned=staff[(sequence.calls-1)%staff.length]._id;
    } else {
      // Missing/deleted fallback staff must not strand a chat when CSS exists.
      const counts=await Promise.all(staff.map(async person=>({id:person._id,count:await Conversation.countDocuments({assignedTo:person._id,status:{$ne:'resolved'}})})));
      counts.sort((a,b)=>a.count-b.count);assigned=counts[0]?.id;
    }
  }
  if(!assigned){
    if(config.structuredSales&&pending.mode==='LIVE'&&config.mode==='LIVE'&&config.enabled&&config.autoReply&&policy.windowOpen(conversation.lastInboundAt))await queue(conversation,{response:result.response||config.fallbackResponse,handoff:true},configRow,pending.inputId,`ai-handoff:${conversation._id}:${pending.inputId}:${conversation.ai.version}`);
    await Conversation.updateOne(guard,{$set:{'ai.state.assignmentStatus':'PENDING_HUMAN_ASSIGNMENT','ai.assignmentError':`No ${team} staff account is available. Add a representative; assignment will retry automatically.`,'ai.handoffRetryAt':new Date(Date.now()+30000)}});live.notify();return;}
  const claimed=await Conversation.findOneAndUpdate({...guard,assignedTo:conversation.assignedTo || null},{$set:{assignedTo:assigned,'ai.state.assignmentStatus':'ASSIGNED','ai.state.assignedAt':new Date().toISOString(),'ai.assignmentError':'','ai.handoffRetryAt':new Date(Date.now()+30000)}},{returnDocument:'after'});
  if(!claimed)return;
  const key=`ai-handoff:${conversation._id}:${pending.inputId}:${conversation.ai.version}`;
  const note=await Message.findOneAndUpdate({clientKey:`${key}:activity`},{$setOnInsert:{conversation:conversation._id,type:'activity',direction:'internal',status:'internal',author:'ai',authorName:config.displayName,text:`AI assigned this conversation to customer support. Reason: ${result.handoff}\n${require('./salesSummary').summary(result.state || conversation.ai?.state || {})}`}},{upsert:true,returnDocument:'after'});
  await Notification.updateOne({recipient:assigned,message:note._id},{$setOnInsert:{conversation:conversation._id,authorName:config.displayName,kind:'handoff'}},{upsert:true});
  await require('../push').record(`${key}:assignment`,'assignments',conversation._id,assigned,note._id);
  const fresh=String(claimed.lastInboundId)===String(pending.inputId) && pending.configRevision===configRow.revision;
  const response=result.response || config.fallbackResponse;
  if(fresh && response && pending.mode==='LIVE' && config.mode==='LIVE' && config.enabled && config.autoReply && policy.windowOpen(claimed.lastInboundAt)) {
    await queue(claimed,{response,handoff:true},configRow,pending.inputId,key);
  } else if(fresh && response && pending.mode==='DRAFT') {
    await Conversation.updateOne(guard,{$set:{'ai.draft':{...result,response,action:'handoff',mode:'DRAFT',inputId:String(pending.inputId),version:claimed.ai.version,configRevision:configRow.revision,createdAt:new Date()}}});
  }
  await Conversation.updateOne(guard,{$unset:{'ai.handoffPending':1,'ai.handoffRetryAt':1}});
  live.notify();
}
async function recoverHandoffs(config){
  const rows=await Conversation.find({'ai.phoneId':process.env.WHATSAPP_PHONE_NUMBER_ID,'ai.handoffPending':{$ne:null},'ai.handoffRetryAt':{$lte:new Date()},'ai.active':false,'ai.needsHuman':true}).limit(20);
  for(const row of rows)await finishHandoff(row,config);
}
async function budget(config,conversationId) {
  const day=new Date().toISOString().slice(0,10);
  const reserve=async(key,limit,code)=>{
    try{await Usage.updateOne({key},{$setOnInsert:{calls:0,expiresAt:new Date(Date.now()+3*86400000)}},{upsert:true});}catch(error){if(error.code!==11000)throw error;}
    const bucket=await Usage.findOneAndUpdate({key,...(limit>0?{calls:{$lt:limit}}:{})},{$inc:{calls:1}},{returnDocument:'after'});
    if(!bucket)throw Object.assign(new Error(code),{code});
  };
  const conversationKey=`${conversationId}:${day}`;
  // Blocked conversation attempts never consume the global allowance.
  await reserve(conversationKey,config.maxConversationCalls,'AI_CONVERSATION_LIMIT');
  try{await reserve(`global:${day}`,config.maxDailyCalls,'AI_DAILY_LIMIT');}
  catch(error){await Usage.updateOne({key:conversationKey},{$inc:{calls:-1}});throw error;}
}
async function queue(conversation,result,configRow,inputId,key) {
  const message=await Message.findOneAndUpdate({clientKey:key},{$setOnInsert:{conversation:conversation._id,type:'text',direction:'outbound',status:'queued',text:result.response,author:'ai',authorName:configRow.data.displayName,routingPhoneId:process.env.WHATSAPP_PHONE_NUMBER_ID,automation:{version:conversation.ai.version,inputId,configRevision:configRow.revision,handoff:Boolean(result.handoff)}}},{upsert:true,returnDocument:'after'});
  await Conversation.updateOne({_id:conversation._id},{$set:{lastMessageId:message._id,lastMessageAt:message.createdAt,preview:result.response.slice(0,160)}});
  live.notify();return message;
}
async function runOne(configRow) {
  const config={...configRow.data,mode:configRow.data.autoReply?configRow.data.mode:'DRAFT'};const token=randomUUID();
  // Older conversations predate AI state. Persist the version before acquiring
  // a lease: Mongoose's in-memory default cannot match a missing database field.
  await Conversation.updateMany({'ai.phoneId':process.env.WHATSAPP_PHONE_NUMBER_ID,'ai.pending':true,'ai.version':{$exists:false}},{$set:{'ai.version':0}});
  const conversation=await Conversation.findOneAndUpdate({'ai.phoneId':process.env.WHATSAPP_PHONE_NUMBER_ID,'ai.pending':true,status:{$ne:'resolved'},deleting:{$ne:true},'ai.pendingAt':{$lte:new Date(Date.now()-config.debounceSeconds*1000)},$or:[{'ai.leaseUntil':null},{'ai.leaseUntil':{$lt:new Date()}}]},{$set:{'ai.leaseUntil':new Date(Date.now()+90000),'ai.leaseToken':token}},{returnDocument:'after',sort:{'ai.priority':-1,'ai.pendingAt':1}}).populate('contact');
  if(!conversation)return false;
  const started=Date.now();const latest=conversation.lastInboundId; const version=conversation.ai.version;
  const guard={status:{$ne:'resolved'},deleting:{$ne:true},'ai.leaseToken':token,'ai.version':version,lastInboundId:latest};
  try {
    if(conversation.ai.active===false || conversation.assignedTo){await Conversation.updateOne({_id:conversation._id,status:{$ne:'resolved'},deleting:{$ne:true},...guard},{$set:{'ai.pending':false}});return true;}
    const inputs=await Message.find({conversation:conversation._id,direction:'inbound',_id:{$lte:latest,...(conversation.ai.lastProcessedId?{$gt:conversation.ai.lastProcessedId}:{})}}).sort({_id:-1}).limit(20).lean();inputs.reverse();
    if(!inputs.length){await Conversation.updateOne({_id:conversation._id,status:{$ne:'resolved'},deleting:{$ne:true},...guard},{$set:{'ai.pending':false}});return true;}
    const text=inputs.map(m=>m.text).join('\n');const media=inputs.find(m=>m.type!=='text');
    const prior=conversation.ai.state || {};
    let result;
    try {
      if(config.maxConsecutive>0 && conversation.ai.consecutive>=config.maxConsecutive) result={action:'handoff',handoff:'AI_TURN_LIMIT',state:prior};
      else if(!policy.windowOpen(conversation.lastInboundAt)) result={action:'handoff',handoff:'SERVICE_WINDOW_CLOSED',state:prior};
      else {
        if(!media&&!config.structuredSales)await budget(config,conversation._id);
        const [records,knowledge,history]=await Promise.all([settings.catalogue(config.structuredSales),media?[]:settings.knowledge(text,prior,config.structuredSales),Message.find({conversation:conversation._id,direction:{$in:['inbound','outbound']},type:'text',_id:{$lt:inputs[0]._id}}).sort({_id:-1}).limit(config.maxHistory || 1).lean()]);
        const invoiceRecord=prior.invoiceId?await require('../../models/Invoice').findOne({_id:prior.invoiceId,inboxConversation:conversation._id,deletedAt:null}).select('amount status expiresAt').lean():null;
        const paymentVerified=invoiceRecord?.status==='paid';
        result=await engine.decide({text,customerName:conversation.contact.name,type:media?.type || 'text',state:prior,config,records,knowledge,history:history.reverse(),paymentVerified,invoiceRecord,reserveModelCall:()=>budget(config,conversation._id)});
      }
    } catch(error) { const detail=require('./errors').describe(error);result={action:'handoff',handoff:detail.code,state:prior,error:detail.message}; }
    const currentConfig=await settings.getConfig();
    if(currentConfig.revision!==configRow.revision || !currentConfig.data.enabled || currentConfig.data.mode==='OFF') return true;
    if(!await Conversation.exists({_id:conversation._id,...guard,'ai.active':{$ne:false},assignedTo:null}))return true;
    if(result.action==='handoff'&&!(config.structuredSales&&config.mode==='DRAFT')) await handoff(conversation,result,config,guard);
    else {
      if(result.action==='invoice' && config.mode==='LIVE') {
        try { const payment=await require('./invoices').generate({conversation,contact:conversation.contact,result,config});result={...result,response:payment.response,state:{...result.state,...payment,response:undefined}}; }
        catch { result={...result,action:'handoff',handoff:'INVOICE_ERROR'};await handoff(conversation,result,config,guard); }
      }
      if(result.action!=='handoff'||config.structuredSales&&config.mode==='DRAFT') {
        const draft={...result,inputId:String(latest),version,mode:config.mode,configRevision:configRow.revision,createdAt:new Date()};
        const saved=await Conversation.findOneAndUpdate({_id:conversation._id,...guard,'ai.active':{$ne:false},assignedTo:null},{$set:{'ai.pending':false,'ai.lastProcessedId':latest,'ai.state':result.state,'ai.priority':Boolean(result.priority),'ai.draft':draft},$inc:{'ai.consecutive':1}},{returnDocument:'after'});
        if(saved && config.mode==='LIVE' && config.autoReply && result.response && result.action!=='ignore') {
          if(config.responseDelaySeconds && !result.priority) await new Promise(r=>setTimeout(r,config.responseDelaySeconds*1000));
          await queue(saved,result,configRow,latest,`ai:${conversation._id}:${latest}`);
          if(result.action==='invoice'&&result.state.invoiceId)await require('./followups').schedule(saved,result.state.invoiceId,config);
          await Conversation.updateOne({_id:conversation._id,'ai.draft.inputId':String(latest)},{$set:{'ai.draft':null}});
        }
      }
    }
    await Log.create({kind:'decision',conversation:conversation._id,inputIds:inputs.map(m=>m._id),intent:result.intent,service:result.serviceKey,action:result.action,mode:config.mode,handoff:result.handoff,error:result.error,model:result.model,usage:result.usage,latency:Date.now()-started,before:prior,after:result.state,decision:{confidence:result.confidence,workflow:result.workflow,knowledge:result.knowledge,responseMode:result.responseMode,debug:{...result.debug,queueWaitMs:started-new Date(inputs[0].createdAt).getTime()}},text:redact(text),response:redact(result.response),configRevision:configRow.revision});
    if(result.usage?.total_tokens)await Usage.updateOne({key:`global:${new Date().toISOString().slice(0,10)}`},{$inc:{tokens:result.usage.total_tokens}});
    live.notify();return true;
  } finally {await Conversation.updateOne({_id:conversation._id,'ai.leaseToken':token},{$unset:{'ai.leaseUntil':1,'ai.leaseToken':1}});}
}
async function recover(config){
  if(config.data.mode!=='LIVE'||!config.data.autoReply)return;
  const items=await Conversation.find({'ai.phoneId':process.env.WHATSAPP_PHONE_NUMBER_ID,status:{$ne:'resolved'},deleting:{$ne:true},'ai.draft.mode':'LIVE','ai.draft.configRevision':config.revision,'ai.active':{$ne:false},assignedTo:null}).limit(10);
  for(const item of items){const draft=item.ai.draft;if(draft.response && String(item.lastInboundId)===draft.inputId && item.ai.version===draft.version)await queue(item,draft,config,draft.inputId,`ai:${item._id}:${draft.inputId}`);await Conversation.updateOne({_id:item._id,'ai.draft.inputId':draft.inputId},{$set:{'ai.draft':null}});}
}
let running=false,lastPaymentCheck=0;
async function tick(){if(running || !require('../workerPolicy').workerEnabled())return;running=true;try{const config=await settings.getConfig();await recoverHandoffs(config);if(!config.data.enabled || config.data.mode==='OFF')return;await recover(config);if(Date.now()-lastPaymentCheck>30000){await require('./payments').reconcile(config);lastPaymentCheck=Date.now();}await require('./followups').tick(config);for(let i=0;i<3;i++)if(!await runOne(config))break;}catch{console.error('Inbox AI worker deferred; incoming messages are retained');}finally{running=false;}}
module.exports={tick,runOne,pause,eligible,handoff,finishHandoff,recoverHandoffs,queue,budget};
