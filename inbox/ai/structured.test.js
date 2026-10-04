const {test,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const engine=require('./engine'),provider=require('./provider'),defaults=require('./defaults'),kb=require('./structuredKnowledge');
const original=provider.interpret;afterEach(()=>{provider.interpret=original;});
const config={...defaults.config,structuredSales:true,invoicesEnabled:true};
const records=[...defaults.records,...kb.seeds];
async function turn(text,decision={},state={},extra={}){provider.interpret=async()=>({intent:'advertising',confidence:.99,platform:null,serviceType:null,budget:null,duration:null,answer:'',answerKind:'none',...decision});return engine.decide({text,state,config,records,knowledge:[],...extra});}
test('strict generic greeting bypasses provider; intent-bearing greeting retains useful information',async()=>{
 provider.interpret=()=>{throw Error('not called');};const greeting=await engine.decide({text:'Hi',config,records});assert.equal(greeting.state.nextObjective,'DISCOVER_SERVICE');
 const intent=await turn('Hi I need TikTok ads',{platform:'tiktok'});assert.equal(intent.state.nextObjective,'GET_SERVICE_TYPE');assert.doesNotMatch(intent.response,/which of our services/i);
});
test('setup progresses quote, consent, payment details without duplicate questions',async()=>{
 const quote=await turn('How much is Meta setup?',{platform:'meta',serviceType:'account_setup',asksPrice:true});assert.match(quote.response,/30,000/);assert.equal(quote.state.currentSalesStage,'PRICE_PRESENTED');
 const consent=await turn('Yes',{},quote.state);assert.equal(consent.action,'reply');assert.match(consent.response,/account details/);
 const invoice=await turn('Yes',{},consent.state);assert.equal(invoice.action,'invoice');assert.equal(invoice.amount,30000);assert.equal(invoice.state.paymentDetailsRequested,true);
 const direct=await turn('Send account for Meta setup',{intent:'request_account_number',platform:'meta',serviceType:'account_setup'});assert.equal(direct.action,'invoice');
});
test('management custom quote calls the actual calculator and preserves partial information',async()=>{
 const initial=await turn('Run TikTok ads',{platform:'tiktok',serviceType:'ads_management'});assert.equal(initial.state.nextObjective,'GET_BUDGET_DURATION');
 const partial=await turn('100k',{budget:100000},initial.state);assert.equal(partial.state.nextObjective,'GET_DURATION');assert.equal(partial.state.budget,100000);
 const quote=await turn('10 days',{duration:10},partial.state);assert.equal(quote.amount,135000);assert.equal(quote.debug.calculator.managementFee,35000);assert.equal(quote.state.quoteSource,'ads_calculator');
 const all=await turn('Run TikTok for 100k over 10 days',{platform:'tiktok',serviceType:'ads_management',budget:100000,duration:10});assert.equal(all.amount,135000);
});
test('calculator copy has exact parity with existing frontend module',()=>{const source=fs.readFileSync(require.resolve('./vendor/adsPricingConfig.mjs'),'utf8').replace(/\r\n/g,'\n');assert.equal(require('node:crypto').createHash('sha256').update(source).digest('hex'),'147c34b8424846c580c1e7d369c77ebc3545628d2b489f934e40233d40ce6321');const frontend=require('node:path').resolve(__dirname,'../../..','frontend/config/adsPricingConfig.mjs');if(fs.existsSync(frontend))assert.equal(source,fs.readFileSync(frontend,'utf8').replace(/\r\n/g,'\n'));});
test('recommendations use current records and explicit plan selection',async()=>{
 const state={serviceType:'ads_management',selectedPlatform:'tiktok'};
 const plans=await turn('Recommend a plan',{intent:'recommendation',needsRecommendation:true},state);assert.match(plans.response,/60,000/);assert.match(plans.response,/415,000/);
 const selected=await turn('10 day plan',{planKey:'plan_10'},state);assert.equal(selected.amount,135000);assert.equal(selected.state.recommendedPlan,'plan_10');
});
test('decline stops progression and service changes unlink wrong invoice without deleting it',async()=>{
 const state={selectedPlatform:'tiktok',serviceType:'account_setup',invoiceId:'existing',paymentDetailsSentAt:new Date().toISOString(),paymentDetailsRequested:true,customerWantsToProceed:true};
 const no=await turn('Later',{declines:true},state);assert.equal(no.response,'Okay.');assert.equal(no.state.salesPaused,true);assert.equal(no.action,'reply');
 const changed=await turn('Actually manage Meta',{platform:'meta',serviceType:'ads_management'},state);assert.equal(changed.state.invoiceId,undefined);assert.equal(changed.state.previousInvoiceId,'existing');assert.equal(changed.action,'reply');assert.equal(changed.state.nextObjective,'GET_BUDGET_DURATION');
});
test('media, human and claimed payments hand off; only verified payment is confirmed',async()=>{
 for(const type of ['image','audio','video','document','location','contacts','sticker'])assert.equal((await turn('',{}, {},{type})).handoff,'MEDIA_RECEIVED');
 assert.equal((await turn('Human please',{intent:'human'})).handoff,'CUSTOMER_REQUESTED_HUMAN');
 const claim=await turn('Paid',{intent:'payment_sent'});assert.equal(claim.state.paymentStatus,'claimed');assert.doesNotMatch(claim.response,/payment confirmed/i);
 const paid=await turn('Paid',{}, {},{paymentVerified:true});assert.equal(paid.state.paymentStatus,'paid');assert.match(paid.response,/Payment confirmed/);
});
test('approved multi-entry answers precede progression and financial claims are rejected',async()=>{
 const knowledge=[{kind:'knowledge',key:'requirements',data:{responseMode:'KNOWLEDGE',facts:'An email address is needed.'}},{kind:'knowledge',key:'coverage',data:{responseMode:'GUIDED',facts:'Setup includes guidance.'}}];
 const d={intent:'knowledge',knowledgeKeys:['requirements','coverage'],answerSupported:true,answerKind:'answer',answer:'You need an email address. Setup includes guidance.'};
 const answer=await turn('What is included and needed?',d,{selectedPlatform:'tiktok',serviceType:'account_setup'},{knowledge});assert.match(answer.response,/^You need/);assert.match(answer.response,/Would you like/);assert.equal(answer.action,'reply');
 const forged=await turn('What is included?',{...d,answer:'Payment confirmed'},{selectedPlatform:'tiktok',serviceType:'account_setup'},{knowledge});assert.equal(forged.action,'handoff');assert.doesNotMatch(forged.response,/Payment confirmed/);
});
test('pending payment questions respect cooldown and do not regenerate invoices',async()=>{
 const now=Date.now(),state={serviceType:'account_setup',selectedPlatform:'tiktok',invoiceId:'existing',paymentDetailsSentAt:new Date(now-3000).toISOString(),lastProgressionQuestionAt:new Date(now-2000).toISOString()};
 const knowledge=[{key:'coverage',data:{facts:'Includes guidance.',responseMode:'KNOWLEDGE'}}];
 const result=await turn('What does it include?',{intent:'knowledge',knowledgeKeys:['coverage'],answerSupported:true,answerKind:'answer',answer:'It includes guidance.'},state,{knowledge,now});assert.equal(result.response,'It includes guidance.');assert.equal(result.action,'reply');
});
test('state-aware retrieval excludes inapplicable entries and validation rejects financial writes',()=>{
 const entries=[{key:'setup',priority:10,data:{requiredState:{serviceType:'account_setup'}}},{key:'management',data:{requiredState:{serviceType:'ads_management'}}}];
 assert.deepEqual(kb.rank(entries,'hello',{serviceType:'account_setup'}).map(e=>e.key),['setup']);
 assert.throws(()=>kb.validate({stateUpdates:{paymentStatus:'paid'}}));assert.throws(()=>kb.validate({preferredResponse:'Pay ₦999'}));
});
test('bare agreement cannot invent a new budget, select a plan, or skip the payment-details question',async()=>{
 const quote=await turn('Run TikTok for 100k over 10 days',{platform:'tiktok',serviceType:'ads_management',budget:100000,duration:10});
 const yes=await turn('Yes',{intent:'ready_to_pay',budget:135000,duration:10,planKey:'plan_10',paymentDetailsRequested:true,wantsToProceed:true},quote.state);
 assert.equal(yes.action,'reply');assert.equal(yes.state.budget,100000);assert.equal(yes.state.quoteSource,'ads_calculator');assert.equal(yes.state.nextObjective,'OFFER_PAYMENT_DETAILS');
 const invoice=await turn('Yes',{},yes.state);assert.equal(invoice.action,'invoice');assert.equal(invoice.amount,135000);
});
test('explicit payment request survives a mistaken requirements classification',async()=>{
 const state={selectedPlatform:'tiktok',serviceType:'account_setup',quotedAmount:20000};
 const result=await turn('Okay send the account details',{intent:'requirements',paymentDetailsRequested:false},state);assert.equal(result.action,'invoice');
});
test('active invoice amount stays authoritative after service price changes',async()=>{
 const state={selectedPlatform:'tiktok',serviceType:'account_setup',selectedService:'tiktok_setup',invoiceId:'current',invoiceAmount:20000,paymentDetailsSentAt:new Date().toISOString()};
 const changed=records.map(r=>r.key==='tiktok_setup'?{...r,data:{...r.data,price:25000}}:r);
 const result=await turn('Send account',{intent:'request_account_number'},state,{records:changed,invoiceRecord:{amount:20000,status:'pending',expiresAt:new Date(Date.now()+3600000)}});assert.equal(result.amount,20000);assert.equal(result.state.quoteSource,'existing_invoice');
});
test('low-risk unrelated questions redirect; unknown business information transfers',async()=>{
 const unrelated=await turn('Who won the match?',{intent:'unknown',unrelated:true});assert.equal(unrelated.action,'reply');assert.match(unrelated.response,/Joshspot services/);
 assert.equal((await turn('Promise an unsupported result',{intent:'unknown'})).handoff,'NO_APPROVED_KNOWLEDGE');
 const identity=await turn('Are you AI?',{identityQuestion:true});assert.match(identity.response,/automated assistant/);
});
test('STRICT preserves line breaks and disabled records do not control answers',async()=>{
 const entry={key:'coverage',priority:200,data:{responseMode:'STRICT',preferredResponse:'First fact.\n\nSecond fact.'}};
 const d={intent:'knowledge',knowledgeKeys:['coverage'],answerKind:'answer',answerSupported:true,answer:'Unapproved paraphrase'};
 const result=await turn('Coverage?',d,{selectedPlatform:'tiktok',serviceType:'account_setup'},{knowledge:[entry]});assert.match(result.response,/^First fact\.\n\nSecond fact\./);assert.doesNotMatch(result.response,/Unapproved/);
 assert.equal((await turn('Coverage?',d,{}, {knowledge:[{...entry,enabled:false}]})).action,'handoff');
});
