// Ephemeral DB only. No .env or external model/payment requests.
const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict'),mongoose=require('mongoose'),express=require('express');
const {MongoMemoryServer}=require('mongodb-memory-server');
const shadow=require('./shadow'),model=require('./model');
const {Contact,Conversation,Message,Notification}=require('../../models');
const {Log,Usage,Config}=require('../models');
const defaults=require('../defaults'),kb=require('../structuredKnowledge');
const original=model.call;let mongo,server,base;
const signal={value:false,evidence:{messageId:'',text:''}};
before(async()=>{
 mongo=await MongoMemoryServer.create();await mongoose.connect(mongo.getUri());
 await Promise.all([Contact,Conversation,Message,Notification,Log,Usage,Config,shadow.Job,shadow.Memory].map(m=>m.init()));
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.actor={admin:true,id:'admin'};next();});app.use('/ai',require('../routes'));
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;
});
beforeEach(async()=>{
 await Promise.all([Contact,Conversation,Message,Notification,Log,Usage,Config,shadow.Job,shadow.Memory].map(m=>m.deleteMany({})));
 model.call=async(phase,input,config,reserve)=>{
  await reserve?.();if(phase==='selection')return {model:'stub',value:{entries:[],unsupportedQuestions:[]}};
  if(phase==='grounding')return {model:'stub',value:require('./fixtures').grounding(input)};
  assert.equal(phase,'interpretation');
  return {model:'stub',usage:{total_tokens:10},value:{intents:['advertising'],questions:[],facts:[],answeredQuestionIds:[],recommendations:[],unresolvedReferences:[],negotiation:signal,deferral:signal,humanRequest:signal,paymentClaim:signal,sensitiveCase:signal,topic:'advertising',purchaseChange:{action:'none',path:'unchanged',evidence:signal.evidence},confidence:0.99}};
 };
});
after(async()=>{model.call=original;await new Promise(r=>server.close(r));await mongoose.disconnect();await mongo.stop();});
test('shadow is idempotent and cannot mutate live state or send/assign/create an invoice',async()=>{
 const contact=await Contact.create({phone:'+2348000000000',name:'Synthetic'});
 const c=await Conversation.create({contact:contact._id,ai:{state:{marker:'unchanged'}}});
 const m=await Message.create({conversation:c._id,type:'text',direction:'inbound',status:'received',text:'I want ads'});
 const args={text:m.text,messages:[m.toObject()],state:{},history:[],records:[...defaults.records,...kb.seeds],config:{...defaults.config,maxDailyCalls:0,maxConversationCalls:0},type:'text'};
 await shadow.enqueue(args,c._id,m._id,1,{action:'reply',response:'baseline'});await shadow.enqueue(args,c._id,m._id,1,{action:'reply',response:'baseline'});
 assert.equal(await shadow.Job.countDocuments(),1);
 await shadow.tick();await shadow.tick();
 assert.equal(await Message.countDocuments({direction:'outbound'}),0);assert.equal(await Notification.countDocuments(),0);
 assert.equal(await Log.countDocuments({kind:'shadow'}),1);assert.equal((await Conversation.findById(c._id)).ai.state.marker,'unchanged');
 assert.equal((await shadow.Job.findOne()).status,'done');assert.equal((await shadow.Memory.findOne({key:String(c._id)})).state.core.version,2);
});
test('V2 Test Agent preserves nested state and uses the same core without side effects',async()=>{
 await Config.create({key:'main',usageLimitsVersion:1,data:{...defaults.config,engineVersion:'v1'}});
 const state={core:{version:2,facts:{},superseded:[],items:[],topic:'advertising',purchasePath:'advertising',readiness:'undecided',answeredQuestions:[{id:'previous',answerMessageId:'customer'}],revision:1}};
 const response=await fetch(`${base}/ai/test`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({engineVersion:'v2',text:'I want ads',state,history:[]})});
 assert.equal(response.status,200);const result=await response.json();
 assert.equal(result.simulation,true);assert.equal(result.debug.engineVersion,'v2');assert.equal(result.state.core.answeredQuestions[0].id,'previous');
 assert.equal(await Message.countDocuments(),0);assert.equal(await Conversation.countDocuments(),0);
});
test('rollback prevents queued V2 output from being sent by the V1 engine',async()=>{
 await Config.create({key:'main',usageLimitsVersion:1,data:{...defaults.config,engineVersion:'v1',enabled:true,mode:'LIVE',autoReply:true}});
 const previous=process.env.AI_ENGINE_VERSION;delete process.env.AI_ENGINE_VERSION;
 try{assert.equal(await require('../worker').eligible({automation:{engineVersion:'v2'}}),false);}finally{if(previous!==undefined)process.env.AI_ENGINE_VERSION=previous;}
});

test('delivery persistence advances only successful current-selection sends and preserves paid truth',async()=>{
 const contact=await Contact.create({phone:'+2348000000001',name:'Synthetic'});
 const c=await Conversation.create({contact:contact._id,ai:{state:{core:{version:2,selectionVersion:4},currentSalesStage:'DISCOVERY'}}});
 const record=require('./delivery').record;
 const message={_id:new mongoose.Types.ObjectId(),conversation:c._id,sentAt:'2026-10-06T01:00:00Z',automation:{delivery:{selectionVersion:4,stage:'PAYMENT_PENDING',invoiceId:'synthetic'}}};
 await record({...message,status:'failed'});assert.equal((await Conversation.findById(c._id)).ai.state.currentSalesStage,'DISCOVERY');
 await record({...message,status:'sent'});let actual=(await Conversation.findById(c._id)).ai.state;assert.equal(actual.invoiceStatus,'sent');assert.equal(actual.paymentDetailsSentAt,'2026-10-06T01:00:00.000Z');
 await record({...message,status:'failed'});actual=(await Conversation.findById(c._id)).ai.state;assert.equal(actual.invoiceStatus,'prepared');assert.equal(actual.paymentDetailsSentAt,undefined);
 await record({...message,status:'sent'});
 await record({...message,status:'read',sentAt:'2026-10-06T01:01:00Z',automation:{delivery:{selectionVersion:3,stage:'PRICE_PRESENTED'}}});assert.equal((await Conversation.findById(c._id)).ai.state.currentSalesStage,'PAYMENT_PENDING');
 await Conversation.updateOne({_id:c._id},{$set:{'ai.state.paymentStatus':'paid','ai.state.currentSalesStage':'PAID'}});
 await record({...message,status:'delivered'});assert.equal((await Conversation.findById(c._id)).ai.state.currentSalesStage,'PAID');
});
