// Ephemeral database and stubbed provider only. Never loads .env or contacts Meta.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { DeletionGuard, Contact, Conversation, Message, Template, WebhookJob, RateBucket, Notification, Media } = require('./models');
const Staff = require('../models/Staff');
const aiModels = require('./ai/models');
const aiProvider = require('./ai/provider');
const aiWorker = require('./ai/worker');
const aiSettings = require('./ai/config');
const Invoice = require('../models/Invoice');
const service = require('./service');
const provider = require('./provider');
let mongo, server, base, agent, second, tokens, sent;
const providerOriginal = { ...provider };
before(async () => {
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  for (const key of ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_BUSINESS_ACCOUNT_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN']) process.env[key] = `test-${key}`;
  process.env.WHATSAPP_GRAPH_VERSION = 'v23.0';
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([DeletionGuard, Contact, Conversation, Message, Template, WebhookJob, RateBucket, Staff, Notification, Media, Invoice, ...Object.values(aiModels)].map((model) => model.init()));
  const app = express(); app.use(express.json({ limit: "10mb", verify: (req, res, raw) => { req.rawBody = raw; } })); app.use('/inbox', require('./routes'));
  server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/inbox`;
}, { timeout: 300000 });
after(async () => { Object.assign(provider, providerOriginal); if (server) await new Promise((resolve) => server.close(resolve)); await mongoose.disconnect(); if (mongo) await mongo.stop(); });
beforeEach(async () => {
  await Promise.all([DeletionGuard, Contact, Conversation, Message, Template, WebhookJob, RateBucket, Staff, Notification, Media, Invoice, ...Object.values(aiModels)].map((model) => model.deleteMany({})));
  agent = await Staff.create({ name: 'Agent One', email: 'one@example.test', password: 'not-a-real-password', role: 'SS' });
  second = await Staff.create({ name: 'Agent Two', email: 'two@example.test', password: 'not-a-real-password', role: 'CSS' });
  const restricted = await Staff.create({ name: 'Restricted', email: 'restricted@example.test', password: 'not-a-real-password', role: 'SES' });
  const token = (staff) => jwt.sign({ staffId: String(staff._id), name: staff.name, role: staff.role }, process.env.JWT_SECRET);
  tokens = { admin: jwt.sign({ admin: true }, process.env.JWT_SECRET), agent: token(agent), second: token(second), restricted: token(restricted) };
  aiProvider.interpret = async () => ({ intent: 'advertising', confidence: .99, platform: 'tiktok', serviceType: 'account_setup', budget: null, duration: null, model: 'stub', usage: { total_tokens: 12 } });
  sent = [];
  provider.send = async (to, message) => { sent.push({ to, message }); return `wamid.test-${message._id}-${message.attempts}`; };
  provider.upload = async () => 'test-upload';
  provider.react = async (to, messageId, emoji) => { sent.push({ to, messageId, emoji }); return 'wamid.reaction'; };
});
async function request(path, { role = 'admin', method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(role ? { Authorization: `Bearer ${tokens[role]}` } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, data: await response.json().catch(() => null) };
}
function inbound(externalId = 'wamid.inbound', seconds = Math.floor(Date.now() / 1000)) {
  return { metadata: { phone_number_id: process.env.WHATSAPP_PHONE_NUMBER_ID }, contacts: [{ wa_id: '2348012345678', profile: { name: 'Ada Customer' } }], messages: [{ id: externalId, from: '2348012345678', timestamp: String(seconds), type: 'text', text: { body: 'Can you help with the WhatsApp course?' } }] };
}
async function fixture(assigned = true) {
  await service.receive(inbound()); const conversation = await Conversation.findOne();
  if (assigned) { conversation.assignedTo = agent._id; await conversation.save(); }
  return conversation;
}
const outgoing = (text = 'Hello Ada') => ({ type: 'text', text, clientId: crypto.randomUUID() });

test('admin deletion purges Inbox data and saved media but preserves invoices and other customers',async()=>{
 const c=await fixture();const contact=await Contact.findById(c.contact);
 const other=await Contact.create({phone:'2348012345679',name:'Other customer'});const otherChat=await Conversation.create({contact:other._id});
 const otherMessage=await Message.create({conversation:otherChat._id,direction:'inbound',type:'text',text:'Keep this'});
 const note=await Message.create({conversation:c._id,direction:'internal',type:'note',text:'Private note'});
 await Notification.create({recipient:agent._id,conversation:c._id,message:note._id});
 await aiModels.Log.create({conversation:c._id,text:'Private AI context'});await aiModels.Usage.create({key:`${c._id}:today`});
 const invoice=await Invoice.create({token:crypto.randomUUID(),amount:20000,customerPhone:contact.phone,inboxConversation:c._id});
 const asset=await Media.create({conversation:c._id,source:'fixture',key:'joshspot-inbox/v1/012345678901234567890123',state:'ready'});
 const payload={entry:[{changes:[{field:'messages',value:{...inbound(),contacts:[{wa_id:contact.phone,profile:{name:'Delete me'}},{wa_id:other.phone,profile:{name:'Keep me'}}],messages:[...inbound().messages,{id:'other',from:other.phone,type:'text',text:{body:'Keep me'}}]}}]}]};
 await WebhookJob.create({key:'delete-test',payload,state:'done'});
 const storage=require('./mediaStorage');const original=storage.remove;const removed=[];storage.remove=async key=>removed.push(key);
 try{
  assert.equal((await request(`/conversations/${c._id}`,{role:'agent',method:'DELETE',body:{confirm:true}})).status,403);
  assert.equal((await request(`/conversations/${c._id}`,{method:'DELETE',body:{}})).status,400);
  assert.equal((await request(`/conversations/${c._id}`,{method:'DELETE',body:{confirm:true}})).status,200);
  assert.equal(await Contact.exists({_id:contact._id}),null);assert.equal(await Conversation.exists({_id:c._id}),null);
  for(const model of [Message,Notification,Media,aiModels.Log])assert.equal(await model.countDocuments({conversation:c._id}),0);
  assert.equal(await aiModels.Usage.countDocuments({key:`${c._id}:today`}),0);
  assert.ok(await Invoice.exists({_id:invoice._id}));assert.ok(await Message.exists({_id:otherMessage._id}));assert.deepEqual(removed,[asset.key]);
  const retained=JSON.stringify((await WebhookJob.findOne({key:'delete-test'})).payload);assert.equal(retained.includes(contact.phone),false);assert.ok(retained.includes(other.phone));
  await service.receive(inbound());assert.equal(await Conversation.exists({_id:c._id}),null);assert.equal(await Contact.countDocuments({phone:contact.phone}),0);
  await service.enqueueWebhook(Buffer.from('late-retry'),{entry:[{changes:[{field:'messages',value:inbound()}]}]});
  assert.equal(JSON.stringify((await WebhookJob.findOne({key:crypto.createHash('sha256').update('late-retry').digest('hex')})).payload).includes(contact.phone),false);
  const next=inbound('brand-new',Math.floor(Date.now()/1000)+2);await service.receive(next);assert.equal(await Contact.countDocuments({phone:contact.phone}),1);assert.equal(await Message.countDocuments({providerId:'brand-new'}),1);
  assert.equal((await request(`/conversations/${c._id}`,{method:'DELETE',body:{confirm:true}})).status,200);
 }finally{storage.remove=original;}
});

async function aiFixture(mode='DRAFT') {
  await aiSettings.seed('admin');
  await aiModels.Config.updateOne({key:'main'},{$set:{'data.mode':mode,'data.responseDelaySeconds':0}});
  const c=await fixture(false);await Conversation.updateOne({_id:c._id},{$set:{'ai.pendingAt':new Date(Date.now()-20000)}});
  return c;
}
test('AI configuration is admin-only and initialization is idempotent DRAFT',async()=>{
  assert.equal((await request('/ai/config',{role:'agent'})).status,403);
  assert.equal((await request('/ai/initialize',{method:'POST',body:{}})).data.data.mode,'DRAFT');
  await request('/ai/initialize',{method:'POST',body:{}});
  assert.equal(await aiModels.Record.countDocuments({kind:'plan'}),4);
  assert.equal(await aiModels.Config.countDocuments(),1);
});
test('AI DRAFT persists a suggestion, does not send, and duplicate webhooks do not regenerate',async()=>{
  const c=await aiFixture();let calls=0;const interpret=aiProvider.interpret;aiProvider.interpret=async args=>{calls++;return interpret(args);};
  const config=await aiSettings.getConfig();await aiWorker.runOne(config);
  let current=await Conversation.findById(c._id);assert.match(current.ai.draft.response,/20,000/);assert.equal(await Message.countDocuments({author:'ai',direction:'outbound'}),0);
  await service.receive(inbound());await aiWorker.runOne(config);assert.equal(calls,1);
  assert.equal((await request(`/ai/conversations/${c._id}/draft`,{method:'POST',body:{action:'send'}})).status,200);
  await service.processOutbox();assert.equal(sent.length,1);assert.match(sent[0].message.text,/20,000/);
});
test('AI LIVE uses existing outbox and takeover cancels queued output',async()=>{
  const c=await aiFixture('LIVE');await aiWorker.runOne(await aiSettings.getConfig());
  assert.equal(await Message.countDocuments({author:'ai',status:'queued'}),1);
  await request(`/ai/conversations/${c._id}/control`,{method:'POST',body:{action:'takeover'}});
  await service.processOutbox();assert.equal(sent.length,0);
});
test('AI LIVE delivers normally and human takeover during generation suppresses output',async()=>{
  const c=await aiFixture('LIVE');await aiWorker.runOne(await aiSettings.getConfig());await service.processOutbox();assert.equal(sent.length,1);
  await service.receive(inbound('wamid.next'));await Conversation.updateOne({_id:c._id},{$set:{'ai.pendingAt':new Date(Date.now()-20000)}});
  const interpret=aiProvider.interpret;aiProvider.interpret=async args=>{await aiWorker.pause(c._id,{id:'admin',admin:true});return interpret(args);};
  await aiWorker.runOne(await aiSettings.getConfig());assert.equal(await Message.countDocuments({author:'ai',direction:'outbound'}),1);
});
test('AI batches rapid messages and media/errors hand off without sending content to model',async()=>{
  const c=await aiFixture();await service.receive(inbound('wamid.second'));await service.receive(inbound('wamid.third'));
  await Conversation.updateOne({_id:c._id},{$set:{'ai.pendingAt':new Date(Date.now()-20000)}});
  let count=0;const interpret=aiProvider.interpret;aiProvider.interpret=async args=>{count++;assert.equal(args.text.split('\n').length,3);return interpret(args);};
  await aiWorker.runOne(await aiSettings.getConfig());assert.equal(count,1);
  const payload=inbound('wamid.image');payload.messages[0].type='image';payload.messages[0].image={id:'media-id'};await service.receive(payload);
  await Conversation.updateOne({_id:c._id},{$set:{'ai.pendingAt':new Date(Date.now()-20000)}});await aiWorker.runOne(await aiSettings.getConfig());
  const current=await Conversation.findById(c._id);assert.equal(count,1);assert.equal(current.ai.handoffReason,'MEDIA_RECEIVED');assert.equal(String(current.assignedTo),String(second._id));assert.equal(await Notification.countDocuments({conversation:c._id}),1);
});
test('AI provider failures and sensitive text preserve input and route to a human',async()=>{
  const c=await aiFixture();aiProvider.interpret=async()=>{throw new Error('timeout');};await aiWorker.runOne(await aiSettings.getConfig());
  assert.equal((await Conversation.findById(c._id)).ai.handoffReason,'AI_PROCESSING_ERROR');assert.equal(await Message.countDocuments({direction:'inbound'}),1);
  await request(`/ai/conversations/${c._id}/control`,{method:'POST',body:{action:'return'}});
  const payload=inbound('wamid.secret');payload.messages[0].text.body='my password is TOP_SECRET';await service.receive(payload);await Conversation.updateOne({_id:c._id},{$set:{'ai.pendingAt':new Date(Date.now()-20000)}});await aiWorker.runOne(await aiSettings.getConfig());
  assert.equal((await Conversation.findById(c._id)).ai.handoffReason,'SENSITIVE_CASE');assert.equal(JSON.stringify(await aiModels.Log.find()).includes('TOP_SECRET'),false);
});
test('AI test mode performs no invoice or WhatsApp writes; unavailable invoice generation hands off',async()=>{
  const c=await aiFixture('LIVE');await aiModels.Config.updateOne({key:'main'},{$set:{'data.invoicesEnabled':true}});
  aiProvider.interpret=async()=>({intent:'ready_to_pay',confidence:1,platform:'tiktok',serviceType:'account_setup',budget:null,duration:null});
  const simulated=await request('/ai/test',{method:'POST',body:{text:'Send invoice'}});assert.equal(simulated.status,200);assert.equal(simulated.data.action,'invoice');assert.equal(await Invoice.countDocuments(),0);
  await aiWorker.runOne(await aiSettings.getConfig());assert.equal((await Conversation.findById(c._id)).ai.handoffReason,'INVOICE_ERROR');assert.equal(sent.length,0);
});
test('AI invoice action reuses the existing Invoice and account and never retries uncertain account creation',async()=>{
  const c=await aiFixture();await c.populate('contact');
  const service=require('../controllers/invoiceController');const original=service.generateInvoiceTransfer;let calls=0;
  const oldSecret=process.env.PAYSTACK_SECRET,oldUrl=process.env.CLIENT_URL;process.env.PAYSTACK_SECRET='fake';process.env.CLIENT_URL='https://example.test';
  const args={conversation:c,contact:c.contact,result:{amount:20000,serviceKey:'tiktok_setup',state:{selectedPlatform:'tiktok'}},config:{...(await aiSettings.getConfig()).data,invoicesEnabled:true}};
  try{
    service.generateInvoiceTransfer=async invoice=>{calls++;invoice.accountNumber='0000000000';invoice.accountName='Fixture Merchant';invoice.bankName='Fixture Bank';invoice.reference='fixture-reference';invoice.status='pending';return invoice.save();};
    const first=await require('./ai/invoices').generate(args);const second=await require('./ai/invoices').generate(args);
    assert.equal(first.invoiceId,second.invoiceId);assert.equal(calls,1);assert.equal(await Invoice.countDocuments(),1);assert.match(first.response,/0000000000/);
    service.generateInvoiceTransfer=async()=>{calls++;throw new Error('timeout');};
    const other={...args,result:{...args.result,amount:30000}};
    await assert.rejects(require('./ai/invoices').generate(other));await assert.rejects(require('./ai/invoices').generate(other));assert.equal(calls,2);
  }finally{service.generateInvoiceTransfer=original;if(oldSecret)process.env.PAYSTACK_SECRET=oldSecret;else delete process.env.PAYSTACK_SECRET;if(oldUrl)process.env.CLIENT_URL=oldUrl;else delete process.env.CLIENT_URL;}
});
test('AI worker lease prevents two workers generating for one conversation',async()=>{
  await aiFixture();const config=await aiSettings.getConfig();let calls=0;const interpret=aiProvider.interpret;aiProvider.interpret=async args=>{calls++;await new Promise(r=>setTimeout(r,30));return interpret(args);};
  await Promise.all([aiWorker.runOne(config),aiWorker.runOne(config)]);assert.equal(calls,1);
});
test('AI limits report their exact reason and blocked attempts do not inflate counters',async()=>{
 const c=await aiFixture('LIVE');const day=new Date().toISOString().slice(0,10);
 const config={...(await aiSettings.getConfig()).data,maxDailyCalls:2,maxConversationCalls:1};
 await aiWorker.budget(config,c._id);
 for(let i=0;i<3;i++)await assert.rejects(aiWorker.budget(config,c._id),{code:'AI_CONVERSATION_LIMIT'});
 assert.equal((await aiModels.Usage.findOne({key:`global:${day}`})).calls,1);
 assert.equal((await aiModels.Usage.findOne({key:`${c._id}:${day}`})).calls,1);
 await aiWorker.budget(config,'another');
 await assert.rejects(aiWorker.budget(config,'third'),{code:'AI_DAILY_LIMIT'});
 assert.equal((await aiModels.Usage.findOne({key:`third:${day}`})).calls,0);
 assert.equal((await aiModels.Usage.findOne({key:`global:${day}`})).calls,2);
 await aiModels.Config.updateOne({key:'main'},{$set:{'data.maxDailyCalls':2}});
 aiProvider.interpret=()=>{throw Error('Provider must not be called after the limit');};
 await aiWorker.runOne(await aiSettings.getConfig());
 assert.equal((await Conversation.findById(c._id)).ai.handoffReason,'AI_DAILY_LIMIT');
 assert.match((await aiModels.Log.findOne({conversation:c._id,kind:'decision'})).error,/Daily AI request limit reached/);
});

test('business pack installs all approved entries once and preserves rollout and prices',async()=>{
 await aiSettings.seed('admin');await aiModels.Config.updateOne({key:'main'},{$set:{'data.mode':'OFF','data.model':'existing-model'}});
 await aiModels.Record.updateOne({key:'tiktok_setup'},{$set:{'data.price':22000}});
 const install=require('./ai/installBusinessPack').install;
 assert.equal((await install('admin')).knowledge,34);
 assert.equal(await aiModels.Record.countDocuments({kind:'knowledge'}),34);
 assert.equal((await aiSettings.getConfig()).data.mode,'OFF');
 assert.equal((await aiModels.Record.findOne({key:'tiktok_setup'})).data.price,22000);
 await aiModels.Record.updateOne({key:'advertising_services'},{$set:{'data.answer':'Later admin edit'}});
 assert.equal((await install('admin')).installed,false);
 assert.equal((await aiModels.Record.findOne({key:'advertising_services'})).data.answer,'Later admin edit');
 assert.equal((await request('/ai/business-pack',{role:'agent',method:'POST',body:{}})).status,403);
});
test('LIVE human request assigns CSS immediately, notifies once and sends only one handoff response',async()=>{
 const c=await aiFixture('LIVE');const original=aiProvider.interpret;
 aiProvider.interpret=async args=>({...await original(args),intent:'human'});
 await aiWorker.runOne(await aiSettings.getConfig());
 let current=await Conversation.findById(c._id);
 assert.equal(String(current.assignedTo),String(second._id));assert.equal(current.ai.active,false);assert.equal(current.ai.handoffReason,'CUSTOMER_REQUESTED_HUMAN');
 assert.equal(await Notification.countDocuments({recipient:second._id}),1);
 await service.processOutbox();assert.equal(sent.length,1);assert.ok(sent[0].message.text);
 await service.receive(inbound('wamid.followup'));await Conversation.updateOne({_id:c._id},{$set:{'ai.pendingAt':new Date(0)}});
 await aiWorker.runOne(await aiSettings.getConfig());await service.processOutbox();assert.equal(sent.length,1);
});
test('DRAFT human request is assigned to CSS without automatic sending and CSS can approve it',async()=>{
 const c=await aiFixture();const original=aiProvider.interpret;aiProvider.interpret=async args=>({...await original(args),intent:'human'});
 await aiWorker.runOne(await aiSettings.getConfig());const current=await Conversation.findById(c._id);
 assert.equal(String(current.assignedTo),String(second._id));assert.equal(current.ai.draft.mode,'DRAFT');assert.equal(await Message.countDocuments({direction:'outbound'}),0);
 assert.equal((await request(`/ai/conversations/${c._id}/draft`,{role:'second',method:'POST',body:{action:'send'}})).status,200);
 await service.processOutbox();assert.equal(sent.length,1);
});
test('missing fallback chooses CSS and absent CSS remains visible and retries without duplicate notices',async()=>{
 const c=await aiFixture();await aiModels.Config.updateOne({key:'main'},{$set:{'data.assignment':'fallback','data.fallbackAgent':String(agent._id)}});
 await Staff.deleteOne({_id:second._id});const original=aiProvider.interpret;aiProvider.interpret=async args=>({...await original(args),intent:'human'});
 await aiWorker.runOne(await aiSettings.getConfig());let current=await Conversation.findById(c._id);
 assert.equal(current.assignedTo,null);assert.match(current.ai.assignmentError,/No CSS/);assert.ok(current.ai.handoffPending);assert.equal(current.ai.active,false);
 await Staff.create({_id:second._id,name:'Restored CSS',email:'restored@example.test',password:'test',role:'CSS'});
 await Conversation.updateOne({_id:c._id},{$set:{'ai.handoffRetryAt':new Date(0)}});
 await aiWorker.recoverHandoffs(await aiSettings.getConfig());current=await Conversation.findById(c._id);
 assert.equal(String(current.assignedTo),String(second._id));assert.equal(current.ai.assignmentError,'');assert.equal(current.ai.handoffPending,undefined);
 await aiWorker.recoverHandoffs(await aiSettings.getConfig());assert.equal(await Notification.countDocuments({recipient:second._id}),1);
});
test('interrupted handoff notification is recovered once and manual assignment cancels recovery',async()=>{
 const c=await aiFixture('LIVE');const original=aiProvider.interpret;aiProvider.interpret=async args=>({...await original(args),intent:'human'});
 const notify=Notification.updateOne;
 try{Notification.updateOne=async()=>{throw new Error('Temporary write failure');};await assert.rejects(aiWorker.runOne(await aiSettings.getConfig()));}finally{Notification.updateOne=notify;}
 let current=await Conversation.findById(c._id);assert.equal(String(current.assignedTo),String(second._id));assert.ok(current.ai.handoffPending);
 await Conversation.updateOne({_id:c._id},{$set:{'ai.handoffRetryAt':new Date(0)}});
 await aiWorker.recoverHandoffs(await aiSettings.getConfig());await aiWorker.recoverHandoffs(await aiSettings.getConfig());
 assert.equal(await Notification.countDocuments({recipient:second._id}),1);assert.equal(await Message.countDocuments({type:'activity',author:'ai'}),1);
 await service.processOutbox();assert.equal(sent.length,1);
 current=await Conversation.findById(c._id);
 await Conversation.updateOne({_id:c._id},{$set:{'ai.handoffPending':{result:{handoff:'SERVICE_ONBOARDING'},inputId:current.lastInboundId},'ai.handoffRetryAt':new Date(0)}});
 assert.equal((await request(`/conversations/${c._id}`,{method:'PUT',body:{revision:current.revision,assignedTo:String(agent._id)}})).status,200);
 await aiWorker.recoverHandoffs(await aiSettings.getConfig());assert.equal(String((await Conversation.findById(c._id)).assignedTo),String(agent._id));
});

test('All includes resolved chats and Mine never treats unassigned chats as admin assignments', async () => {
  const conversation = await fixture();
  assert.equal((await request('/conversations?view=mine', { role: 'agent' })).data.items.length, 1);
  await Conversation.updateOne({ _id: conversation._id }, { $set: { status: 'resolved', assignedTo: null } });
  assert.equal((await request('/conversations?view=inbox')).data.items.length, 1);
  assert.equal((await request('/conversations?view=mine')).data.items.length, 0);
});

test('reactions send to WhatsApp, replace/remove and enforce permissions', async () => {
  const conversation = await fixture(); const message = await Message.findOne({ providerId: 'wamid.inbound' });
  const path = `/conversations/${conversation._id}/messages/${message._id}/reaction`;
  assert.equal((await request(path, { role: 'second', method: 'PUT', body: { emoji: '👍' } })).status, 404);
  assert.equal((await request(path, { method: 'PUT', body: { emoji: 'arbitrary' } })).status, 400);
  for (const emoji of ['👍', '❤️', '']) {
    assert.equal((await request(path, { method: 'PUT', body: { emoji } })).status, 200);
    assert.equal((await Message.findById(message._id)).reactions.get('business').emoji, emoji);
  }
  assert.equal(sent.length, 3); assert.equal(sent[0].messageId, 'wamid.inbound');
  provider.react = async () => { throw new Error('offline'); };
  assert.equal((await request(path, { method: 'PUT', body: { emoji: '✅' } })).status, 502);
  assert.equal((await Message.findById(message._id)).reactions.get('business').emoji, '');
});

test('note reactions stay internal and customer reaction webhooks update original messages', async () => {
  const conversation = await fixture();
  const note = await Message.create({ conversation: conversation._id, type: 'note', direction: 'internal', text: 'Team only', status: 'internal' });
  assert.equal((await request(`/conversations/${conversation._id}/messages/${note._id}/reaction`, { method: 'PUT', body: { emoji: '✅' } })).status, 200);
  assert.equal(sent.length, 0);
  const payload = inbound(); const event = payload.messages[0];
  event.id = 'wamid.reaction-in'; event.type = 'reaction'; event.reaction = { message_id: 'wamid.inbound', emoji: '😂' };
  await service.receive(payload); await service.receive(payload);
  assert.equal(await Message.countDocuments(), 2);
  let message = await Message.findOne({ providerId: 'wamid.inbound' });
  assert.equal(message.reactions.get('customer').emoji, '😂');
  event.timestamp = String(Number(event.timestamp) + 1); event.reaction.emoji = '';
  await service.receive(payload);
  message = await Message.findById(message._id); assert.equal(message.reactions.get('customer').emoji, '');
  event.timestamp = String(Number(event.timestamp) - 2); event.reaction.emoji = '👍';
  await service.receive(payload);
  assert.equal((await Message.findById(message._id)).reactions.get('customer').emoji, '');
});
test('authentication and existing restricted roles are enforced', async () => {
  assert.equal((await request('/session', { role: null })).status, 401);
  assert.equal((await request('/session', { role: 'restricted' })).status, 403);
  assert.equal((await request('/session', { role: 'agent' })).status, 200);
  await Staff.findByIdAndDelete(agent._id);
  assert.equal((await request('/session', { role: 'agent' })).status, 403);
});
test('signed webhook is durably acknowledged and duplicate deliveries create one message/contact', async () => {
  const body = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: inbound() }] }] };
  const signature = `sha256=${crypto.createHmac('sha256', process.env.WHATSAPP_APP_SECRET).update(JSON.stringify(body)).digest('hex')}`;
  assert.equal((await request('/webhook', { method: 'POST', role: null, body })).status, 401);
  const options = { method: 'POST', role: null, body, headers: { 'x-hub-signature-256': signature } };
  assert.equal((await request('/webhook', options)).status, 200);
  assert.equal((await request('/webhook', options)).status, 200);
  assert.equal(await WebhookJob.countDocuments(), 1);
  await service.processWebhooks(); await service.receive(inbound());
  assert.equal(await Message.countDocuments({ direction: 'inbound' }), 1);
  assert.equal(await Contact.countDocuments(), 1); assert.equal(await Conversation.countDocuments(), 1);
  assert.equal((await WebhookJob.findOne()).state, 'done');
});
test('only one representative can win a simultaneous claim', async () => {
  const conversation = await fixture(false);
  const results = await Promise.all(['agent', 'second'].map((role) => request(`/conversations/${conversation._id}`, { role, method: 'PUT', body: { assignedTo: String(role === 'agent' ? agent._id : second._id), revision: conversation.revision } })));
  assert.equal(results.filter((result) => result.status === 200).length, 1);
  assert.ok(results.some((result) => [403, 404, 409].includes(result.status)));
  assert.equal(await Message.countDocuments({ type: 'activity' }), 1);
});
test('other agents cannot read, reply, modify or download an assigned conversation', async () => {
  const conversation = await fixture(); const path = `/conversations/${conversation._id}`;
  for (const suffix of ['', '/messages', '/crm']) assert.equal((await request(path + suffix, { role: 'second' })).status, 404);
  assert.equal((await request(path + '/messages', { role: 'second', method: 'POST', body: outgoing() })).status, 404);
  assert.equal((await request(path, { role: 'second', method: 'PUT', body: { revision: conversation.revision, status: 'resolved' } })).status, 404);
  assert.equal((await request('/conversations', { role: 'second' })).data.items.length, 0);
});
test('internal notes never enter the outbound provider queue', async () => {
  const conversation = await fixture();
  const result = await request(`/conversations/${conversation._id}/messages`, { role: 'agent', method: 'POST', body: { type: 'note', text: 'Follow up tomorrow', clientId: crypto.randomUUID() } });
  assert.equal(result.status, 201); assert.equal(result.data.direction, 'internal');
  await service.processOutbox(); assert.equal(sent.length, 0);
});
test('repeated send requests share one durable message and one provider send', async () => {
  const conversation = await fixture(); const body = outgoing(); const path = `/conversations/${conversation._id}/messages`;
  const results = await Promise.all([request(path, { role: 'agent', method: 'POST', body }), request(path, { role: 'agent', method: 'POST', body })]);
  assert.ok(results.every((result) => [200, 201].includes(result.status)));
  assert.equal(results[0].data._id, results[1].data._id);
  await service.processOutbox(); await service.processOutbox();
  assert.equal(sent.length, 1); assert.equal((await Message.findById(results[0].data._id)).status, 'sent');
});
test('closed reply window rejects text but permits approved templates', async () => {
  const conversation = await fixture(); await Conversation.updateOne({ _id: conversation._id }, { lastInboundAt: new Date(Date.now() - 86400001) });
  const path = `/conversations/${conversation._id}/messages`;
  assert.equal((await request(path, { role: 'agent', method: 'POST', body: outgoing() })).status, 400);
  const template = await Template.create({ externalId: 'approved-template', name: 'follow_up', language: 'en', status: 'APPROVED', components: [{ type: 'BODY', text: 'Hello {{1}}' }], syncedAt: new Date() });
  const result = await request(path, { role: 'agent', method: 'POST', body: { type: 'template', templateId: String(template._id), values: { 'body.1': 'Ada' }, clientId: crypto.randomUUID() } });
  assert.equal(result.status, 201); assert.equal(result.data.text, 'Hello Ada');
  await service.processOutbox(); assert.equal(sent.length, 1); assert.equal(sent[0].message.providerPayload.name, 'follow_up');
});
test('window and assignment are rechecked at send time', async () => {
  const conversation = await fixture(); const result = await request(`/conversations/${conversation._id}/messages`, { role: 'agent', method: 'POST', body: outgoing() });
  await Conversation.updateOne({ _id: conversation._id }, { assignedTo: second._id });
  await service.processOutbox(); assert.equal(sent.length, 0); assert.equal((await Message.findById(result.data._id)).status, 'failed');
});
test('provider timeouts become uncertain and cannot be blindly retried', async () => {
  const conversation = await fixture(); provider.send = async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); };
  const result = await request(`/conversations/${conversation._id}/messages`, { role: 'agent', method: 'POST', body: outgoing() });
  await service.processOutbox(); assert.equal((await Message.findById(result.data._id)).status, 'unknown');
  assert.equal((await request(`/conversations/${conversation._id}/messages/${result.data._id}/retry`, { role: 'agent', method: 'POST', body: {} })).status, 409);
});
test('out-of-order status webhooks cannot regress a read receipt', async () => {
  const conversation = await fixture(); const result = await request(`/conversations/${conversation._id}/messages`, { role: 'agent', method: 'POST', body: outgoing() });
  await service.processOutbox(); const message = await Message.findById(result.data._id);
  for (const status of ['read', 'sent', 'failed', 'delivered']) await service.receive({ metadata: inbound().metadata, statuses: [{ id: message.providerId, status, timestamp: String(Math.floor(Date.now() / 1000)), biz_opaque_callback_data: `${message._id}:1` }] });
  assert.equal((await Message.findById(message._id)).status, 'read');
});
test('same-second inbound messages stay unread until the second message is read', async () => {
  const seconds = Math.floor(Date.now() / 1000); await service.receive(inbound('first', seconds));
  const conversation = await Conversation.findOne(); const first = await Message.findOne();
  await request(`/conversations/${conversation._id}/read`, { method: 'POST', body: { messageId: String(first._id) } });
  assert.equal((await request('/counts')).data.unread, 0);
  await service.receive(inbound('second', seconds)); assert.equal((await request('/counts')).data.unread, 1);
});
test('new messages reopen resolved conversations even in the same second, duplicates do not', async () => {
  const seconds = Math.floor(Date.now() / 1000); await service.receive(inbound('first', seconds));
  const conversation = await Conversation.findOne();
  await Conversation.updateOne({ _id: conversation._id }, { status: 'resolved' });
  await service.receive(inbound('first', seconds)); assert.equal((await Conversation.findById(conversation._id)).status, 'resolved');
  await service.receive(inbound('second', seconds)); assert.equal((await Conversation.findById(conversation._id)).status, 'open');
});
test('contact edits have revision checks and missing configuration never reports success', async () => {
  const conversation = await fixture(); const contact = await Contact.findById(conversation.contact);
  const path = `/conversations/${conversation._id}/contact`; const body = { name: 'Updated', revision: contact.revision };
  assert.equal((await request(path, { role: 'agent', method: 'PUT', body })).status, 200);
  assert.equal((await request(path, { role: 'agent', method: 'PUT', body })).status, 409);
  const token = process.env.WHATSAPP_ACCESS_TOKEN; delete process.env.WHATSAPP_ACCESS_TOKEN;
  try { assert.equal((await request(`/conversations/${conversation._id}/messages`, { role: 'agent', method: 'POST', body: outgoing() })).status, 503); }
  finally { process.env.WHATSAPP_ACCESS_TOKEN = token; }
});
test('message pagination is bounded and does not repeat rows', async () => {
  const conversation = await fixture(); await Message.insertMany(Array.from({ length: 70 }, (_, i) => ({ conversation: conversation._id, direction: 'internal', type: 'note', status: 'internal', text: `History ${i}` })));
  const first = await request(`/conversations/${conversation._id}/messages`); assert.equal(first.data.items.length, 50); assert.equal(first.data.more, true);
  const secondPage = await request(`/conversations/${conversation._id}/messages?before=${first.data.items[0]._id}`);
  assert.equal(secondPage.data.items.length, 21); assert.equal(secondPage.data.more, false);
  assert.equal(new Set([...first.data.items, ...secondPage.data.items].map((m) => m._id)).size, 71);
});
test('media validation rejects executable content before provider upload', async () => {
  const conversation = await fixture(); let uploads = 0; provider.upload = async () => { uploads++; };
  const result = await request(`/conversations/${conversation._id}/media`, { role: 'agent', method: 'POST', body: { name: 'image.png', data: Buffer.from('<script>alert(1)</script>').toString('base64') } });
  assert.equal(result.status, 400); assert.equal(uploads, 0);
});
test('concurrent delivery callbacks preserve the highest receipt state', async () => {
  const conversation = await fixture(); const result = await request(`/conversations/${conversation._id}/messages`, { role: 'agent', method: 'POST', body: outgoing() });
  await service.processOutbox(); const message = await Message.findById(result.data._id);
  await Promise.all(['delivered', 'read', 'failed', 'sent'].map((status) => service.receive({ metadata: inbound().metadata, statuses: [{ id: message.providerId, status, timestamp: String(Math.floor(Date.now() / 1000)), biz_opaque_callback_data: `${message._id}:1` }] })));
  assert.equal((await Message.findById(message._id)).status, 'read');
});
test('old attempt callbacks cannot alter a retried message', async () => {
  const conversation = await fixture();
  provider.send = async () => { throw Object.assign(new Error('rejected'), { response: { status: 400, data: { error: { code: 131000 } } } }); };
  const result = await request(`/conversations/${conversation._id}/messages`, { role: 'agent', method: 'POST', body: outgoing() });
  await service.processOutbox();
  assert.equal((await request(`/conversations/${conversation._id}/messages/${result.data._id}/retry`, { role: 'agent', method: 'POST', body: {} })).status, 200);
  provider.send = async () => 'wamid.retry-attempt-2'; await service.processOutbox();
  await service.receive({ metadata: inbound().metadata, statuses: [{ id: 'wamid.old-attempt', status: 'failed', timestamp: String(Math.floor(Date.now() / 1000)), biz_opaque_callback_data: `${result.data._id}:1` }] });
  const message = await Message.findById(result.data._id); assert.equal(message.attempts, 2); assert.equal(message.status, 'sent');
});
test('invalid signature, verification challenge and wrong phone routing are handled', async () => {
  const response = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=${process.env.WHATSAPP_VERIFY_TOKEN}&hub.challenge=12345`);
  assert.equal(response.status, 200); assert.equal(await response.text(), '12345');
  assert.equal((await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345`)).status, 403);
  await assert.rejects(service.receive({ ...inbound(), metadata: { phone_number_id: 'other-phone' } }), { code: 'PHONE_NUMBER_MISMATCH' });
  assert.equal(await Message.countDocuments(), 0);
});
test('CRM lookup exposes service context without credentials or staff-visible payments', async () => {
  const conversation = await fixture();
  const Client = require('../models/Client'); const Invoice = require('../models/Invoice');
  await Client.create({ businessName: 'Ada Business', servicePaidFor: 'Facebook Ads Account Setup', amountPaid: 45000, clientNumber: '0801 234 5678', clientLoginDetails: 'private-login-value' }).catch(async () => {
    // Existing service enums can differ between CRM deployments; insert a legacy-shaped fixture directly.
    await Client.collection.insertOne({ businessName: 'Ada Business', servicePaidFor: 'Setup', amountPaid: 45000, clientNumber: '0801 234 5678', clientLoginDetails: 'private-login-value' });
  });
  await Invoice.create({ token: 'private-invoice-token', customerPhone: '+2348012345678', customerName: 'Ada', amount: 8000, status: 'paid' });
  try {
    const staffResult = await request(`/conversations/${conversation._id}/crm`, { role: 'agent' });
    assert.equal(staffResult.status, 200); assert.equal(staffResult.data.length, 1);
    assert.equal(staffResult.data[0].name, 'Ada Business'); assert.equal(JSON.stringify(staffResult.data).includes('private-'), false);
    const adminResult = await request(`/conversations/${conversation._id}/crm`); assert.equal(adminResult.data.length, 2); assert.equal(JSON.stringify(adminResult.data).includes('private-'), false);
  } finally { await Client.deleteMany({}); await Invoice.deleteMany({}); }
});
test('follow-up scheduling validates dates, permissions and revisions', async () => {
  const conversation = await fixture(); const url = `/conversations/${conversation._id}`;
  const future = new Date(Date.now() + 86400000).toISOString();
  assert.equal((await request(url, { role: 'second', method: 'PUT', body: { revision: conversation.revision, followUpAt: future } })).status, 404);
  for (const followUpAt of ['invalid', new Date(Date.now() - 1000).toISOString(), {}]) assert.equal((await request(url, { role: 'agent', method: 'PUT', body: { revision: conversation.revision, followUpAt } })).status, 400);
  const result = await request(url, { role: 'agent', method: 'PUT', body: { revision: conversation.revision, followUpAt: future } });
  assert.equal(result.status, 200);
  const stored = await Conversation.findById(conversation._id); assert.equal(stored.status, 'follow_up'); assert.equal(stored.followUpAt.toISOString(), future);
  assert.equal((await request('/conversations?view=follow_up', { role: 'agent' })).data.items.length, 1);
  assert.equal((await request(url, { role: 'agent', method: 'PUT', body: { revision: conversation.revision, followUpAt: future } })).status, 409);
  assert.equal((await request(url, { role: 'agent', method: 'PUT', body: { revision: stored.revision, status: 'resolved' } })).status, 200);
  assert.equal((await Conversation.findById(conversation._id)).followUpAt, null);
});
test('contact filters remain scoped and media/activity views only return their types', async () => {
  const conversation = await fixture();
  await Contact.updateOne({ _id: conversation.contact }, { source: 'TikTok', status: 'customer' });
  await Conversation.updateOne({ _id: conversation._id }, { labels: ['Paid'] });
  const query = '/conversations?view=contacts&source=Tik&customerStatus=customer&label=Paid';
  assert.equal((await request(query, { role: 'agent' })).data.items.length, 1);
  assert.equal((await request(query, { role: 'second' })).data.items.length, 0);
  assert.equal((await request('/conversations?view=contacts&label=Other', { role: 'agent' })).data.items.length, 0);
  await Message.create({ conversation: conversation._id, direction: 'internal', type: 'note', status: 'internal', text: 'Private team note' });
  await Message.create({ conversation: conversation._id, direction: 'inbound', type: 'image', status: 'received', media: { id: 'image-test', mime: 'image/png' } });
  const media = await request(`/conversations/${conversation._id}/messages?kind=media`, { role: 'agent' }); assert.equal(media.data.items.length, 1); assert.equal(media.data.items[0].type, 'image');
  const notes = await request(`/conversations/${conversation._id}/messages?kind=activity`, { role: 'agent' }); assert.equal(notes.data.items.length, 1); assert.equal(notes.data.items[0].type, 'note');
});
test('templates can be filtered by category, status and language', async () => {
  await Template.create([{ externalId: 'a', name: 'test_a', category: 'UTILITY', status: 'APPROVED', language: 'en_US', components: [] }, { externalId: 'b', name: 'test_b', category: 'MARKETING', status: 'PENDING', language: 'en', components: [] }]);
  const result = await request('/templates?category=UTILITY&status=APPROVED&language=en_US', { role: 'agent' });
  assert.equal(result.status, 200); assert.equal(result.data.items.length, 1); assert.equal(result.data.items[0].externalId, 'a');
});

test('history is bounded by 24 hours and 50 messages, skips empty days and targets old notes', async () => {
  const conversation = await fixture();
  const old = await Message.create({ conversation: conversation._id, type: 'note', direction: 'internal', text: 'Older mention' });
  const oldDate = new Date(Date.now() - 8 * 86400000);
  await Message.collection.updateOne({ _id: old._id }, { $set: { createdAt: oldDate, occurredAt: oldDate } });
  await Message.insertMany(Array.from({ length: 60 }, (_, i) => ({ conversation: conversation._id, type: 'text', direction: 'inbound', text: `Recent ${i}` })));
  const first = await request(`/conversations/${conversation._id}/messages`);
  assert.equal(first.data.items.length, 50); assert.equal(first.data.withinDay, true);
  assert.ok(!first.data.items.some(m => m._id === String(old._id)));
  const secondPage = await request(`/conversations/${conversation._id}/messages?page=${first.data.next}`);
  assert.equal(secondPage.data.items.length, 11); assert.equal(secondPage.data.withinDay, false);
  const older = await request(`/conversations/${conversation._id}/messages?page=${secondPage.data.next}`);
  assert.equal(older.data.items[0]._id, String(old._id)); assert.equal(older.data.more, false);
  const target = await request(`/conversations/${conversation._id}/messages?target=${old._id}`);
  assert.ok(target.data.items.some(m => m._id === String(old._id)));
  assert.equal((await request(`/conversations/${conversation._id}/messages?page=garbage`)).status, 400);
});

test('mentions are idempotent, private and grant read access without sending permission', async () => {
  const conversation = await fixture();
  const payload = { type: 'note', text: 'Please review', mentions: [String(second._id)], clientId: crypto.randomUUID() };
  assert.equal((await request(`/conversations/${conversation._id}`, { role: 'second' })).status, 404);
  const sent = await request(`/conversations/${conversation._id}/messages`, { method: 'POST', body: payload });
  assert.equal(sent.status, 201);
  await request(`/conversations/${conversation._id}/messages`, { method: 'POST', body: payload });
  assert.equal(await Notification.countDocuments(), 1);
  const list = await request('/notifications', { role: 'second' });
  assert.equal(list.data.unread, 1); assert.equal(list.data.items.length, 1);
  assert.equal((await request('/notifications', { role: 'agent' })).data.items.length, 0);
  assert.equal((await request(`/conversations/${conversation._id}`, { role: 'second' })).status, 200);
  assert.equal((await request(`/conversations/${conversation._id}/messages`, { role: 'second', method: 'POST', body: outgoing() })).status, 403);
  const path = `/notifications/${list.data.items[0]._id}/read`;
  assert.equal((await request(path, { role: 'agent', method: 'POST', body: {} })).status, 404);
  const opened = await request(path, { role: 'second', method: 'POST', body: {} });
  assert.equal(opened.data.message, sent.data._id);
  assert.equal((await request('/notifications', { role: 'second' })).data.unread, 0);
});

test('conversation pages contain twenty unique rows', async () => {
  for (let i = 0; i < 25; i++) { const contact = await service.upsertContact(`23480123${String(i).padStart(5, '0')}`); await service.openConversation(contact); }
  const first = await request('/conversations'); const secondPage = await request(`/conversations?before=${first.data.next}`);
  assert.equal(first.data.items.length, 20); assert.equal(secondPage.data.items.length, 5);
  assert.equal(new Set([...first.data.items, ...secondPage.data.items].map(row => row._id)).size, 25);
});

test('delta cursor returns status changes without reloading unchanged history', async () => {
  const conversation = await fixture();
  const initial = await request(`/conversations/${conversation._id}/messages`);
  const note = await Message.create({ conversation: conversation._id, type: 'note', direction: 'internal', text: 'New update' });
  const delta = await request(`/conversations/${conversation._id}/messages?changes=${initial.data.changes}`);
  assert.ok(delta.data.items.some(m => m._id === String(note._id)));
  const empty = await request(`/conversations/${conversation._id}/messages?changes=${delta.data.changes}`);
  assert.equal(empty.data.items.length, 0);
});

test('stream tickets are scoped, single-use and carry no message contents', async () => {
  assert.equal((await request('/events-ticket', { method: 'POST', role: null, body: {} })).status, 401);
  const issued = await request('/events-ticket', { method: 'POST', role: 'agent', body: {} });
  assert.equal(issued.status, 200);
  const controller = new AbortController();
  const stream = await fetch(`${base}/events?ticket=${issued.data.ticket}`, { signal: controller.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /connected/);
  require('./live').bus.emit('change');
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: change\n\n');
  controller.abort(); await reader.cancel().catch(() => {});
  assert.equal((await fetch(`${base}/events?ticket=${issued.data.ticket}`)).status, 401);
});

test('durable pending mentions repair once after interruption', async () => {
  const conversation = await fixture();
  const note = await Message.create({ conversation: conversation._id, direction: 'internal', type: 'note', text: 'Repair', mentions: [second._id], mentionsPending: true, authorName: 'Administrator' });
  await service.processMentions(); await service.processMentions();
  assert.equal(await Notification.countDocuments({ message: note._id }), 1);
  assert.equal((await Message.findById(note._id)).mentionsPending, false);
});

test('a mismatched worker cannot claim a routed webhook or erase its payload', async () => {
  const original = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const payload = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: inbound('wamid.routing-test') }] }] };
  await service.enqueueWebhook(Buffer.from(JSON.stringify(payload)), payload);
  try {
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'wrong-worker-phone';
    await service.processWebhooks();
    const waiting = await WebhookJob.findOne();
    assert.equal(waiting.state, 'pending'); assert.equal(waiting.attempts, 0); assert.ok(waiting.payload);
    assert.equal(await Message.countDocuments(), 0);
  } finally { process.env.WHATSAPP_PHONE_NUMBER_ID = original; }
  await service.processWebhooks();
  const completed = await WebhookJob.findOne();
  assert.equal(completed.state, 'done'); assert.ok(completed.payload); assert.equal(completed.result.inbound, 1);
  assert.equal(await Message.countDocuments({ providerId: 'wamid.routing-test' }), 1);
});

test('legacy wrong-phone payload is blocked and retained rather than silently completed', async () => {
  await WebhookJob.create({ key: 'legacy-other-phone', state: 'pending', payload: { entry: [{ changes: [{ field: 'messages', value: { ...inbound(), metadata: { phone_number_id: 'another-number' } } }] }] } });
  await service.processWebhooks(); const stored = await WebhookJob.findOne();
  assert.equal(stored.state, 'blocked'); assert.equal(stored.errorCode, 'PHONE_NUMBER_MISMATCH'); assert.ok(stored.payload); assert.equal(stored.expiresAt, undefined);
});

test('a mismatched outbound worker leaves the message queued for the correct worker', async () => {
  const conversation = await fixture();
  const response = await request(`/conversations/${conversation._id}/messages`, { method: 'POST', body: outgoing() });
  const original = process.env.WHATSAPP_PHONE_NUMBER_ID;
  try {
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'wrong-worker-phone'; await service.processOutbox();
    assert.equal(sent.length, 0); assert.equal((await Message.findById(response.data._id)).status, 'queued');
  } finally { process.env.WHATSAPP_PHONE_NUMBER_ID = original; }
  await service.processOutbox(); assert.equal(sent.length, 1);
});

test('connection diagnostics are restricted to administrators', async () => {
  assert.equal((await request('/diagnostics', { role: 'agent' })).status, 403);
  assert.equal((await request('/connection-check', { role: 'agent', method: 'POST', body: {} })).status, 403);
  assert.equal((await request('/diagnostics')).status, 200);
});

test('R2 media links and keep controls enforce conversation access and retention state', async () => {
 const conversation = await fixture();
 const asset = await Media.create({ source: 'test-r2', conversation: conversation._id, key: 'joshspot-inbox/v1/000000000000000000000001', expiresAt: new Date(Date.now() + 86400000), state: 'ready', mime: 'audio/ogg' });
 const message = await Message.create({ conversation: conversation._id, direction: 'inbound', type: 'audio', media: { id: 'audio', asset: asset._id } });
 const basePath = `/conversations/${conversation._id}/messages/${message._id}`;
 const storage = require('./mediaStorage'); const originalConfigured = storage.configured; storage.configured = () => true; const original = storage.link; storage.link = async () => 'https://private-media.example.test/signed';
 try {
  assert.equal((await request(`${basePath}/media-link`, { role: 'second' })).status, 404);
  assert.equal((await request(`${basePath}/media-link`, { role: 'agent' })).status, 200);
  assert.equal((await request(`${basePath}/media-keep`, { role: 'agent', method: 'PUT', body: { keep: true } })).data.keep, true);
  assert.equal((await request(`${basePath}/media-keep`, { role: 'second', method: 'PUT', body: { keep: false } })).status, 404);
  await Media.updateOne({ _id: asset._id }, { $set: { state: 'deleted' } });
  assert.equal((await request(`${basePath}/media-link`, { role: 'agent' })).data.source, 'meta');
  assert.equal((await request(`${basePath}/media-keep`, { role: 'agent', method: 'PUT', body: { keep: true } })).status, 409);
 } finally { storage.link = original; storage.configured = originalConfigured; }
});

 test('Unlimited AI usage counts calls without enforcing global, conversation or turn caps',async()=>{
 const c=await aiFixture('LIVE');const day=new Date().toISOString().slice(0,10);
 const config=aiSettings.validateConfig({... (await aiSettings.getConfig()).data,maxDailyCalls:0,maxConversationCalls:0,maxConsecutive:0});
 for(const key of [`global:${day}`,`${c._id}:${day}`])await aiModels.Usage.create({key,calls:100000});
 await Promise.all(Array.from({length:5},()=>aiWorker.budget(config,c._id)));
 assert.equal((await aiModels.Usage.findOne({key:`global:${day}`})).calls,100005);
 assert.equal((await aiModels.Usage.findOne({key:`${c._id}:${day}`})).calls,100005);
 await aiModels.Config.updateOne({key:'main'},{$set:{data:config}});
 await Conversation.updateOne({_id:c._id},{$set:{'ai.consecutive':100000}});
 await aiWorker.runOne(await aiSettings.getConfig());
 assert.notEqual((await Conversation.findById(c._id)).ai.handoffReason,'AI_TURN_LIMIT');
 assert.equal((await aiModels.Usage.findOne({key:`global:${day}`})).calls,100006);
 });

test('Unlimited migration updates existing settings once and preserves later admin limits',async()=>{
 await aiFixture('LIVE');
 await aiModels.Config.updateOne({key:'main'},{$unset:{usageLimitsVersion:1},$set:{'data.maxDailyCalls':500,'data.maxConversationCalls':40,'data.maxConsecutive':8}});
 const migrated=await aiSettings.getConfig();
 assert.equal(migrated.data.maxDailyCalls,0);assert.equal(migrated.data.maxConversationCalls,0);assert.equal(migrated.data.maxConsecutive,0);
 assert.equal(migrated.data.mode,'LIVE');
 await aiModels.Config.updateOne({key:'main'},{$set:{'data.maxDailyCalls':100}});
 assert.equal((await aiSettings.getConfig()).data.maxDailyCalls,100);
});

test('Legacy conversations missing AI version complete pending replies exactly once',async()=>{
 const c=await aiFixture('LIVE');
 await Conversation.collection.updateOne({_id:c._id},{$unset:{'ai.version':'','ai.consecutive':'','ai.active':''}});
 await aiWorker.runOne(await aiSettings.getConfig());
 const saved=await Conversation.findById(c._id).lean();
 assert.equal(saved.ai.version,0);assert.equal(saved.ai.pending,false);
 assert.equal(await Message.countDocuments({conversation:c._id,author:'ai',direction:'outbound',status:'queued'}),1);
 assert.equal(await aiModels.Log.countDocuments({conversation:c._id,kind:'decision'}),1);
 assert.equal(await aiWorker.runOne(await aiSettings.getConfig()),false);
});

test('Onboarding stays with AI without assignment or notification',async()=>{
 const c=await aiFixture('LIVE');const original=aiProvider.interpret;
 aiProvider.interpret=async args=>({...await original(args),intent:'requirements'});
 await aiWorker.runOne(await aiSettings.getConfig());const current=await Conversation.findById(c._id);
 assert.equal(current.assignedTo,null);assert.notEqual(current.ai.active,false);
 assert.equal(await Notification.countDocuments({}),0);
 await service.processOutbox();assert.equal(sent.length,1);assert.match(sent[0].message.text,/email/);
});

test('Primary document is admin-only, saves long text intact and rejects stale overwrites',async()=>{
 await aiFixture();
 assert.equal((await request('/ai/master-knowledge',{role:'agent'})).status,403);
 const current=await request('/ai/master-knowledge');assert.equal(current.status,200);
 const text=Array.from({length:2500},(_,i)=>`Instruction ${i}: answer approved questions naturally.`).join('\n');
 const saved=await request('/ai/master-knowledge',{method:'PUT',body:{text,revision:current.data.revision}});
 assert.equal(saved.status,200);assert.equal(saved.data.text,text);
 assert.equal((await aiSettings.getConfig()).data.masterInstructions,text);
 assert.equal((await request('/ai/master-knowledge',{method:'PUT',body:{text:'stale',revision:current.data.revision}})).status,409);
 assert.equal((await request('/ai/master-knowledge',{method:'PUT',body:{text:'x'.repeat(200001),revision:saved.data.revision}})).status,400);
 const cfg=await aiSettings.getConfig();await request('/ai/config',{method:'PUT',body:{revision:cfg.revision,data:cfg.data}});
 assert.equal((await request('/ai/master-knowledge')).data.text,text);
});
test('Waiting response performs real CSS handoff rather than leaving an unassigned chat',async()=>{
 const c=await aiFixture('LIVE');const original=aiProvider.interpret;
 await aiModels.Record.updateOne({kind:'service',key:'tiktok_setup'},{$set:{'data.requirements':'Hold on please. You will receive a response shortly..'}});
 aiProvider.interpret=async args=>({...await original(args),intent:'requirements'});
 await aiWorker.runOne(await aiSettings.getConfig());const current=await Conversation.findById(c._id);
 assert.equal(String(current.assignedTo),String(second._id));assert.equal(current.ai.handoffReason,'RESPONSE_REQUIRES_STAFF');
 assert.equal(await Notification.countDocuments({recipient:second._id}),1);
 await service.processOutbox();assert.equal(sent.length,1);
});
