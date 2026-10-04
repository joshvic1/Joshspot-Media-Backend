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
 assert.equal((await decide('unsure',{confidence:.1})).action,'reply');
 assert.equal((await decide('still unclear',{confidence:.1},{clarificationAsked:true})).handoff,'NO_KNOWLEDGE');
 assert.match((await decide('What details do you need?',{intent:'requirements'},{selectedPlatform:'tiktok',serviceType:'account_setup'})).response,/do not send passwords/i);
});
test('knowledge must match retrieved approved entries and template variables must exist',async()=>{
 assert.equal((await decide('policy',{intent:'knowledge',knowledgeKey:'invented'})).action,'handoff');
 const entry={key:'working_hours',data:{answer:'We open at 9am.'}};
 assert.equal((await decide('hours',{intent:'knowledge',knowledgeKey:entry.key},{},{knowledge:[entry]})).response,entry.data.answer);
 assert.throws(()=>engine.render('Pay {{invented_account}}',{}));
});
test('onboarding from requirements, saved workflow responses and knowledge continues with AI',async()=>{
 const state={selectedPlatform:'tiktok',serviceType:'account_setup'};
 const requirements=await decide('What details do you need?',{intent:'requirements'},state);
 assert.equal(requirements.action,'reply');assert.match(requirements.response,/email/);
 const entry=defaults.records.find(r=>r.key==='tiktok_management_access');
 const knowledge=await decide('How do I give access?',{intent:'knowledge',knowledgeKey:entry.key},state,{knowledge:[entry]});
 assert.equal(knowledge.action,'reply');
 const workflow={kind:'workflow',key:'onboard',data:{intent:'advertising',field:'selectedPlatform',operator:'present',response:'requirements',action:'reply'}};
 assert.equal((await decide('Continue',{},state,{records:[workflow,...defaults.records]})).action,'reply');
});
test('payment/human rules supply the approved fallback without bypassing mandatory handoff',async()=>{
 for(const intent of ['human','payment_sent','receipt_sent']){
  const rule=defaults.records.find(r=>r.kind==='handoff'&&r.data.intent===intent);
  const value=await decide('help',{intent});assert.equal(value.action,'handoff');assert.equal(value.handoffRule,rule.key);assert.ok(value.response);if(intent!=='human')assert.doesNotMatch(value.response,/payment confirmed/i);
 }
});
test('OpenAI adapter uses structured Responses API, store false and redacted input',async()=>{
 process.env.OPENAI_API_KEY='fake-test-key';process.env.OPENAI_MODEL='test-model';let captured;
 axios.post=async(url,body)=>{captured={url,body};return{data:{status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(result({intent:'greeting'}))}]}],usage:{total_tokens:10}}};};
 await original({text:'hello alice@example.com',state:{},history:[{text:'my password is NEVER_SEND',direction:'inbound'}],records:[],knowledge:[],config:defaults.config});
 assert.match(captured.url,/v1\/responses$/);assert.equal(captured.body.store,false);assert.equal(captured.body.text.format.strict,true);assert.equal(captured.body.input.includes('NEVER_SEND'),false);assert.equal(captured.body.input.includes('alice@example.com'),false);
 delete process.env.OPENAI_API_KEY;delete process.env.OPENAI_MODEL;
});

test('Receipts confirm only verified payments; payment troubleshooting can use approved knowledge',async()=>{
 const receipt=await decide('receipt sent',{intent:'receipt_sent'},{},{paymentVerified:true});
 assert.match(receipt.response,/Payment confirmed/);assert.equal(receipt.action,'handoff');
 const entry=defaults.records.find(r=>r.key==='incorrect_payment_amount');
 const answer=await decide('wrong amount',{intent:'knowledge',knowledgeKey:entry.key},{},{knowledge:[entry]});
 assert.equal(answer.action,'reply');assert.equal(answer.response,entry.data.answer);
});

test('Primary document answer overrides old greeting and onboarding wording without handoff',async()=>{
 const master='Ask whether they want setup and teaching or management before quoting.';
 const extra={config:{...defaults.config,masterInstructions:master}};
 const response='Would you like setup and guidance, or would you prefer us to run the ads?';
 for(const intent of ['greeting','requirements','unknown']){
 const answer=await decide('Help me get TikTok sorted',{intent,answer:response,answerKind:'answer',answerSupported:true,sourceQuote:master},{},extra);
 assert.equal(answer.action,'reply');assert.equal(answer.response,response);assert.equal(answer.responseKey,'primary_document');
 }
});
test('Primary answer cannot invent a price, confirm payment or bypass an explicit human request',async()=>{
 const master='Explain our services and help the customer.';
 for(const answer of ['Pay ₦99999 now','Payment confirmed']){
 const value=await decide('question',{intent:'unknown',answer,answerKind:'answer',answerSupported:true,sourceQuote:master},{},{config:{...defaults.config,masterInstructions:master}});
 assert.notEqual(value.response,answer);
 }
 const human=await decide('Human please',{intent:'human',answer:'Let us keep chatting',answerKind:'clarify'},{},{config:{...defaults.config,masterInstructions:master}});
 assert.equal(human.handoff,'CUSTOMER_REQUESTED_HUMAN');
});
test('Provider receives the complete primary document including its last line with priority instructions',async()=>{
 process.env.OPENAI_API_KEY='fake';process.env.OPENAI_MODEL='test';let captured;
 axios.post=async(_,body)=>{captured=body;return{data:{output:[{content:[{type:'output_text',text:JSON.stringify(result({answer:'Hi',sourceQuote:'',answerKind:'clarify'}))}]}]}}};
 const master='Instruction\n'.repeat(12000)+'FINAL IMPORTANT INSTRUCTION';
 await original({text:'hi',state:{},history:[],records:[],knowledge:[],config:{...defaults.config,masterInstructions:master}});
 assert.ok(captured.instructions.includes(master));assert.match(captured.instructions,/takes priority/);
 delete process.env.OPENAI_API_KEY;delete process.env.OPENAI_MODEL;
});

test('Price questions use verified catalogue amount rather than stale onboarding text',async()=>{
 const response=await decide('What will it cost?',{intent:'requirements',asksPrice:true},{selectedPlatform:'tiktok',serviceType:'account_setup'});
 assert.equal(response.action,'reply');assert.match(response.response,/20,000/);assert.equal(response.responseKey,'quote');
});
