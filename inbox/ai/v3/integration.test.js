// Ephemeral MongoDB + mocked OpenAI only. Deliberately never loads dotenv.
process.env.MONGOMS_RUNTIME_DOWNLOAD='false';
const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict'),mongoose=require('mongoose'),express=require('express');
const {MongoMemoryServer}=require('mongodb-memory-server');
const {Contact,Conversation,Message,Notification}=require('../../models');
const {Config,Record,Log,Usage}=require('../models');
const Invoice=require('../../../models/Invoice');
const defaults=require('../defaults'),openai=require('./openai'),worker=require('../worker');
const {fakeOpenai}=require('./fakeOpenai.test-helper');
const original=openai.client;let mongo,server,base,api;
before(async()=>{
 mongo=await MongoMemoryServer.create();await mongoose.connect(mongo.getUri());
 await Promise.all([Contact,Conversation,Message,Notification,Config,Record,Log,Usage,Invoice].map(m=>m.init()));
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.actor={admin:true,id:'admin-test'};next();});app.use('/ai',require('../routes'));app.use((e,req,res,next)=>res.status(e.status||500).json({message:e.message}));
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;
});
beforeEach(async()=>{
 await Promise.all([Contact,Conversation,Message,Notification,Config,Record,Log,Usage,Invoice].map(m=>m.deleteMany({})));
 await Config.create({key:'main',usageLimitsVersion:1,revision:1,data:{...defaults.config,engineVersion:'v3',mode:'DRAFT'}});
 await Record.insertMany(defaults.records.map(r=>({...r,enabled:true,archived:false})));
 api=fakeOpenai();openai.client=()=>api;
});
after(async()=>{openai.client=original;await new Promise(r=>server.close(r));await mongoose.disconnect();await mongo.stop();});
async function setup(){
 const contact=await Contact.create({phone:'+2348000000000',name:'Synthetic'});
 const c=await Conversation.create({contact:contact._id,ai:{active:true,pending:true,pendingAt:new Date(Date.now()-10000),state:{legacy:'preserve'}}});
 const m=await Message.create({conversation:c._id,type:'text',direction:'inbound',status:'received',text:'Hello'});
 c.lastInboundId=m._id;c.lastInboundAt=new Date();await c.save();return {c,m};
}
test('Test Agent keeps server-owned multi-turn context, no real side effects',async()=>{
 const post=body=>fetch(base+'/ai/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const a=await (await post({engineVersion:'v3',text:'Hi',state:{openaiConversationId:'forged'}})).json();assert.ok(a.v3SessionId);
 const b=await (await post({engineVersion:'v3',text:'Management please',v3SessionId:a.v3SessionId})).json();assert.equal(a.debug.openaiConversationId,b.debug.openaiConversationId);
 assert.equal(await Invoice.countDocuments(),0);assert.equal(await Message.countDocuments(),0);assert.equal(await Conversation.countDocuments(),0);assert.equal(await Notification.countDocuments(),0);
 assert.equal((await post({engineVersion:'v3',text:'Hi',v3SessionId:'someone-else'})).status,409);
});
test('real worker routes V3 DRAFT; preserves V1 state and creates no outbound',async()=>{
 const {c}=await setup();await worker.runOne(await require('../config').getConfig());
 const updated=await Conversation.findById(c._id);assert.equal(updated.ai.draft.engineVersion,'v3');assert.ok(updated.ai.v3.openaiConversationId);assert.equal(updated.ai.state.legacy,'preserve');assert.equal(updated.ai.pending,false);
 assert.equal(await Message.countDocuments({direction:'outbound'}),0);assert.equal(await Invoice.countDocuments(),0);assert.equal(await Notification.countDocuments(),0);
});

test('Test Agent stops autonomous continuation after a simulated human handoff',async()=>{
 const post=body=>fetch(base+'/ai/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const first=await (await post({engineVersion:'v3',text:'[voice message]',type:'audio'})).json();assert.equal(first.action,'handoff');
 const next=await post({engineVersion:'v3',text:'Are you there?',v3SessionId:first.v3SessionId});assert.equal(next.status,409);
 assert.equal(await Message.countDocuments(),0);assert.equal(await Notification.countDocuments(),0);assert.equal(await Conversation.countDocuments(),0);
});
test('simulated invoice draft cannot be approved as real payment details',async()=>{
 const {c,m}=await setup();await Conversation.updateOne({_id:c._id},{$set:{'ai.draft':{engineVersion:'v3',wouldGenerateInvoice:true,inputId:String(m._id),response:'Simulation',action:'reply',configRevision:1}}});
 const r=await fetch(base+`/ai/conversations/${c._id}/draft`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'send'})});assert.equal(r.status,409);assert.equal(await Invoice.countDocuments(),0);assert.equal(await Message.countDocuments({direction:'outbound'}),0);
});
test('worker discards a response after human takeover during model generation',async()=>{
 const {c}=await setup();api=fakeOpenai([async()=>{await Conversation.updateOne({_id:c._id},{$set:{'ai.active':false},$inc:{'ai.version':1}});return {output:[{type:'message',content:[{type:'output_text',text:'Must not deliver'}]}]};}]);
 await worker.runOne(await require('../config').getConfig());const updated=await Conversation.findById(c._id);assert.equal(updated.ai.draft,undefined);assert.equal(await Message.countDocuments({direction:'outbound'}),0);
});
test('V3 logs resolve current outbox delivery status without another response authority',async()=>{
 const {c,m}=await setup();await Log.create({conversation:c._id,inputIds:[m._id],kind:'decision',decision:{engineVersion:'v3',delivery:'QUEUED'}});
 await Message.create({conversation:c._id,type:'text',direction:'outbound',text:'Synthetic reply',status:'failed',error:'Ownership changed',automation:{engineVersion:'v3',inputId:m._id}});
 const r=await (await fetch(base+'/ai/logs')).json();assert.equal(r.items[0].decision.deliveryRecord.status,'failed');
});
test('switching engine while model runs discards stale response without deleting engine memory',async()=>{
 const {c}=await setup();api=fakeOpenai([async()=>{await Config.updateOne({key:'main'},{$set:{'data.engineVersion':'v1'},$inc:{revision:1}});return {output:[{type:'message',content:[{type:'output_text',text:'Stale response'}]}]};}]);
 await worker.runOne(await require('../config').getConfig());const updated=await Conversation.findById(c._id);assert.equal(updated.ai.draft,undefined);assert.ok(updated.ai.v3.openaiConversationId);assert.equal(updated.ai.state.legacy,'preserve');
});
test('V3 queued message cannot send after switching to V1; LIVE save requires explicit gate',async()=>{
 const {c,m}=await setup();await Config.updateOne({key:'main'},{$set:{'data.engineVersion':'v1','data.mode':'LIVE'}});
 assert.equal(await worker.eligible({conversation:c._id,automation:{engineVersion:'v3',version:c.ai.version,inputId:m._id,configRevision:1}}),false);
 const r=await fetch(base+'/ai/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:1,data:{...defaults.config,engineVersion:'v3',mode:'LIVE'}})});assert.equal(r.status,400);
});
test('financial adapter reuses existing generator idempotently in ephemeral DB; provider is stubbed',async()=>{
 const invoiceController=require('../../../controllers/invoiceController'),originalGenerate=invoiceController.generateInvoiceTransfer;
 const names=['AI_V3_LIVE_APPROVED','PAYSTACK_SECRET','CLIENT_URL'],previous=Object.fromEntries(names.map(k=>[k,process.env[k]]));let calls=0;
 try{
  delete process.env.AI_V3_LIVE_APPROVED;process.env.PAYSTACK_SECRET='synthetic-test-only';process.env.CLIENT_URL='https://example.test';
  invoiceController.generateInvoiceTransfer=async row=>{calls++;row.accountNumber='1234567890';row.accountName='Synthetic Merchant';row.bankName='Synthetic Bank';row.reference='synthetic-ref';row.status='pending';await row.save();return row;};
  const {c}=await setup();await c.populate('contact');
  const q=await require('./pricing').quote([{platform:'tiktok',service:'account_setup',budgetBasis:null,budget:null,duration:null,planKey:null,creativeMode:'testing',creatives:1}],defaults.records);
  const args={conversation:c,quote:q,config:{...defaults.config,mode:'LIVE',autoReply:true,invoicesEnabled:true},assertCurrent:async()=>{}};
  const first=await require('./financial').createInvoice(args),again=await require('./financial').createInvoice(args);assert.equal(first.id,again.id);assert.equal(calls,1);assert.equal(await Invoice.countDocuments(),1);
  await assert.rejects(require('./financial').createInvoice({...args,quote:{...q,fingerprint:'different'}}),/EXISTING_INVOICE/);
  await assert.rejects(require('./financial').createInvoice({...args,assertCurrent:async()=>{throw new Error('takeover');}}),/takeover/);assert.equal(calls,1);
 }finally{invoiceController.generateInvoiceTransfer=originalGenerate;for(const k of names)if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];}
});
