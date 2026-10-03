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
  await Conversation.updateOne({_id:conversation},{$set:{'ai.active':false,'ai.draft':null,'ai.handoffReason':reason,...(assign?{assignedTo:actor.admin?null:actor.id}:{})},$inc:{'ai.version':1}});
  await Message.updateMany({conversation,author:'ai',status:'queued'},{$set:{status:'failed',error:'AI reply cancelled because a human took over.'}});
  live.notify();
}
async function eligible(message) {
  const config=await settings.getConfig();
  const conversation=await Conversation.findOne({_id:message.conversation,...(message.automation.handoff?{'ai.active':false,'ai.needsHuman':true}:{'ai.active':{$ne:false},assignedTo:null}),'ai.version':message.automation.version,lastInboundId:message.automation.inputId}).lean();
  return Boolean(conversation && config.revision===message.automation.configRevision && config.data.enabled && config.data.autoReply && config.data.mode==='LIVE');
}
async function handoff(conversation,result,config,guard={}) {
  const rule=result.handoffRule && await require('./models').Record.findOne({kind:'handoff',key:result.handoffRule,enabled:true,archived:false}).lean();
  let assigned=conversation.assignedTo;
  const preferred=rule?.data.agent || (result.priority?config.paymentAgent:'') || config.fallbackAgent;
  if(!assigned && preferred) assigned=(await Staff.findOne({_id:preferred,role:{$in:['CSS','SS']}}))?._id;
  if(!assigned) {
    const staff=await Staff.find({role:rule?.data.team || config.handoffTeam}).select('_id').sort({_id:1}).lean();
    if(config.assignment==='round_robin' && staff.length) {
      const sequence=await Usage.findOneAndUpdate({key:'assignment'},{$inc:{calls:1}},{upsert:true,returnDocument:'after'});assigned=staff[(sequence.calls-1)%staff.length]._id;
    } else if(config.assignment!=='fallback') {
      const counts=await Promise.all(staff.map(async person=>({id:person._id,count:await Conversation.countDocuments({assignedTo:person._id,status:{$ne:'resolved'}})})));
      counts.sort((a,b)=>a.count-b.count);assigned=counts[0]?.id;
    }
  }
  const changed=await Conversation.updateOne({_id:conversation._id,...guard},{$set:{'ai.active':false,'ai.pending':false,'ai.draft':null,'ai.needsHuman':true,'ai.priority':Boolean(result.priority),'ai.handoffReason':result.handoff,'ai.state':result.state || conversation.ai?.state || {},assignedTo:assigned || null,status:'open'},$inc:{'ai.version':1,revision:1}});
  if(!changed.modifiedCount)return;
  const note=await Message.create({conversation:conversation._id,type:'activity',direction:'internal',status:'internal',author:'ai',authorName:config.displayName,text:`AI handed this conversation to ${assigned?'a representative':'the human support queue'}. Reason: ${result.handoff}`});
  if(assigned) await Notification.updateOne({recipient:assigned,message:note._id},{$setOnInsert:{conversation:conversation._id,authorName:config.displayName,kind:'handoff'}},{upsert:true});
  if(result.response && config.mode==='LIVE' && config.autoReply && policy.windowOpen(conversation.lastInboundAt)) {
    const row=await settings.getConfig();const current=await Conversation.findById(conversation._id);
    await queue(current,{response:result.response,handoff:true},row,conversation.lastInboundId,`ai-handoff:${conversation._id}:${conversation.lastInboundId}`);
  }
  live.notify();
}
async function budget(config,conversationId) {
  const day=new Date().toISOString().slice(0,10);
  for(const [key,limit] of [[`global:${day}`,config.maxDailyCalls],[`${conversationId}:${day}`,config.maxConversationCalls]]) {
    const bucket=await Usage.findOneAndUpdate({key},{$inc:{calls:1},$setOnInsert:{expiresAt:new Date(Date.now()+3*86400000)}},{upsert:true,returnDocument:'after'});
    if(bucket.calls>limit)throw new Error('AI usage limit reached');
  }
}
async function queue(conversation,result,configRow,inputId,key) {
  const message=await Message.findOneAndUpdate({clientKey:key},{$setOnInsert:{conversation:conversation._id,type:'text',direction:'outbound',status:'queued',text:result.response,author:'ai',authorName:configRow.data.displayName,routingPhoneId:process.env.WHATSAPP_PHONE_NUMBER_ID,automation:{version:conversation.ai.version,inputId,configRevision:configRow.revision,handoff:Boolean(result.handoff)}}},{upsert:true,returnDocument:'after'});
  await Conversation.updateOne({_id:conversation._id},{$set:{lastMessageId:message._id,lastMessageAt:message.createdAt,preview:result.response.slice(0,160)}});
  live.notify();return message;
}
async function runOne(configRow) {
  const config={...configRow.data,mode:configRow.data.autoReply?configRow.data.mode:'DRAFT'};const token=randomUUID();
  const conversation=await Conversation.findOneAndUpdate({'ai.phoneId':process.env.WHATSAPP_PHONE_NUMBER_ID,'ai.pending':true,'ai.pendingAt':{$lte:new Date(Date.now()-config.debounceSeconds*1000)},$or:[{'ai.leaseUntil':null},{'ai.leaseUntil':{$lt:new Date()}}]},{$set:{'ai.leaseUntil':new Date(Date.now()+90000),'ai.leaseToken':token}},{returnDocument:'after',sort:{'ai.priority':-1,'ai.pendingAt':1}}).populate('contact');
  if(!conversation)return false;
  const started=Date.now();const latest=conversation.lastInboundId; const version=conversation.ai.version;
  const guard={'ai.leaseToken':token,'ai.version':version,lastInboundId:latest};
  try {
    if(conversation.ai.active===false || conversation.assignedTo){await Conversation.updateOne({_id:conversation._id,...guard},{$set:{'ai.pending':false}});return true;}
    const inputs=await Message.find({conversation:conversation._id,direction:'inbound',_id:{$lte:latest,...(conversation.ai.lastProcessedId?{$gt:conversation.ai.lastProcessedId}:{})}}).sort({_id:-1}).limit(20).lean();inputs.reverse();
    if(!inputs.length){await Conversation.updateOne({_id:conversation._id,...guard},{$set:{'ai.pending':false}});return true;}
    const text=inputs.map(m=>m.text).join('\n');const media=inputs.find(m=>m.type!=='text');
    const prior=conversation.ai.state || {};
    let result;
    try {
      if(conversation.ai.consecutive>=config.maxConsecutive) result={action:'handoff',handoff:'AI_TURN_LIMIT',state:prior};
      else if(!policy.windowOpen(conversation.lastInboundAt)) result={action:'handoff',handoff:'SERVICE_WINDOW_CLOSED',state:prior};
      else {
        if(!media)await budget(config,conversation._id);
        const [records,knowledge,history]=await Promise.all([settings.catalogue(),media?[]:settings.knowledge(text),Message.find({conversation:conversation._id,direction:{$in:['inbound','outbound']},type:'text',_id:{$lt:inputs[0]._id}}).sort({_id:-1}).limit(config.maxHistory || 1).lean()]);
        result=await engine.decide({text,type:media?.type || 'text',state:prior,config,records,knowledge,history:history.reverse()});
      }
    } catch { result={action:'handoff',handoff:'AI_ERROR',state:prior,error:'Provider, configuration or usage limit unavailable'}; }
    const currentConfig=await settings.getConfig();
    if(currentConfig.revision!==configRow.revision || !currentConfig.data.enabled || currentConfig.data.mode==='OFF') return true;
    if(!await Conversation.exists({_id:conversation._id,...guard,'ai.active':{$ne:false},assignedTo:null}))return true;
    if(result.action==='handoff') await handoff(conversation,result,config,guard);
    else {
      if(result.action==='invoice' && config.mode==='LIVE') {
        try { const payment=await require('./invoices').generate({conversation,contact:conversation.contact,result,config});result={...result,response:payment.response,state:{...result.state,...payment,response:undefined}}; }
        catch { result={...result,action:'handoff',handoff:'INVOICE_ERROR'};await handoff(conversation,result,config,guard); }
      }
      if(result.action!=='handoff') {
        const draft={...result,inputId:String(latest),version,mode:config.mode,configRevision:configRow.revision,createdAt:new Date()};
        const saved=await Conversation.findOneAndUpdate({_id:conversation._id,...guard,'ai.active':{$ne:false},assignedTo:null},{$set:{'ai.pending':false,'ai.lastProcessedId':latest,'ai.state':result.state,'ai.priority':Boolean(result.priority),'ai.draft':draft},$inc:{'ai.consecutive':1}},{returnDocument:'after'});
        if(saved && config.mode==='LIVE' && config.autoReply && result.response && result.action!=='ignore') {
          if(config.responseDelaySeconds && !result.priority) await new Promise(r=>setTimeout(r,config.responseDelaySeconds*1000));
          await queue(saved,result,configRow,latest,`ai:${conversation._id}:${latest}`);
          await Conversation.updateOne({_id:conversation._id,'ai.draft.inputId':String(latest)},{$set:{'ai.draft':null}});
        }
      }
    }
    await Log.create({kind:'decision',conversation:conversation._id,inputIds:inputs.map(m=>m._id),intent:result.intent,service:result.serviceKey,action:result.action,mode:config.mode,handoff:result.handoff,error:result.error,model:result.model,usage:result.usage,latency:Date.now()-started,before:prior,after:result.state,decision:{confidence:result.confidence,workflow:result.workflow,knowledge:result.knowledge},text:redact(text),response:redact(result.response),configRevision:configRow.revision});
    if(result.usage?.total_tokens)await Usage.updateOne({key:`global:${new Date().toISOString().slice(0,10)}`},{$inc:{tokens:result.usage.total_tokens}});
    live.notify();return true;
  } finally {await Conversation.updateOne({_id:conversation._id,'ai.leaseToken':token},{$unset:{'ai.leaseUntil':1,'ai.leaseToken':1}});}
}
async function recover(config){
  if(config.data.mode!=='LIVE'||!config.data.autoReply)return;
  const items=await Conversation.find({'ai.phoneId':process.env.WHATSAPP_PHONE_NUMBER_ID,'ai.draft.mode':'LIVE','ai.draft.configRevision':config.revision,'ai.active':{$ne:false},assignedTo:null}).limit(10);
  for(const item of items){const draft=item.ai.draft;if(draft.response && String(item.lastInboundId)===draft.inputId && item.ai.version===draft.version)await queue(item,draft,config,draft.inputId,`ai:${item._id}:${draft.inputId}`);await Conversation.updateOne({_id:item._id,'ai.draft.inputId':draft.inputId},{$set:{'ai.draft':null}});}
}
let running=false;
async function tick(){if(running || !require('../workerPolicy').workerEnabled())return;running=true;try{const config=await settings.getConfig();if(!config.data.enabled || config.data.mode==='OFF')return;await recover(config);for(let i=0;i<3;i++)if(!await runOne(config))break;}catch{console.error('Inbox AI worker deferred; incoming messages are retained');}finally{running=false;}}
module.exports={tick,runOne,pause,eligible,handoff,queue,budget};
