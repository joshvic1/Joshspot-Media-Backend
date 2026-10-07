// Ephemeral database, local HTTP and mocked model only; no dotenv or paid API.
process.env.MONGOMS_RUNTIME_DOWNLOAD='false';
const {test,before,beforeEach,after}=require('node:test'),assert=require('node:assert/strict');
const mongoose=require('mongoose'),express=require('express'),{MongoMemoryServer}=require('mongodb-memory-server');
const {Conversation,Message,Contact,Notification}=require('../../models'),{Config,Record,Log,Usage}=require('../models'),Invoice=require('../../../models/Invoice');
const model=require('./model'),original=model.client,worker=require('../worker'),defaults=require('../defaults');
let mongo,server,base,hook;
function fake(){return {pass:async(stage,input)=>{if(hook)await hook(stage,input);const m=input.current?.[0];return {value:stage==='interpreter'?{current_requests:[{id:'greeting',type:'OTHER',platform:'UNKNOWN',service:'UNKNOWN',evidence:{messageId:m.id,text:m.text}}],facts:[],purchase_change:{operation:'NONE',items:[],evidence:null},readiness:{value:'UNKNOWN',evidence:null},whole_purchase_cap:null,knowledge_needs:[],clarification:{needed:false,reason:'',missing_fields:[]}}:{message:'Hello, welcome.',unsupported_request_ids:[],covered_request_ids:['greeting'],questions_asked:[]},metrics:{stage,total_tokens:1,estimated_cost_usd:0}};}};}
before(async()=>{mongo=await MongoMemoryServer.create();await mongoose.connect(mongo.getUri());await Promise.all([Conversation,Message,Contact,Notification,Config,Record,Log,Usage,Invoice].map(m=>m.init()));const app=express();app.use(express.json());app.use((q,r,n)=>{q.actor={admin:true,id:'test-owner'};n();});app.use('/ai',require('../routes'));app.use((e,q,r,n)=>r.status(e.status||500).json({message:e.message}));server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}/ai`;});
beforeEach(async()=>{await Promise.all([Conversation,Message,Contact,Notification,Config,Record,Log,Usage,Invoice].map(m=>m.deleteMany({})));await Config.create({key:'main',revision:1,usageLimitsVersion:1,data:{...defaults.config,engineVersion:'v4',mode:'DRAFT'}});await Record.insertMany(defaults.records.map(r=>({...r,enabled:true,archived:false})));hook=null;model.client=fake;});
after(async()=>{model.client=original;await new Promise(r=>server.close(r));await mongoose.disconnect();await mongo.stop();});
const post=(url,body,method='POST')=>fetch(base+url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
async function setup(){const contact=await Contact.create({name:'Synthetic',phone:'+2348000000000'});const c=await Conversation.create({contact:contact._id,ai:{active:true,pending:true,pendingAt:new Date(Date.now()-20000),state:{old:'retain'},v3:{old:'retain'}}});const m=await Message.create({conversation:c._id,direction:'inbound',type:'text',status:'received',text:'Hello'});c.lastInboundId=m._id;c.lastInboundAt=new Date();await c.save();return {c,m};}
test('V4 Test Agent owns session, retains actual multi-turn history and has no production side effects',async()=>{const a=await(await post('/test',{engineVersion:'v4',text:'Hello',state:{purchaseItems:[{service:'forged'}]}})).json();assert.ok(a.v4SessionId);let observed;hook=async(stage,input)=>{if(stage==='interpreter')observed=input;};const b=await(await post('/test',{engineVersion:'v4',text:'Welcome',v4SessionId:a.v4SessionId})).json();assert.equal(b.v4SessionId,a.v4SessionId);assert.equal(observed.history.length,2);assert.deepEqual(observed.trusted.purchaseItems,[]);for(const m of [Message,Invoice,Conversation,Notification])assert.equal(await m.countDocuments(),0);assert.equal((await post('/test',{engineVersion:'v4',text:'Hello',v4SessionId:'not-owned'})).status,409);});
test('V4 DRAFT worker preserves old states and cannot send/create invoice',async()=>{const {c}=await setup();await worker.runOne(await require('../config').getConfig());const row=await Conversation.findById(c._id);assert.equal(row.ai.draft.engineVersion,'v4');assert.equal(row.ai.state.old,'retain');assert.equal(row.ai.v3.old,'retain');assert.ok(row.ai.v4);assert.equal(await Message.countDocuments({direction:'outbound'}),0);assert.equal(await Invoice.countDocuments(),0);});
test('TEST mode does not consume production pending messages',async()=>{const {c}=await setup();await Config.updateOne({key:'main'},{$set:{'data.mode':'TEST'}});assert.equal(await worker.runOne(await require('../config').getConfig()),false);assert.equal((await Conversation.findById(c._id)).ai.pending,true);});
test('takeover during composition cancels draft and outbound',async()=>{const {c}=await setup();hook=async stage=>{if(stage==='composer')await Conversation.updateOne({_id:c._id},{$set:{'ai.active':false},$inc:{'ai.version':1}});};await worker.runOne(await require('../config').getConfig());assert.equal((await Conversation.findById(c._id)).ai.draft,undefined);assert.equal(await Message.countDocuments({direction:'outbound'}),0);});
test('engine switch during interpretation cancels stale work; four choices save without deleting state',async()=>{const {c}=await setup();hook=async stage=>{if(stage==='interpreter')await Config.updateOne({key:'main'},{$set:{'data.engineVersion':'v1'},$inc:{revision:1}});};await worker.runOne(await require('../config').getConfig());assert.equal((await Conversation.findById(c._id)).ai.draft,undefined);hook=null;let revision=2;for(const engineVersion of ['v2','v3','v4','v1']){const r=await post('/config',{revision,data:{...defaults.config,engineVersion,mode:'DRAFT'}},'PUT');assert.equal(r.status,200);revision++;}assert.equal((await Conversation.findById(c._id)).ai.v3.old,'retain');});
test('V4 simulated invoice draft cannot send; LIVE save requires explicit approval',async()=>{const {c,m}=await setup();await Conversation.updateOne({_id:c._id},{$set:{'ai.draft':{engineVersion:'v4',wouldGenerateInvoice:true,inputId:String(m._id),configRevision:1,response:'Test',action:'reply'}}});assert.equal((await post(`/conversations/${c._id}/draft`,{action:'send'})).status,409);assert.equal((await post('/config',{revision:1,data:{...defaults.config,engineVersion:'v4',mode:'LIVE'}},'PUT')).status,400);assert.equal(await Invoice.countDocuments(),0);});
test('V4 test handoff stops follow-up AI without actual assignments',async()=>{const a=await(await post('/test',{engineVersion:'v4',text:'Audio',type:'audio'})).json();assert.equal(a.action,'handoff');assert.equal((await post('/test',{engineVersion:'v4',text:'Hello',v4SessionId:a.v4SessionId})).status,409);assert.equal(await Notification.countDocuments(),0);});

test('mocked LIVE handoff assigns before composing and queues exactly one guarded acknowledgement',async()=>{
 const Staff=require('../../../models/Staff'),previous=process.env.AI_V4_LIVE_APPROVED;
 try{
  process.env.AI_V4_LIVE_APPROVED='1';
  const staff=await Staff.create({name:'Synthetic support',email:'v4-test@example.test',password:'not-a-real-password',role:'CSS'});
  await Config.updateOne({key:'main'},{$set:{'data.mode':'LIVE','data.autoReply':true,'data.handoffTeam':'CSS'}});
  const {c}=await setup();let composed=0;
  model.client=()=>({pass:async(stage,input)=>{
   if(stage==='interpreter'){const r=await fake().pass(stage,input);r.value.current_requests[0].type='REQUEST_HUMAN';return r;}
   composed++;const row=await Conversation.findById(c._id);assert.equal(String(row.assignedTo),String(staff._id));assert.equal(row.ai.active,false);assert.equal(input.actions.handoff.accepted,true);
   return {value:{message:'A team member will help you shortly.',unsupported_request_ids:[],covered_request_ids:['greeting'],questions_asked:[]},metrics:{stage,total_tokens:1,estimated_cost_usd:0}};
  }});
  await worker.runOne(await require('../config').getConfig());assert.equal(composed,1);
  const outgoing=await Message.find({direction:'outbound'});assert.equal(outgoing.length,1);assert.equal(outgoing[0].automation.engineVersion,'v4');assert.equal(await worker.eligible(outgoing[0]),true);
  await Config.updateOne({key:'main'},{$set:{'data.engineVersion':'v1'},$inc:{revision:1}});assert.equal(await worker.eligible(outgoing[0]),false);
 }finally{await Staff.deleteMany({email:'v4-test@example.test'});if(previous===undefined)delete process.env.AI_V4_LIVE_APPROVED;else process.env.AI_V4_LIVE_APPROVED=previous;}
});
test('missing knowledge invokes actual assignment infrastructure and queues only fallback in isolated DB',async()=>{
 const Staff=require('../../../models/Staff'),previous=process.env.AI_V4_LIVE_APPROVED;
 try{
  process.env.AI_V4_LIVE_APPROVED='1';
  const staff=await Staff.create({name:'Synthetic knowledge support',email:'v4-knowledge@example.test',password:'synthetic',role:'CSS'});
  await Config.updateOne({key:'main'},{$set:{'data.mode':'LIVE','data.autoReply':true,'data.handoffTeam':'CSS'}});
  await Record.deleteMany({kind:'knowledge'});const {c}=await setup();let calls=0;
  model.client=()=>({pass:async(stage,input)=>{calls++;assert.equal(stage,'interpreter');const r=await fake().pass(stage,input);r.value.current_requests[0].type='ASK_TECHNICAL_HELP';return r;}});
  await worker.runOne(await require('../config').getConfig());
  const row=await Conversation.findById(c._id);assert.equal(String(row.assignedTo),String(staff._id));assert.equal(row.ai.active,false);assert.equal(row.ai.handoffReason,'NO_APPROVED_KNOWLEDGE');assert.equal(calls,1);
  const outgoing=await Message.find({direction:'outbound'});assert.equal(outgoing.length,1);assert.equal(outgoing[0].text,defaults.config.fallbackResponse);assert.equal(await worker.eligible(outgoing[0]),true);assert.equal(await Invoice.countDocuments(),0);
 }finally{await Staff.deleteMany({email:'v4-knowledge@example.test'});if(previous===undefined)delete process.env.AI_V4_LIVE_APPROVED;else process.env.AI_V4_LIVE_APPROVED=previous;}
});

test('financial adapter reuses existing generator idempotently in ephemeral DB; provider is stubbed',async()=>{
 const invoiceController=require('../../../controllers/invoiceController'),originalGenerate=invoiceController.generateInvoiceTransfer;
 const names=['AI_V4_LIVE_APPROVED','PAYSTACK_SECRET','CLIENT_URL'],previous=Object.fromEntries(names.map(k=>[k,process.env[k]]));let calls=0;
 try{
  process.env.AI_V4_LIVE_APPROVED='1';process.env.PAYSTACK_SECRET='synthetic-test-only';process.env.CLIENT_URL='https://example.test';
  invoiceController.generateInvoiceTransfer=async row=>{calls++;row.accountNumber='1234567890';row.accountName='Synthetic Merchant';row.bankName='Synthetic Bank';row.reference='synthetic-ref';row.status='pending';await row.save();return row;};
  const {c}=await setup();await c.populate('contact');
  const q=await require('../v3/pricing').quote([{platform:'tiktok',service:'account_setup',budgetBasis:null,budget:null,duration:null,planKey:null,creativeMode:'testing',creatives:1}],defaults.records);
  const args={conversation:c,quote:q,config:{...defaults.config,mode:'LIVE',autoReply:true,invoicesEnabled:true},assertCurrent:async()=>{}};
  const first=await require('./financial').createInvoice(args),again=await require('./financial').createInvoice(args);assert.equal(first.id,again.id);assert.equal(calls,1);assert.equal(await Invoice.countDocuments(),1);
  await assert.rejects(require('./financial').createInvoice({...args,quote:{...q,fingerprint:'different'}}),/EXISTING_INVOICE/);
  await assert.rejects(require('./financial').createInvoice({...args,assertCurrent:async()=>{throw new Error('takeover');}}),/takeover/);assert.equal(calls,1);
 }finally{invoiceController.generateInvoiceTransfer=originalGenerate;for(const k of names)if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];}
});

