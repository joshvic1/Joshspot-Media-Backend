const {test,afterEach}=require('node:test');

const assert=require('node:assert/strict');

const fs=require('node:fs');

const engine=require('./engine'),provider=require('./provider'),defaults=require('./defaults'),kb=require('./structuredKnowledge');

const original=provider.interpret;afterEach(()=>{provider.interpret=original;});

const config={...defaults.config,structuredSales:true,invoicesEnabled:true};

const records=[...defaults.records,...kb.seeds];

test('negotiation safeguards refuse counteroffers without changing prices or advancing payment',async()=>{
 const state={serviceType:'account_setup',selectedPlatform:'tiktok',quotedAmount:20000,lastRequiredQuestion:'CONFIRM_PROCEED'};
 for(const text of ['Negotiable?','Any discount?','What is your last price?','Can you reduce the price?','Too expensive','Can you accept 15k?','Let’s do 15k','Bring it down','Meet me halfway']){
  const r=await turn(text,{budget:15000,declines:true},state);
  assert.match(r.response,/Sorry boss, it's not negotiable\. That's the last price\./,text);assert.match(r.response,/20,000/);assert.equal(r.amount,20000);assert.equal(r.state.budget,undefined);assert.match(r.response,/Would you like to proceed/);
 }
 const early=await turn('Negotiable?',{}, {serviceChoiceConfirmed:false});assert.match(early.response,/not negotiable/);assert.equal(early.state.lastRequiredQuestion,'GET_SERVICE_TYPE');assert.doesNotMatch(early.response,/Would you like to proceed/);
 const ready=await turn('Any discount?',{}, {...state,customerWantsToProceed:true});assert.match(ready.response,/account details/);
 const pending=await turn('Reduce it',{}, {...state,selectedService:'tiktok_setup',invoiceId:'existing',paymentDetailsSentAt:new Date().toISOString()});assert.match(pending.response,/invoice remains unchanged/);assert.equal(pending.action,'reply');assert.doesNotMatch(pending.response,/Would you like to proceed|Have you made payment/);
 const paused=await turn('Best price?',{}, {...state,salesPaused:true});assert.equal(paused.state.salesPaused,true);assert.doesNotMatch(paused.response,/Would you like to proceed/);
 const payment=await turn('Can you accept bank transfer?',{},state);assert.notEqual(payment.debug.pricePolicy,'NON_NEGOTIABLE');
});

test('Pricelessworth: option choices advance despite an irrelevant setup explanation',async()=>{
 const stale={serviceChoiceConfirmed:false,selectedPlatform:'tiktok',lastRequiredQuestion:'GET_SERVICE_TYPE'};
 const wrongAnswer={serviceType:'account_setup',knowledgeKeys:['setup_budget_separate'],answerKind:'answer',answerSupported:true,answer:'The setup fee covers account setup and guidance. Your advertising budget is separate.'};
 for(const text of ['Option 1','Option one','First option','I choose option one','I like the set up then I can run the ad at my own pace']){
  const r=await turn(text,wrongAnswer,stale);
  assert.equal(r.state.serviceChoiceConfirmed,true,text);assert.equal(r.state.serviceType,'account_setup');assert.equal(r.amount,20000);
  assert.match(r.response,/20,000/);assert.match(r.response,/Would you like to proceed/);assert.doesNotMatch(r.response,/fee covers/);
 }
 for(const text of ['Option 2','Option two','Second option']){
  const r=await turn(text,wrongAnswer,stale);assert.equal(r.state.serviceType,'ads_management');assert.equal(r.state.lastRequiredQuestion,'GET_BUDGET_DURATION');assert.doesNotMatch(r.response,/fee covers/);
 }
 const unknownPlatform=await turn('Option one',wrongAnswer,{serviceChoiceConfirmed:false,lastRequiredQuestion:'GET_SERVICE_TYPE'});
 assert.equal(unknownPlatform.state.lastRequiredQuestion,'GET_PLATFORM');assert.equal(unknownPlatform.amount,undefined);
 const unrelatedOption=await turn('Option one',wrongAnswer,{serviceChoiceConfirmed:false,lastRequiredQuestion:'SELECT_PLAN'});
 assert.equal(unrelatedOption.state.serviceChoiceConfirmed,false);
});

test('Pricelessworth: repetition complaint recovers missed customer choice, never assistant inference',async()=>{
 const stale={serviceChoiceConfirmed:false,selectedPlatform:'tiktok',lastRequiredQuestion:'GET_SERVICE_TYPE'};
 const answer='The setup fee covers account setup and guidance. Your advertising budget is separate.';
 const decision={intent:'knowledge',knowledgeKeys:['setup_budget_separate'],answerKind:'answer',answerSupported:true,answer};
 const history=[{direction:'inbound',text:'Option 1'},{direction:'outbound',text:answer,status:'sent'}];
 const r=await turn('You said so',decision,stale,{history});
 assert.equal(r.amount,20000);assert.match(r.response,/20,000/);assert.equal(r.debug.recoveredServiceChoice,true);assert.doesNotMatch(r.response,/fee covers/);
 const next=await turn('You already said that',decision,r.state,{history:[...history,{direction:'outbound',text:r.response,status:'sent'}]});
 assert.equal(next.response,'Would you like to proceed?');assert.equal(next.action,'reply');
 const noEvidence=await turn('You said so',{...decision,intent:'advertising'},stale,{history:[{direction:'outbound',text:'Option 1'}]});
 assert.equal(noEvidence.state.serviceChoiceConfirmed,false);assert.equal(noEvidence.amount,undefined);
 const negotiate=await turn('Negotiable?',{negotiating:true},r.state);assert.match(negotiate.response,/not negotiable/);assert.match(negotiate.response,/20,000/);
});

test('repeated factual copy yields to progression, but a request to explain again is respected',async()=>{
 const answer=kb.seeds.find(e=>e.key==='setup_budget_separate').data.preferredResponse;
 const decision={intent:'knowledge',knowledgeKeys:['setup_budget_separate'],answerKind:'answer',answerSupported:true,answer};
 const state={selectedPlatform:'tiktok',serviceType:'account_setup',lastRequiredQuestion:'CONFIRM_PROCEED'};
 const history=[{direction:'outbound',text:answer,status:'sent'}];
 const next=await turn('Okay then',decision,state,{history});assert.equal(next.action,'reply');assert.match(next.response,/20,000/);assert.doesNotMatch(next.response,/fee covers/);assert.equal(next.debug.repeatedAnswerSuppressed,true);
 const repeat=await turn('Explain again what the fee covers',decision,state,{history});assert.match(repeat.response,/fee covers/);
});

async function turn(text,decision={},state={},extra={}){provider.interpret=async()=>({intent:'advertising',confidence:.99,platform:null,serviceType:null,budget:null,duration:null,answer:'',answerKind:'none',budgetBasis:'total',serviceChoiceExplicit:true,...decision});return engine.decide({text,state:{serviceChoiceConfirmed:true,...state},config,records,knowledge:[],...extra});}

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



test('expected-results answer survives a missing optional sales prompt',async()=>{

 const entry={kind:'knowledge',key:'expected_views',enabled:true,data:{schemaVersion:1,responseMode:'GUIDED',allowContext:true,preferredResponse:'Exact views cannot be guaranteed.',facts:'Results depend on creative quality.'}};

 for(const text of ['How many views will the 60K package get me?','How much engagement will I get?','If I do the 10 days package how many views will I get?']) {

  const result=await turn(text,{intent:'knowledge',answerKind:'answer',answerSupported:true,knowledgeKeys:['expected_views'],answer:'Exact views cannot be guaranteed.'},{},{records:[],knowledge:[entry]});

  assert.equal(result.action,'reply');assert.equal(result.response,'Exact views cannot be guaranteed.');assert.equal(result.debug.missingKnowledgeKey,'ads_service_clarification');

 }

});

test('missing sales rules do not authorize unsupported answers',async()=>{

 const result=await turn('How many views?',{intent:'knowledge',answerKind:'none',answerSupported:false},{},{records:[],knowledge:[]});assert.equal(result.action,'handoff');

});

test('custom quotes and selected plan explanations reuse calculator breakdown copy',async()=>{

 const custom=await turn('Run TikTok for 100k over 10 days',{platform:'tiktok',serviceType:'ads_management',budget:100000,duration:10});

 assert.equal(custom.action,'reply');assert.match(custom.response,/Here's a breakdown/);assert.match(custom.response,/10,000 daily/);assert.match(custom.response,/135,000/);

 const selected=await turn('10 days. How does it work?',{intent:'advertising',duration:10,asksBreakdown:true},{selectedPlatform:'tiktok',serviceType:'ads_management',lastRequiredQuestion:'SELECT_PLAN',budget:20000});

 assert.equal(selected.action,'reply');assert.equal(selected.amount,135000);assert.match(selected.response,/100,000 advertising budget/);assert.match(selected.response,/35,000/);

});



test('platform reply skips unrelated handoff requirements',async()=>{

 const custom=records.map(r=>r.key==='tiktok_setup'?{...r,data:{...r.data,requirements:'Hold on please. You will receive a response shortly.'}}:r);

 const r=await turn('TikTok',{intent:'requirements',platform:'tiktok',answerKind:'answer',answerSupported:true,knowledgeKeys:['setup_requirements'],answer:'Hold on please.'},{serviceType:'account_setup',lastRequiredQuestion:'GET_PLATFORM'},{records:custom});assert.equal(r.action,'reply');assert.match(r.response,/20,000/);

});

test('counteroffer retains authoritative price',async()=>{

 const r=await turn("Let's do 15k",{intent:'advertising',budget:15000,declines:true},{serviceType:'account_setup',selectedPlatform:'tiktok',quotedAmount:20000});assert.equal(r.action,'reply');assert.match(r.response,/not negotiable/);assert.match(r.response,/20,000/);assert.match(r.response,/Would you like to proceed/);

});



test('daily custom budget and duration produce 35000 without package fee duplication',async()=>{

 const a=await turn('5K',{budget:5000,budgetBasis:'unspecified'},{serviceType:'ads_management',selectedPlatform:'tiktok'});

 const b=await turn('2 days',{duration:2,budgetBasis:'unspecified'},a.state);assert.equal(b.amount,35000);assert.equal(b.debug.calculator.advertisingBudget,10000);

 const pkg=await turn('a week',{duration:7,budget:60000,planKey:'plan_7'},{serviceType:'ads_management',selectedPlatform:'tiktok',lastRequiredQuestion:'SELECT_PLAN'});assert.equal(pkg.amount,60000);

});

test('generic ads request must clarify service before quoting or collecting budget',async()=>{

 const r=await turn('I want to run ads',{serviceType:'ads_management',serviceChoiceExplicit:false},{serviceChoiceConfirmed:false});assert.equal(r.state.nextObjective,'GET_SERVICE_TYPE');

 const t=await turn('TikTok',{platform:'tiktok',serviceType:'ads_management',serviceChoiceExplicit:false},r.state);assert.equal(t.state.nextObjective,'GET_SERVICE_TYPE');assert.equal(t.amount,undefined);

});



test('duration-only request cannot invent a custom advertising budget',async()=>{

 const r=await turn('I would like to run the ads for a week',{duration:7,budget:60000},{serviceType:'ads_management',selectedPlatform:'tiktok',lastRequiredQuestion:'GET_BUDGET_DURATION'});

 assert.equal(r.amount,60000);assert.equal(r.state.budgetBasis,'package');assert.equal(r.state.quoteSource,'plan:plan_7');

});



test('deferred payment and refusal override mistaken readiness flags',async()=>{

 for(const text of ['Let me speak with my coach so we can make payments soon','No. Once I agree with him I’ll hit you up asap']){

 const r=await turn(text,{intent:'ready_to_pay',wantsToProceed:true,paymentDetailsRequested:true},{serviceType:'ads_management',selectedPlatform:'tiktok',quotedAmount:45000,customerWantsToProceed:true,lastRequiredQuestion:'OFFER_PAYMENT_DETAILS'});

 assert.equal(r.action,'reply');assert.equal(r.state.salesPaused,true);assert.equal(r.state.customerWantsToProceed,false);assert.equal(r.state.paymentDetailsRequested,false);assert.doesNotMatch(r.response,/account details|proceed/i);

 }

});

test('daily-cost followup answers recommended plan spend without repeating discovery',async()=>{

 const r=await turn('Daily is how much?',{intent:'advertising'},{serviceType:'ads_management',selectedPlatform:'tiktok',lastRequiredQuestion:'SELECT_PLAN'});

 assert.equal(r.action,'reply');assert.match(r.response,/5,000 daily ad spend/);assert.match(r.response,/60,000 total/);assert.doesNotMatch(r.response,/what is your.*budget/i);

});





test('Universe all and all of them select both platforms without asking platform again',async()=>{

 for(const text of ['All','All of them','Both']){

  const r=await turn(text,{}, {serviceType:'ads_management',lastRequiredQuestion:'GET_PLATFORM'});

  assert.deepEqual(r.state.selectedPlatforms,['tiktok','meta']);assert.match(r.response,/TikTok/);assert.match(r.response,/Meta/);assert.match(r.response,/60,000/);assert.doesNotMatch(r.response,/Which platform do you want/);assert.equal(r.action,'reply');

 }

 const setup=await turn('All',{}, {serviceType:'account_setup',lastRequiredQuestion:'GET_PLATFORM'});assert.match(setup.response,/20,000/);assert.match(setup.response,/30,000/);

 const irrelevant=await turn('All',{}, {serviceType:'ads_management',selectedPlatform:'tiktok',lastRequiredQuestion:'SELECT_PLAN'});assert.equal(irrelevant.state.selectedPlatforms,undefined);

});

test('Belvia uncertainty persists as recommendation guidance even if intent is advertising',async()=>{

 const r=await turn("I don't know how much it's always",{}, {serviceType:'ads_management',selectedPlatform:'tiktok',lastRequiredQuestion:'GET_BUDGET_DURATION'});

 assert.match(r.response,/60,000/);assert.equal(r.state.lastRequiredQuestion,'SELECT_PLAN');assert.equal(r.state.needsBudgetGuidance,true);

 const next=await turn('What do you advise?',{},r.state);assert.doesNotMatch(next.response,/What is your budget/);

});

test('Universe duration without money selects inclusive plan even if model invents budget',async()=>{

 const r=await turn('A week on the minimum',{duration:7,budget:60000},{serviceType:'ads_management',selectedPlatform:'tiktok',lastRequiredQuestion:'GET_BUDGET_DURATION'});

 assert.equal(r.amount,60000);assert.equal(r.state.quoteSource,'plan:plan_7');

 const breakdown=await turn('Give me the breakdown',{asksBreakdown:true},r.state);

 assert.equal(breakdown.debug.calculator.advertisingBudget,35000);assert.equal(breakdown.debug.calculator.managementFee,25000);assert.equal(breakdown.debug.calculator.total,60000);assert.doesNotMatch(breakdown.response,/85,000/);

 const longer=await turn('Make it 10 days',{duration:10},r.state);assert.equal(longer.amount,135000);assert.equal(longer.state.budgetBasis,'package');

});

test('supported followup in advertising intent answers the concern without repeating platform prompt',async()=>{

 const knowledge=[{kind:'knowledge',key:'help',data:{responseMode:'KNOWLEDGE',facts:'Account setup includes guidance.'}}];

 const r=await turn('I have no social account or followers',{intent:'advertising',knowledgeKeys:['help'],answerSupported:true,answerKind:'answer',answer:'We offer account setup with guidance.'},{serviceType:'ads_management',lastRequiredQuestion:'GET_PLATFORM'},{knowledge});

 assert.equal(r.response,'We offer account setup with guidance.');assert.equal(r.debug.repeatedQuestionSuppressed,true);

});



test('Odera: personal account question cannot imply Meta even with confident model extraction',async()=>{
 const r=await turn("Good evening. Please can I use a personal account to run ads manager? I can't convert to business account",{intent:'knowledge',platform:'meta',platforms:['meta'],answerKind:'answer',answerSupported:true,answer:'On Meta you need a business account.'},{serviceChoiceConfirmed:false});
 assert.equal(r.state.selectedPlatform,undefined);assert.equal(r.state.lastRequiredQuestion,'GET_PLATFORM');assert.doesNotMatch(r.response,/you need a business account/i);assert.equal(r.debug.qualification.platformInferenceBlocked,true);
 const corrected=await turn("Tiktok isn't Meta nah",{platform:'meta',platforms:['meta']},{selectedPlatform:'meta',serviceChoiceConfirmed:false});assert.equal(corrected.state.selectedPlatform,'tiktok');
});
test('KENNCOMFORT: page conversion, follower count and sales advice do not select setup',async()=>{
 const r=await turn('Hi, I have a tiktok page that I want to convert to business page, I have 3k followers. What do you think and how can I run ads on that account that will bring sales?',{intent:'recommendation',platform:'tiktok',platforms:['tiktok'],serviceType:'account_setup',serviceChoiceExplicit:true,needsRecommendation:true},{serviceChoiceConfirmed:false});
 assert.equal(r.state.selectedPlatform,'tiktok');assert.equal(r.state.serviceChoiceConfirmed,false);assert.equal(r.state.serviceType,undefined);assert.equal(r.state.lastRequiredQuestion,'GET_SERVICE_TYPE');assert.equal(r.amount,undefined);assert.doesNotMatch(r.response,/20,000/);
 const choice=await turn('Second option',{serviceType:'account_setup'},r.state);assert.equal(choice.state.serviceType,'ads_management');assert.equal(choice.state.selectedPlatform,'tiktok');assert.equal(choice.state.lastRequiredQuestion,'GET_BUDGET_DURATION');
});
test('knowledge matching cannot silently set platform or service and generic ads cannot confirm setup',async()=>{
 const knowledge=[{kind:'knowledge',key:'bad_selection',data:{responseMode:'KNOWLEDGE',stateUpdates:{selectedPlatform:'meta',serviceType:'account_setup'}}}];
 const r=await turn('How can I run ads?',{serviceType:'account_setup',serviceChoiceExplicit:true,knowledgeKeys:['bad_selection']},{serviceChoiceConfirmed:false},{knowledge});assert.equal(r.state.selectedPlatform,undefined);assert.equal(r.state.serviceType,undefined);assert.equal(r.state.lastRequiredQuestion,'GET_SERVICE_TYPE');
});
test('explicit setup and management requests remain supported and known platform is retained',async()=>{
 const setup=await turn('Please set up my TikTok ads account',{platform:'tiktok',serviceType:'account_setup'},{serviceChoiceConfirmed:false});assert.equal(setup.amount,20000);
 const managed=await turn('I would love you run it for me',{serviceType:'ads_management'},{serviceChoiceConfirmed:false,selectedPlatform:'tiktok',lastRequiredQuestion:'GET_SERVICE_TYPE'});assert.equal(managed.state.serviceType,'ads_management');assert.equal(managed.state.lastRequiredQuestion,'GET_BUDGET_DURATION');
});
