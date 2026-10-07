// All model interpretations below are fixtures, NOT claims of real NLP accuracy.
const {test}=require('node:test'),assert=require('node:assert/strict');
const {records,config}=require('../defaults');
const {catalogue}=require('./catalogue'),{dispatcher}=require('./tools');
const {accept,validateQuestions}=require('./turn'),{ledger,render}=require('./provenance');
const {decide}=require('./index'),{fakeOpenai}=require('./fakeOpenai.test-helper');
const inbound=(text,id='m')=>({_id:id,direction:'inbound',type:'text',status:'received',text});
const evidence=m=>({messageId:m._id,quote:m.text});
const request=(m,patch={})=>({id:'r',kind:'social',question:m.text,evidence:evidence(m),knowledgeKeys:[],serviceKeys:[],plans:false,...patch});
const plan=(m,patch={})=>({requests:[request(m)],purchaseChange:'keep',purchase:[],quoteChange:'keep',payment:'none',paymentEvidence:null,...patch});
const final=(text,patch={})=>({text,sources:[],questions:[],coverage:[{requestId:'r',status:'answered',sources:[],reason:''}],...patch});
const fc=(name,args)=>({output:[{type:'function_call',name,call_id:name,arguments:JSON.stringify(args)}]});
function fixture(text='Please help',state={}){
 const messages=[inbound(text)],ports={assertCurrent:async()=>{},persist:async()=>{},invoiceStatus:async()=>({status:'pending'})};
 const api={authorizePayment:async()=>({decision:'ALLOW'})};
 const dispatch=dispatcher({catalogue:catalogue(records),state,messages,history:[],ports,api,simulation:true});
 return {state,messages,ports,api,dispatch,catalogue:catalogue(records),history:[]};
}
const execute=(d,name,args={})=>d.execute({name,arguments:JSON.stringify(args)});

test('same-turn course interpretation retrieves authoritative course; greeting fetches nothing',async()=>{
 const f=fixture('I want to learn Facebook ads'),m=f.messages[0];
 const p=await accept(plan(m,{requests:[request(m,{kind:'business',serviceKeys:['ads_video_course']})],purchaseChange:'replace',purchase:[{platform:null,service:'course',evidence:evidence(m)}]}),f);
 assert.equal(f.dispatch.trace[0].result.price,8000);assert.equal(f.state.purchase[0].service,'course');assert.ok(p.requests[0].retrievedSources.length);
 const g=fixture('Good evening');await accept(plan(g.messages[0]),g);assert.equal(g.dispatch.trace.length,0);
});
test('business answer cannot skip knowledge; request coverage cannot silently drop a question',async()=>{
 const f=fixture();await assert.rejects(accept(plan(f.messages[0],{requests:[request(f.messages[0],{kind:'business'})]}),f),/RETRIEVAL/);
 const p=plan(f.messages[0],{requests:[request(f.messages[0]),request(f.messages[0],{id:'another'})]});
 assert.throws(()=>render(final('Hello'),ledger([],null,null),p),/REQUEST_NOT_COVERED/);
});
test('course detour keeps purchase, explicit switch replaces, returning evidence restores selection',async()=>{
 const f=fixture('What about the course?',{purchase:[{platform:'tiktok',service:'ads_management',evidence:{messageId:'old',quote:'run it'}}]});
 await accept(plan(f.messages[0],{requests:[request(f.messages[0],{kind:'business',serviceKeys:['ads_video_course']})]}),f);assert.equal(f.state.purchase[0].service,'ads_management');
 for(const [text,service,platform]of [['I want the course instead','course',null],['Actually manage TikTok for me','ads_management','tiktok']]){
  f.messages[0]=inbound(text);const m=f.messages[0];await accept(plan(m,{purchaseChange:'replace',purchase:[{platform,service,evidence:evidence(m)}]}),f);assert.equal(f.state.purchase[0].service,service);
 }
});
test('fabricated evidence and guessed keys rejected before purchase mutation',async()=>{
 const f=fixture();const p=plan(f.messages[0],{purchaseChange:'replace',purchase:[{platform:'meta',service:'account_setup',evidence:{messageId:'fake',quote:'x'}}]});
 await assert.rejects(accept(p,f),/EVIDENCE/);assert.equal(f.state.purchase,undefined);
 await assert.rejects(accept(plan(f.messages[0],{requests:[request(f.messages[0],{serviceKeys:['made_up']})]}),f),/DISCOVERY/);
});
test('semantic service resolver works without memorized IDs; invalid tool gets one correction',async()=>{
 const f=fixture();const course=await execute(f.dispatch,'resolve_service',{service:'course',platform:null});assert.equal(course.key,'ads_video_course');
 const a=await execute(f.dispatch,'get_service_details',{key:'invented'});assert.equal(a.recoverable,true);assert.ok(a.validServiceKeys.includes('tiktok_setup'));assert.equal(a.field,'key');
 const b=await execute(f.dispatch,'get_service_details',{key:'tiktok_setup'});assert.equal(b.price,20000);
 const bad=fixture();await execute(bad.dispatch,'get_service_details',{key:'bad'});const second=await execute(bad.dispatch,'get_service_details',{key:'bad'});assert.equal(second.recoverable,false);
 await assert.rejects(execute(bad.dispatch,'get_service_details',{key:'tiktok_setup'}),/RECOVERY_EXHAUSTED/);
});
test('setup schema excludes campaign fields; paid options require evidence; testing is default',async()=>{
 const f=fixture();
 const q=await execute(f.dispatch,'calculate_ads_quote',{items:[{platform:'tiktok',service:'account_setup'}],purchaseCap:null,creativeEvidence:null});assert.equal(q.total,20000);
 const management={platform:'meta',service:'ads_management',budgetBasis:'DAILY_AD_SPEND',budget:5000,duration:7,planKey:null,creativeMode:null,creatives:null};
 const mq=await execute(f.dispatch,'calculate_ads_quote',{items:[management],purchaseCap:null,creativeEvidence:null});assert.equal(mq.total,60000);assert.equal(mq.lines[0].creativeMode,'testing');
 const rejected=await execute(f.dispatch,'calculate_ads_quote',{items:[{...management,creativeMode:'individual'}],purchaseCap:null,creativeEvidence:null});assert.equal(rejected.error,'PAID_OPTION_EVIDENCE_REQUIRED');
});
test('model may not add setup to evidence-selected management',async()=>{
 const f=fixture('Run TikTok for me');const p=await accept(plan(f.messages[0],{purchaseChange:'replace',purchase:[{platform:'tiktok',service:'ads_management',evidence:evidence(f.messages[0])}]}),f);f.dispatch.setPlan(p);
 const q=await execute(f.dispatch,'calculate_ads_quote',{items:[{platform:'tiktok',service:'account_setup'}],purchaseCap:null,creativeEvidence:null});assert.equal(q.error,'UNSELECTED_SERVICE');
});
test('confirmed fields and irrelevant setup/course questions are rejected',()=>{
 const m=inbound('yes'),p=plan(m);
 const ask=field=>final('Please clarify',{questions:[{field,reason:'missing',evidence:null}]});
 assert.throws(()=>validateQuestions(ask('duration'),p,{purchase:[{service:'account_setup'}]},[m]),/NEEDS_NO_CAMPAIGN/);
 assert.throws(()=>validateQuestions(ask('budget'),p,{purchase:[{service:'course'}]},[m]),/NEEDS_NO_CAMPAIGN/);
 assert.throws(()=>validateQuestions(ask('budget'),p,{quote:{total:265000}},[m]),/QUOTE_ALREADY/);
 assert.throws(()=>validateQuestions(ask('platform'),p,{purchase:[{platform:'meta'}]},[m]),/ALREADY_SELECTED/);
 assert.throws(()=>validateQuestions(ask('payment'),{...p,payment:'defer'},{},[m]),/DEFERRED/);
});
for(const text of ['₦15,000','15,000 NGN','NGN 15,000','15000 naira','about 15k','approximately 15,000','15k setup fee','15,000 for setup','fifteen thousand naira','＄１５０００','the setup is free'])test(`unsupported numeric claim blocked: ${text}`,()=>{
 assert.throws(()=>render(final(text),ledger([],null,null),plan(inbound('price'))),/UNSOURCED_NUMERIC_CLAIM/);
});
test('trusted amount tokens bind source/path; invented tokens and envelopes never render',()=>{
 const book=ledger([{tool:'get_service_details',result:{title:'TikTok setup',price:20000}}],null,null);
 const result=render(final('The price is {{value:s0_0}}.',{sources:['s0']}),book,plan(inbound('price')));assert.ok(result.text.includes('₦20,000'));assert.equal(result.provenance[0].path,'.price');
 assert.throws(()=>render(final('{{value:invented}}'),book,plan(inbound('price'))),/UNTRUSTED_VALUE/);
 for(const text of ['{"text":"hello"}','messageId: internal','```json\nhello\n```'])assert.throws(()=>render(final(text),book,plan(inbound('Hi'))),/ENVELOPE/);
});
test('model-classified human paraphrases invoke handoff without backend phrase matching',async()=>{
 for(const text of ['Can somebody on your team help me?','Abeg connect me to staff','I prefer a person please']){
  const f=fixture(text);await accept(plan(f.messages[0],{requests:[request(f.messages[0],{kind:'human'})]}),f);assert.equal(f.dispatch.handoff.reason,'CUSTOMER_REQUESTED_HUMAN');
 }
});
test('deferral overrides earlier invoice permission at tool boundary',async()=>{
 const f=fixture('Not now');f.dispatch.setPlan(plan(f.messages[0],{payment:'defer',paymentEvidence:evidence(f.messages[0])}));
 const r=await execute(f.dispatch,'create_invoice',{quoteId:'old',messageId:'m',evidence:'Not now'});assert.equal(r.error,'CURRENT_PAYMENT_REQUEST_REQUIRED');
});
test('structured multi-question plan retrieves each source and final coverage contains both',async()=>{
 const f=fixture('What does setup cover and can I learn instead?'),m=f.messages[0];
 const p=await accept(plan(m,{requests:[request(m,{kind:'business',serviceKeys:['tiktok_setup']}),request(m,{id:'course',kind:'business',serviceKeys:['ads_video_course']})]}),f);
 const proof=render(final('Setup includes guidance. The course is video training.',{sources:['s0','s1'],coverage:[{requestId:'r',status:'answered',sources:['s0'],reason:''},{requestId:'course',status:'answered',sources:['s1'],reason:''}]}),ledger(f.dispatch.trace,null,null),p);assert.equal(proof.coverage.length,2);
});
test('payment request plus question retrieves facts and executes simulated invoice before final answer',async()=>{
 const m=inbound('Please send payment details and explain what setup covers');const p=plan(m,{requests:[request(m,{kind:'business',serviceKeys:['tiktok_setup']})],purchaseChange:'replace',purchase:[{platform:'tiktok',service:'account_setup',evidence:evidence(m)}],payment:'request',paymentEvidence:evidence(m)});
 const api=fakeOpenai([fc('plan_turn',p),fc('calculate_ads_quote',{items:[{platform:'tiktok',service:'account_setup'}],purchaseCap:null,creativeEvidence:null}),fc('finish_response',final('Setup includes guidance.',{sources:['s0'],coverage:[{requestId:'r',status:'answered',sources:['s0'],reason:''}]})),fc('finish_response',final('Setup includes guidance. The invoice action is simulated here.',{sources:['s0'],coverage:[{requestId:'r',status:'answered',sources:['s0'],reason:''}]}))]);api.authorizePayment=async()=>({decision:'ALLOW'});
 let writes=0;const result=await decide({config,records,messages:[m],api,ports:{assertCurrent:async()=>{},persist:async()=>{},invoiceStatus:async()=>({status:'NONE'}),createInvoice:async()=>{writes++;}},simulation:true});
 assert.equal(result.wouldGenerateInvoice,true);assert.equal(writes,0);assert.ok(result.debug.tools.some(t=>t.tool==='create_invoice'));
});
test('15-day plan source is authoritative and fixed package needs no customer ad budget',async()=>{
 const f=fixture();const plans=await execute(f.dispatch,'get_recommended_ads_plans');const p=plans.find(p=>p.key==='plan_15');assert.equal(p.amount,265000);assert.equal(p.breakdown.advertisingBudget,200000);assert.equal(p.breakdown.managementFee,65000);
 const q=await execute(f.dispatch,'calculate_ads_quote',{items:[{platform:'tiktok',service:'ads_management',budgetBasis:'PACKAGE',budget:null,duration:null,planKey:'plan_15',creativeMode:null,creatives:null}],purchaseCap:null,creativeEvidence:null});assert.equal(q.total,265000);
});

test('budget correction invalidates quote without losing service selection; counteroffer keeps it',async()=>{
 const f=fixture('Change the daily spend please',{purchase:[{platform:'meta',service:'ads_management'}],quote:{total:60000}});
 await accept(plan(f.messages[0],{quoteChange:'invalidate'}),f);assert.equal(f.state.quote,null);assert.equal(f.state.purchase[0].service,'ads_management');
 f.state.quote={total:60000};f.messages[0]=inbound('Can you reduce it for me');await accept(plan(f.messages[0]),f);assert.equal(f.state.quote.total,60000);
});
test('financial output repair gets one attempt; unsupported amount never escapes',async()=>{
 const m=inbound('Hello'),p=plan(m);
 const api=fakeOpenai([fc('plan_turn',p),fc('finish_response',final('approximately 15,000 NGN')),fc('finish_response',final('Hello, how can I help?'))]);
 const result=await decide({config,records,messages:[m],api,ports:fixture().ports});assert.equal(result.response,'Hello, how can I help?');assert.equal(api.requests.filter(r=>r.response).length,3);
 const bad=fakeOpenai([fc('plan_turn',p),fc('finish_response',final('15k setup fee')),fc('finish_response',final('fifteen thousand naira'))]);
 await assert.rejects(decide({config,records,messages:[m],api:bad,ports:fixture().ports}),/UNSOURCED_NUMERIC/);
});
test('payment paraphrase fixtures resolve contextual request through same contract, not phrase rules',async()=>{
 for(const text of ['Where should I transfer for this?', 'Oya the bank details please','Send the account for that package']){
  const f=fixture(text,{purchase:[{platform:'tiktok',service:'account_setup'}]});const m=f.messages[0],p=plan(m,{payment:'request',paymentEvidence:evidence(m)});await accept(p,f);f.dispatch.setPlan(p);
  const q=await execute(f.dispatch,'calculate_ads_quote',{items:[{platform:'tiktok',service:'account_setup'}],purchaseCap:null,creativeEvidence:null});
  assert.equal(q.total,20000);const invoice=await execute(f.dispatch,'create_invoice',{quoteId:q.id,messageId:m._id,evidence:m.text});assert.equal(invoice.wouldCreateInvoice,true);
 }
});
