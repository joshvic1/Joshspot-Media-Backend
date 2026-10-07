const {Conversation,Message}=require('../../models');
const {Log,Usage}=require('../models');
const {redact}=require('../privacy');
function safeLog(value){if(typeof value==='string')return redact(value).replace(/https?:\/\/[^\s]+\/pay-invoice\/[^\s]+/g,'[private invoice link]');if(Array.isArray(value))return value.map(safeLog);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!['accountNumber','reference','paymentText','paymentDigest'].includes(k)).map(([k,v])=>[k,safeLog(v)]));return value;}
async function run({conversation,inputs,guard,configRow}){
 const config={...configRow.data,mode:configRow.data.autoReply?configRow.data.mode:'DRAFT'},simulation=config.mode!=='LIVE',started=Date.now(),state=JSON.parse(JSON.stringify(conversation.ai.v4||{}));
 state.ownership=conversation.ai.active!==false&&!conversation.assignedTo?'AI':'HUMAN';
 const filter={_id:conversation._id,...guard,'ai.active':{$ne:false},assignedTo:null};
 let transferred=null;
 const currentFilter=()=>transferred?{_id:conversation._id,status:{$ne:'resolved'},deleting:{$ne:true},lastInboundId:conversation.lastInboundId,'ai.version':transferred.ai.version,'ai.active':false,'ai.needsHuman':true,assignedTo:transferred.assignedTo||null}:filter;
 async function assertCurrent(){
  if(!await Conversation.exists(currentFilter()))throw new Error('V4_OWNERSHIP_CHANGED');
  const fresh=await require('../config').getConfig();if(fresh.revision!==configRow.revision||!fresh.data.enabled||require('../runtime').version(fresh.data)!=='v4'||fresh.data.mode==='OFF')throw new Error('V4_CONFIGURATION_CHANGED');
 }
 const ports={assertCurrent,async handoff(args){
  await assertCurrent();
  await require('../worker').handoff(conversation,{engineVersion:'v4',handoff:args.reason,summary:args.summary,state:conversation.ai.state||{},deferAcknowledgement:true},{...config,structuredSales:true},guard);
  transferred=await Conversation.findOne({_id:conversation._id,'ai.version':conversation.ai.version+1,'ai.handoffReason':args.reason,'ai.active':false});
  if(!transferred)throw new Error('V4_OWNERSHIP_CHANGED');
  return {accepted:!!transferred.assignedTo,pending:!transferred.assignedTo,reason:args.reason};
 },createInvoice:args=>require('./financial').createInvoice({...args,conversation,config,assertCurrent}),async persist(value){await assertCurrent();const r=await Conversation.updateOne(currentFilter(),{$set:{'ai.v4':value}});if(!r.matchedCount)throw new Error('V4_OWNERSHIP_CHANGED');},async invoiceStatus(refresh){
  if(!simulation)return require('./financial').invoiceStatus(conversation._id,refresh);
  // Pure read: unlike refreshInvoiceStatus this cannot mutate payment records.
  const row=await require('../../../models/Invoice').findOne({inboxConversation:conversation._id,deletedAt:null}).sort({createdAt:-1}).select('_id amount status expiresAt').lean();
  return row?{id:String(row._id),amount:row.amount,status:row.status,expiresAt:row.expiresAt}:{status:'NONE'};
 }};
 let result;
 try{
  if(inputs.length>200||!require('../../policy').windowOpen(conversation.lastInboundAt))throw new Error('V4_TURN_UNAVAILABLE');
  const history=await Message.find({conversation:conversation._id,_id:{$lt:inputs[0]._id},$or:[{direction:'inbound'},{direction:'outbound',status:{$in:['sent','delivered','read']}}]}).sort({_id:-1}).limit(80).lean();history.reverse();
  result=await require('./index').decide({config,records:await require('../v3/catalogue').load(),messages:inputs,history,state,ports,simulation,reserveModelCall:()=>require('../worker').budget(config,conversation._id)});
 }catch(error){
  if(['V4_OWNERSHIP_CHANGED','V4_CONFIGURATION_CHANGED'].includes(error.message)){await Log.create({kind:'decision',conversation:conversation._id,action:'cancelled',mode:config.mode,error:error.message,decision:{engineVersion:'v4'}});return true;}
  result={engineVersion:'v4',action:'handoff',handoff:transferred?.ai.handoffReason||'TECHNICAL_FAILURE',error:error.code||error.message,response:config.fallbackResponse,usage:error.usage,model:error.model,debug:error.debug||{engineVersion:'v4',simulation}};
 }
 await assertCurrent();
 const draft={...result,inputId:String(conversation.lastInboundId),version:conversation.ai.version,mode:config.mode,configRevision:configRow.revision,createdAt:new Date()};
 // A draft neither assigns a representative nor sends a message/creates invoice.
 const saved=await Conversation.updateOne(currentFilter(),{$set:{'ai.pending':false,'ai.lastProcessedId':conversation.lastInboundId,'ai.draft':draft},$inc:{'ai.consecutive':1}});
 if(saved.matchedCount&&!simulation){
  await assertCurrent();
  if(transferred)await require('../worker').queue(transferred,result,configRow,conversation.lastInboundId,`ai-handoff:${conversation._id}:${conversation.lastInboundId}:${transferred.ai.version}`);
  else if(result.action==='handoff')await require('../worker').handoff(conversation,{...result,state:conversation.ai.state||{}},{...config,structuredSales:true},guard);
  else if(result.response)await require('../worker').queue(conversation,result,configRow,conversation.lastInboundId,`ai:${conversation._id}:${conversation.lastInboundId}`);
  await Conversation.updateOne(currentFilter(),{$set:{'ai.draft':null}});
 }
 if(saved.matchedCount)await Log.create({kind:'decision',conversation:conversation._id,inputIds:inputs.map(m=>m._id),action:result.action,mode:config.mode,handoff:result.handoff,error:result.error,text:redact(inputs.map(m=>m.text).join('\n')),response:redact(result.response),decision:safeLog({...result.debug,delivery:simulation?'DRAFT':result.action==='handoff'?'HANDOFF_REQUESTED':'QUEUED'}),model:result.model,usage:result.usage,latency:Date.now()-started,configRevision:configRow.revision});
 if(result.usage?.total_tokens)await Usage.updateOne({key:`global:${new Date().toISOString().slice(0,10)}`},{$inc:{tokens:result.usage.total_tokens}});
 require('../../live').notify();return true;
}
module.exports={run,safeLog};
