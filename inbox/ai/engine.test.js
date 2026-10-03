const {test,afterEach}=require('node:test');const assert=require('node:assert/strict');
const engine=require('./engine'),provider=require('./provider'),defaults=require('./defaults');const axios=require('axios');
const original=provider.interpret;const post=axios.post;
test('AI diagnostics distinguish quota, authentication and timeouts without exposing raw errors',()=>{
 const {providerError,describe}=require('./errors');
 for(const [input,code] of [[{response:{status:429,data:{error:{code:'insufficient_quota',message:'SECRET'}}}},'AI_QUOTA_EXHAUSTED'],[{response:{status:401}},'AI_AUTH_FAILED'],[{code:'ECONNABORTED'},'AI_TIMEOUT']]){
  const error=providerError(input);assert.equal(error.code,code);assert.equal(describe(error).message.includes('SECRET'),false);
 }
 assert.equal(describe({code:27}).code,'AI_KNOWLEDGE_INDEX');
});
afterEach(()=>{provider.interpret=original;axios.post=post;});
const result=(changes={})=>({intent:'advertising',confidence:.99,platform:null,serviceType:null,budget:null,duration:null,...changes});
async function decide(text,output,state={},extra={}){provider.interpret=async()=>result(output);return engine.decide({text,state,config:{...defaults.config,invoicesEnabled:true},records:defaults.records,knowledge:[],...extra});}
test('initial greeting, explicit platform, setup prices and management context use configured records',async()=>{
 for(const [text,output,contains]of [
  ['Hi',{intent:'greeting'},'services'],['Hello I need TikTok ads',{platform:'tiktok'},'set up'],['Do you run Facebook ads?',{platform:'meta',serviceType:'ads_management'},'budget'],
  ['I need TikTok setup',{platform:'tiktok',serviceType:'account_setup'},'20,000'],['How much is Facebook setup?',{platform:'meta',serviceType:'account_setup'},'30,000'],
  ['I want you to run the ads',{serviceType:'ads_management'},'platform'],
 ]){const value=await decide(text,output);assert.equal(value.action,'reply');assert.ok(value.response.includes(contains),text);}
 const context={selectedPlatform:'tiktok',serviceType:'account_setup'};
 assert.match((await decide('Setup',{},context)).response,/20,000/);
 assert.match((await decide('What if you run it?',{serviceType:'ads_management'},context)).response,/budget/);
});
test('recommendations, selecting plans and payment actions cannot invent amounts',async()=>{
 const state={selectedPlatform:'tiktok',serviceType:'ads_management'};
 for(const text of ["I don't know how much to spend",'What do you recommend?'])assert.match((await decide(text,{intent:'recommendation'},state)).response,/135,000/);
 const plan=await decide('I want the 7 day plan',{duration:7},state);assert.match(plan.response,/60,000/);
 for(const text of ["I'm ready to pay",'Send account','Send invoice']){const value=await decide(text,{intent:'request_invoice'},plan.state);assert.equal(value.action,'invoice');assert.equal(value.amount,60000);}
 const custom=await decide('Run TikTok for 100k for ten days',{budget:100000,duration:10},state);assert.equal(custom.action,'handoff');
 const altered=defaults.records.map(r=>r.key==='tiktok_setup'?{...r,data:{...r.data,price:22000}}:r);
 assert.match((await decide('Price?',{}, {selectedPlatform:'tiktok',serviceType:'account_setup'},{records:altered})).response,/22,000/);
});
test('media, receipts, human requests, sensitive data and unknown questions stop AI',async()=>{
 for(const type of ['image','video','audio','document','unsupported','location']){provider.interpret=()=>{throw Error('must not be called');};assert.equal((await engine.decide({text:'',type,config:defaults.config,records:[],state:{}})).handoff,'MEDIA_RECEIVED');}
 for(const [text,intent,reason]of [["I've paid",'payment_sent','PAYMENT_VERIFICATION_REQUIRED'],['Human please','human','CUSTOMER_REQUESTED_HUMAN'],['Who is the president of France?','unknown','NO_KNOWLEDGE'],['Unknown policy','unknown','NO_KNOWLEDGE']])assert.equal((await decide(text,{intent})).handoff,reason);
 assert.equal((await decide('my password is secret',{})).handoff,'SENSITIVE_CASE');
 assert.equal((await decide('unsure',{confidence:.1})).handoff,'LOW_CONFIDENCE');
 assert.match((await decide('What details do you need?',{intent:'requirements'},{selectedPlatform:'tiktok',serviceType:'account_setup'})).response,/do not send passwords/i);
});
test('knowledge must match retrieved approved entries and template variables must exist',async()=>{
 assert.equal((await decide('policy',{intent:'knowledge',knowledgeKey:'invented'})).action,'handoff');
 const entry={key:'working_hours',data:{answer:'We open at 9am.'}};
 assert.equal((await decide('hours',{intent:'knowledge',knowledgeKey:entry.key},{},{knowledge:[entry]})).response,entry.data.answer);
 assert.throws(()=>engine.render('Pay {{invented_account}}',{}));
});
test('onboarding from requirements, saved workflow responses and knowledge always hands off to CSS',async()=>{
 const state={selectedPlatform:'tiktok',serviceType:'account_setup'};
 const requirements=await decide('What details do you need?',{intent:'requirements'},state);
 assert.equal(requirements.action,'handoff');assert.equal(requirements.handoff,'SERVICE_ONBOARDING');assert.equal(requirements.handoffTeam,'CSS');assert.match(requirements.response,/email/);
 const entry=defaults.records.find(r=>r.key==='tiktok_management_access');
 const knowledge=await decide('How do I give access?',{intent:'knowledge',knowledgeKey:entry.key},state,{knowledge:[entry]});
 assert.equal(knowledge.action,'handoff');assert.equal(knowledge.handoffTeam,'CSS');
 const workflow={kind:'workflow',key:'onboard',data:{intent:'advertising',field:'selectedPlatform',operator:'present',response:'requirements',action:'reply'}};
 assert.equal((await decide('Continue',{},state,{records:[workflow,...defaults.records]})).action,'handoff');
});
test('payment/human rules supply the approved fallback without bypassing mandatory handoff',async()=>{
 for(const intent of ['human','payment_sent','receipt_sent','payment_problem']){
  const rule=defaults.records.find(r=>r.kind==='handoff'&&r.data.intent===intent);
  const value=await decide('help',{intent});assert.equal(value.action,'handoff');assert.equal(value.handoffRule,rule.key);assert.equal(value.response,rule.data.customerResponse);
 }
});
test('OpenAI adapter uses structured Responses API, store false and redacted input',async()=>{
 process.env.OPENAI_API_KEY='fake-test-key';process.env.OPENAI_MODEL='test-model';let captured;
 axios.post=async(url,body)=>{captured={url,body};return{data:{status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(result({intent:'greeting'}))}]}],usage:{total_tokens:10}}};};
 await original({text:'hello alice@example.com',state:{},history:[{text:'my password is NEVER_SEND',direction:'inbound'}],records:[],knowledge:[],config:defaults.config});
 assert.match(captured.url,/v1\/responses$/);assert.equal(captured.body.store,false);assert.equal(captured.body.text.format.strict,true);assert.equal(captured.body.input.includes('NEVER_SEND'),false);assert.equal(captured.body.input.includes('alice@example.com'),false);
 delete process.env.OPENAI_API_KEY;delete process.env.OPENAI_MODEL;
});
