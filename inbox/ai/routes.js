const express=require('express');const mongoose=require('mongoose');
const router=express.Router();const {Config,Record,Log,Usage}=require('./models');const settings=require('./config');const engine=require('./engine');const worker=require('./worker');const {redact,sensitive}=require('./privacy');
const {Conversation,Message}=require('../models');const policy=require('../policy');const live=require('../live');const Staff=require('../../models/Staff');
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
const id=value=>{if(!mongoose.isValidObjectId(value))fail(400,'Invalid identifier');return value;};
async function conversationFor(req){const conversation=await Conversation.findOne({$and:[policy.visible(req.actor),{_id:id(req.params.id)}]}).populate('contact');if(!conversation)fail(404,'Conversation unavailable');return conversation;}
router.post('/conversations/:id/control',wrap(async(req,res)=>{
  const c=await conversationFor(req);const config=await settings.getConfig();
  if(!policy.canReply(req.actor,c) && c.assignedTo)fail(403,'Only the assigned representative or admin can change AI handling');
  if(req.body.action==='takeover') {await worker.pause(c._id,req.actor,'HUMAN_TAKEOVER',true);await require('../service').activity(c._id,req.actor,'Took over from AI');}
  else if(req.body.action==='return') {
    if(!req.actor.admin && (req.actor.role === 'CSS' || !config.data.allowReturn))fail(403,'Only administrators can return conversations to AI');
    await Conversation.updateOne({_id:c._id},{$set:{assignedTo:null,'ai.active':true,'ai.pending':false,'ai.draft':null,'ai.needsHuman':false,'ai.handoffPending':null,'ai.assignmentError':'','ai.handoffReason':'','ai.state.aiActive':true,'ai.state.humanHandoffReason':'','ai.returnedBy':req.actor.id,'ai.consecutive':0,'ai.lastProcessedId':c.lastInboundId},$inc:{'ai.version':1,revision:1}});
    await require('../service').activity(c._id,req.actor,'Returned future messages to AI');
  } else if(req.body.action==='cancel_followups'){await require('./followups').cancel(c._id,'Cancelled by staff');} else if(req.body.action==='retry_assignment'&&c.ai?.handoffPending){await worker.finishHandoff(c,config);} else fail(400,'Choose takeover, return or retry assignment');
  await Log.create({kind:'control',actor:req.actor.id,conversation:c._id,action:req.body.action});live.notify();res.json({ok:true});
}));
router.post('/conversations/:id/typing',wrap(async(req,res)=>{
  const c=await conversationFor(req);if(!policy.canReply(req.actor,c))fail(403,'Claim the conversation first');
  if(c.ai?.active!==false)await worker.pause(c._id,req.actor,'HUMAN_TYPING');res.json({ok:true});
}));
router.post('/conversations/:id/draft',wrap(async(req,res)=>{
  const c=await conversationFor(req);if(!policy.canReply(req.actor,c) && c.assignedTo)fail(403,'Claim the conversation first');
  const draft=c.ai?.draft;if(!draft)fail(409,'This suggestion is no longer available');
  if(!['send','dismiss'].includes(req.body.action))fail(400,'Choose send or dismiss');
  if(req.body.action==='dismiss'){await Conversation.updateOne({_id:c._id,'ai.draft.inputId':draft.inputId},{$set:{'ai.draft':null}});live.notify();return res.json({ok:true});}
  const config=await settings.getConfig();
  if(String(c.lastInboundId)!==draft.inputId || config.revision!==draft.configRevision)fail(409,'New input or settings changed. Review the conversation before replying.');
  if(!policy.windowOpen(c.lastInboundAt))fail(400,'The WhatsApp reply window has closed. Use an approved template.');
  if(req.body.text!==undefined && (typeof req.body.text!=='string' || !req.body.text.trim() || req.body.text.length>4096))fail(400,'Write a reply of up to 4096 characters');
  const claimed=await Conversation.updateOne({_id:c._id,'ai.draft.inputId':draft.inputId},{$set:{'ai.draft':null,'ai.active':false,...(!req.actor.admin?{assignedTo:req.actor.id}:{})},$inc:{'ai.version':1}});
  if(!claimed.modifiedCount)fail(409,'Suggestion already handled');
  let response=draft.response;
  if(draft.action==='handoff'&&config.data.structuredSales)await worker.handoff(c,{...draft,response:''},{...config.data,mode:'OFF'});
  if(draft.action==='invoice') {
    try {const payment=await require('./invoices').generate({conversation:c,contact:c.contact,result:draft,config:config.data});response=payment.response;await Conversation.updateOne({_id:c._id},{$set:{'ai.state':{...draft.state,...payment,response:undefined}}});}
    catch{await worker.handoff(c,{handoff:'INVOICE_ERROR',priority:true},config.data);fail(502,'Invoice could not be safely generated. A representative must review it.');}
  } else if(req.body.text!==undefined)response=req.body.text;
  if(!response)fail(400,'No reply available');
  const message=await Message.findOneAndUpdate({clientKey:`ai-approved:${c._id}:${draft.inputId}`},{$setOnInsert:{conversation:c._id,type:'text',direction:'outbound',status:'queued',text:response,author:req.actor.id,authorName:req.actor.name,routingPhoneId:process.env.WHATSAPP_PHONE_NUMBER_ID}},{upsert:true,returnDocument:'after'});
  await Conversation.updateOne({_id:c._id},{$set:{lastMessageId:message._id,lastMessageAt:message.createdAt,preview:response.slice(0,160)}});
  await Log.create({kind:'approval',actor:req.actor.id,conversation:c._id,action:'send',response:redact(response)});live.notify();res.json({ok:true});
}));
router.use((req,res,next)=>{if(!req.actor.admin)return res.status(403).json({message:'Only administrators can configure the AI agent'});next();});
router.put('/conversations/:id/state',wrap(async(req,res)=>{
 const c=await conversationFor(req);if(req.body.revision!==c.revision)fail(409,'Conversation changed. Reload before correcting state.');
 const changes=req.body.state||{};const keys=Object.keys(changes);
 if(keys.some(k=>!['selectedPlatform','serviceType','budget','duration'].includes(k)))fail(400,'Only service, platform, budget and duration can be corrected here.');
 if(changes.selectedPlatform!==undefined&&!['tiktok','meta'].includes(changes.selectedPlatform)||changes.serviceType!==undefined&&!['account_setup','ads_management'].includes(changes.serviceType))fail(400,'Choose supported service and platform.');
 for(const key of ['budget','duration'])if(changes[key]!==undefined&&(!Number.isFinite(changes[key])||changes[key]<=0||changes[key]>(key==='duration'?365:100000000)||key==='duration'&&!Number.isInteger(changes[key])))fail(400,'Invalid budget or duration.');
 const state={...c.ai?.state,...changes};if(state.invoiceId)state.previousInvoiceId=state.invoiceId;
 for(const key of ['invoiceId','invoiceStatus','paymentDetailsSentAt','paymentDetailsRequested','quotedAmount','quoteSource','customerWantsToProceed'])delete state[key];
 const updated=await Conversation.updateOne({_id:c._id,revision:c.revision},{$set:{'ai.state':state,'ai.draft':null},$inc:{revision:1,'ai.version':1}});
 if(!updated.modifiedCount)fail(409,'Conversation changed. Reload before correcting state.');
 await require('./followups').cancel(c._id,'Admin corrected sales state');await Log.create({kind:'control',conversation:c._id,actor:req.actor.id,action:'correct_state',before:c.ai?.state,after:state});live.notify();res.json({ok:true});
}));
router.get('/export',wrap(async(req,res)=>{
 const config=await settings.getConfig();const records=await Record.find({}).lean();
 const clean=value=>typeof value==='string'?redact(value):Array.isArray(value)?value.map(clean):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,clean(v)])):value;
 res.json({version:1,exportedAt:new Date().toISOString(),redaction:'Potential credentials and private numbers are excluded.',settings:clean(settings.validateConfig(config.data)),records:records.map(r=>clean({kind:r.kind,key:r.key,title:r.title,category:r.category,priority:r.priority,enabled:r.enabled,archived:r.archived,data:r.data}))});
}));
router.get('/structured-migration',wrap(async(req,res)=>res.json(await require('./structuredMigration').preview())));
router.post('/structured-migration',wrap(async(req,res)=>res.json(await require('./structuredMigration').apply(req.actor.id))));
router.get('/master-knowledge',wrap(async(req,res)=>{
 const config=await settings.getConfig();res.json({text:config.data.masterInstructions ?? require('./masterKnowledge').starter,revision:config.revision,maxLength:require('./masterKnowledge').MAX_LENGTH});
}));
router.put('/master-knowledge',wrap(async(req,res)=>{
 const {MAX_LENGTH}=require('./masterKnowledge');
 if(typeof req.body.text!=='string'||req.body.text.length>MAX_LENGTH)fail(400,`Use up to ${MAX_LENGTH} characters.`);
 if(!Number.isInteger(req.body.revision))fail(400,'Reload the document before saving.');
 const saved=await Config.findOneAndUpdate({key:'main',revision:req.body.revision},{$set:{masterInstructions:req.body.text,changedBy:req.actor.id},$inc:{revision:1}},{returnDocument:'after'});
 if(!saved)fail(409,'Settings changed. Your draft is preserved; reload the saved version before trying again.');
 await Log.create({kind:'configuration',actor:req.actor.id,action:'master_knowledge',after:{characters:req.body.text.length},configRevision:saved.revision});
 res.json({text:saved.masterInstructions,revision:saved.revision,maxLength:MAX_LENGTH});
}));
router.get('/config',wrap(async(req,res)=>{const config=await settings.getConfig();res.json({...config,providerReady:Boolean(process.env.OPENAI_API_KEY && (config.data.model || process.env.OPENAI_MODEL)),staff:await Staff.find({role:{$in:['CSS','SS']}}).select('name role').lean()});}));
router.post('/business-pack',wrap(async(req,res)=>res.json(await require('./installBusinessPack').install(req.actor.id))));
router.post('/initialize',wrap(async(req,res)=>{await settings.seed(req.actor.id);await Log.create({kind:'configuration',actor:req.actor.id,action:'initialize'});res.json(await settings.getConfig());}));
router.put('/config',wrap(async(req,res)=>{
  const before=await settings.getConfig();if(req.body.revision!==before.revision)fail(409,'Settings changed. Reload before saving');
  const data=settings.validateConfig(req.body.data || {});
  if(data.structuredSales&&data.mode==='LIVE'&&before.data.mode!=='LIVE'){
    const tested=await Log.exists({kind:'test',configRevision:before.revision,action:{$in:['reply','invoice']}});
    const drafted=await Log.exists({kind:'decision',mode:'DRAFT',configRevision:before.revision,action:{$in:['reply','invoice']}});
    if(!tested||!drafted)fail(400,'Validate the current configuration in Test Agent and a DRAFT conversation before LIVE.');
  }
  if(data.structuredSales&&!before.data.structuredSales&&data.mode==='LIVE')fail(400,'Enable structured sales in DRAFT and validate it before switching to LIVE.');
  if(data.structuredSales&&!await Record.exists({kind:'knowledge',key:'generic_first_contact','data.schemaVersion':1}))fail(400,'Prepare structured knowledge before enabling this engine.');
  if(data.mode==='LIVE' && (!process.env.OPENAI_API_KEY || !(data.model || process.env.OPENAI_MODEL)))fail(400,'Configure OpenAI before enabling LIVE mode');
  for(const key of ['fallbackAgent','paymentAgent'])if(data[key]&&!await Staff.exists({_id:data[key],role:{$in:['CSS','SS']}}))fail(400,'Choose an available staff member');
  const saved=await Config.findOneAndUpdate({key:'main',revision:before.revision},{$set:{data,changedBy:req.actor.id},$inc:{revision:1}},{returnDocument:'after'});
  if(!saved)fail(409,'Initialize or reload settings first');
  if(data.mode!==before.data.mode)await Conversation.updateMany({},{$set:{'ai.pending':false,'ai.draft':null}});
  await Log.create({kind:'configuration',actor:req.actor.id,action:'config',before:before.data,after:data});res.json(saved);
}));
router.get('/records',wrap(async(req,res)=>{
  const query={};if(req.query.kind)query.kind=req.query.kind;
  if(req.query.priority!==undefined&&req.query.priority!=='')query.priority=Number(req.query.priority);
  if(req.query.category)query.category=String(req.query.category).slice(0,100);
  if(req.query.enabled==='true'||req.query.enabled==='false')query.enabled=req.query.enabled==='true';
  if(req.query.q)query.title={$regex:String(req.query.q).slice(0,100).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),$options:'i'};
  if(req.query.before)query._id={$lt:id(req.query.before)};
  const items=await Record.find(query).sort({_id:-1}).limit(51).lean();res.json({items:items.slice(0,50),next:items.length>50?String(items[49]._id):null});
}));
router.post('/records',wrap(async(req,res)=>{const item=settings.validateRecord(req.body);const record=await Record.create({...item,createdBy:req.actor.id,changedBy:req.actor.id});await Config.updateOne({key:'main'},{$inc:{revision:1}});await Log.create({kind:'configuration',actor:req.actor.id,action:'create_record',after:item});res.status(201).json(record);}));
router.put('/records/:id',wrap(async(req,res)=>{
  const before=await Record.findById(id(req.params.id)).lean();if(!before)fail(404,'Record not found');
  const item=settings.validateRecord({...req.body,kind:before.kind});
  const record=await Record.findOneAndUpdate({_id:before._id,revision:req.body.revision},{$set:{...item,changedBy:req.actor.id},$inc:{revision:1}},{returnDocument:'after'});if(!record)fail(409,'Record changed. Reload before saving');
  await Config.updateOne({key:'main'},{$inc:{revision:1}});
  await Log.create({kind:'configuration',actor:req.actor.id,action:'edit_record',before,after:item});res.json(record);
}));
router.post('/promote/:id',wrap(async(req,res)=>{
  const message=await Message.findById(id(req.params.id)).lean();if(!message || message.direction!=='outbound' || message.author==='ai' || sensitive(message.text))fail(400,'Choose a non-sensitive human response');
  const kind=req.body.kind;if(!['knowledge','tone','response'].includes(kind))fail(400,'Choose knowledge, tone or response');
  const record=await Record.create({kind,key:`review_${message._id}_${Date.now()}`,title:'Review staff response',enabled:false,createdBy:req.actor.id,data:kind==='knowledge'?{answer:redact(message.text),question:'',keywords:''}:kind==='tone'?{customer:'',response:redact(message.text)}:{message:redact(message.text),mode:'STRICT'}});
  await Log.create({kind:'configuration',actor:req.actor.id,action:'promote_for_review',after:{record:record._id,source:message._id}});res.json(record);
}));
router.post('/test',wrap(async(req,res)=>{
  if(typeof req.body.text!=='string' || !req.body.text.trim() || req.body.text.length>6000)fail(400,'Enter a message of up to 6000 characters');
  const config=await settings.getConfig();if(!req.body.structuredSales&&!config.data.structuredSales)await worker.budget(config.data,'admin-test');
  const state={};for(const key of [...settings.stateFields,...require('./structuredKnowledge').stateFields,'invoiceId','invoiceStatus','paymentStatus','paymentDetailsSentAt','quotedAmount','invoiceAmount','quoteSource','lastProgressionQuestionAt'])if(['string','number','boolean'].includes(typeof req.body.state?.[key]))state[key]=req.body.state[key];
  const history=Array.isArray(req.body.history)?req.body.history.slice(-12).filter(m=>m&&['inbound','outbound'].includes(m.direction)&&typeof m.text==='string').map(m=>({direction:m.direction,text:m.text.slice(0,4000)})):[];
  const testConfig={...config.data,structuredSales:req.body.structuredSales===true||config.data.structuredSales};
  const [records,knowledge]=await Promise.all([settings.catalogue(testConfig.structuredSales),settings.knowledge(req.body.text,state,testConfig.structuredSales)]);
  const result=await engine.decide({text:req.body.text,type:['image','audio','video','document','sticker','location'].includes(req.body.type)?req.body.type:'text',state,config:testConfig,records,knowledge,history,paymentVerified:req.body.verifiedPayment===true,invoiceRecord:state.invoiceId==='simulation-invoice'?{amount:state.invoiceAmount,status:'pending',expiresAt:new Date(Date.now()+3600000)}:null,reserveModelCall:()=>worker.budget(config.data,'admin-test')});
  if(result.action==='invoice'){result.state={...result.state,invoiceId:'simulation-invoice',invoiceAmount:result.amount,invoiceStatus:'sent',paymentStatus:'pending',paymentDetailsRequested:false,paymentDetailsSentAt:new Date().toISOString(),currentSalesStage:'PAYMENT_PENDING'};result.wouldGenerateInvoice=true;}
  await Log.create({kind:'test',actor:req.actor.id,action:result.action,mode:'TEST',intent:result.intent,decision:result.debug,handoff:result.handoff,text:redact(req.body.text),response:redact(result.response),before:state,after:result.state,usage:result.usage,configRevision:config.revision});
  res.json({...result,simulation:true,response:result.action==='invoice'?'Would generate an invoice using the approved amount; no invoice or payment account was created.':result.response});
}));
router.get('/logs',wrap(async(req,res)=>{
  const query={};for(const key of ['intent','service','handoff','actor','action','kind'])if(req.query[key])query[key]=String(req.query[key]).slice(0,100);
  for(const [key,field]of [['conversation','conversation'],['stage','after.currentSalesStage'],['platform','after.selectedPlatform'],['knowledge','decision.knowledge']])if(req.query[key])query[field]=key==='conversation'?id(req.query[key]):String(req.query[key]).slice(0,100);
  if(req.query.q){const pattern=String(req.query.q).slice(0,100).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const contacts=await require('../models').Contact.find({$or:[{name:{$regex:pattern,$options:'i'}},{phone:{$regex:pattern,$options:'i'}}]}).select('_id').limit(50).lean();const conversations=await Conversation.find({contact:{$in:contacts.map(c=>c._id)}}).select('_id').limit(100).lean();query.$or=[{text:{$regex:pattern,$options:'i'}},{response:{$regex:pattern,$options:'i'}},{conversation:{$in:conversations.map(c=>c._id)}}];}
  if(req.query.error==='true')query.error={$exists:true,$ne:''};
  if(req.query.before)query._id={$lt:id(req.query.before)};
  if(req.query.from||req.query.to){query.createdAt={};for(const [key,op]of [['from','$gte'],['to','$lte']])if(req.query[key]){const date=new Date(req.query[key]);if(!Number.isFinite(date.getTime()))fail(400,'Invalid date');query.createdAt[op]=date;}}
  const items=await Log.find(query).sort({_id:-1}).limit(51).lean();res.json({items:items.slice(0,50),next:items.length>50?String(items[49]._id):null});
}));
router.get('/usage',wrap(async(req,res)=>res.json(await Usage.find({key:{$regex:'^global:'}}).sort({key:-1}).limit(30).lean())));
module.exports=router;
