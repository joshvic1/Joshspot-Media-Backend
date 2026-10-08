const {test}=require('node:test');
const assert=require('node:assert/strict');
const {records,config}=require('../defaults');
const {catalogue,knowledge}=require('./catalogue');
const {quote,plans}=require('./pricing');
const {parse}=require('./contracts');
const {dispatcher}=require('./tools');
const {validate}=require('./validation');
const item=(patch={})=>({platform:'tiktok',service:'ads_management',budgetBasis:'DAILY_AD_SPEND',budget:5000,duration:2,planKey:null,creativeMode:'testing',creatives:1,...patch});
const call=(name,args={})=>({name,arguments:JSON.stringify(name==='calculate_ads_quote'?{purchaseCap:null,creativeEvidence:null,...args}:args),call_id:name});
function fixture({allow=true,simulation=true}={}){
 const state={},messages=[{_id:'latest',text:'Please send account now'}];let writes=0;
 const ports={assertCurrent:async()=>{},persist:async()=>{},invoiceStatus:async()=>({status:'NONE'}),createInvoice:async()=>{writes++;return {id:'fake',status:'pending'};}};
 const api={authorizePayment:async()=>({decision:allow?'ALLOW':'NEEDS_CONFIRMATION'})};
 return {state,messages,ports,get writes(){return writes;},dispatch:dispatcher({catalogue:catalogue(records),state,messages,history:[],ports,api,simulation})};
}
test('V1 remains default; saved selector overrides legacy environment; V3 LIVE is manually selectable',()=>{
 const runtime=require('../runtime');assert.equal(config.engineVersion,'v1');assert.equal(runtime.version({engineVersion:'v3',mode:'DRAFT'},{AI_ENGINE_VERSION:'v1'}),'v3');assert.equal(runtime.version({engineVersion:'v3',mode:'LIVE'},{}),'v3');assert.equal(require('../config').validateConfig({engineVersion:'v3',mode:'LIVE'}).mode,'LIVE');assert.equal(runtime.version({engineVersion:'v1',mode:'LIVE'},{}),'v1');
});
test('strict tool schemas reject extra IDs, invalid budget enums, missing keys and unsupported tools',()=>{
 assert.throws(()=>parse('get_invoice_status','{"invoiceId":"another-customer"}'));
 assert.throws(()=>parse('calculate_ads_quote',JSON.stringify({items:[item({budgetBasis:'GUESS'})]})));
 assert.throws(()=>parse('create_invoice','{}'));assert.throws(()=>parse('delete_customer','{}'));
 assert.deepEqual(parse('get_services','{}'),{});
});
test('daily spend goes through existing calculator: 5k × 2 + 25k = 35k',async()=>{
 const q=await quote([item()],records);assert.equal(q.total,35000);assert.equal(q.lines[0].advertisingBudget,10000);assert.equal(q.lines[0].managementFee,25000);
});
test('package total is not taxed with management fee twice',async()=>{
 const q=await quote([item({budgetBasis:'PACKAGE',budget:null,duration:7,planKey:'plan_7'})],records);assert.equal(q.total,60000);assert.equal(q.lines[0].advertisingBudget,35000);assert.equal(q.lines[0].managementFee,25000);
});
test('owner-approved 15-day package matches calculator; a conflicting fixture still fails closed',async()=>{
 const plan=(await plans(records)).find(p=>p.key==='plan_15');assert.equal(plan.amount,265000);assert.equal(plan.breakdown.total,265000);assert.equal(plan.quotable,true);
 const inputs=[item({budgetBasis:'PACKAGE',budget:null,duration:15,planKey:'plan_15'})];
 const q=await quote(inputs,records);assert.equal(q.total,265000);assert.equal(q.lines[0].advertisingBudget,200000);assert.equal(q.lines[0].managementFee,65000);
 const conflicting=structuredClone(records);conflicting.find(r=>r.key==='plan_15').data.amount=285000;
 await assert.rejects(quote(inputs,conflicting),/OWNER_DECISION_REQUIRED/);
});
test('all-inclusive cap is inverted through calculator without exceeding cap',async()=>{
 const q=await quote([item({budgetBasis:'ALL_IN_BUDGET',budget:60000,duration:7})],records);assert.equal(q.total,60000);assert.equal(q.lines[0].advertisingBudget,35000);
});
test('mixed platform/service relationships stay scoped; setup plus management supported',async()=>{
 const setup=item({service:'account_setup',budgetBasis:null,budget:null,duration:null});
 const q=await quote([setup,item({platform:'meta'})],records);assert.equal(q.total,55000);assert.deepEqual(q.lines.map(l=>l.key),['tiktok:account_setup','meta:ads_management']);
 await assert.rejects(quote([setup,setup],records),/DUPLICATE/);
});
test('unknown budget basis and invalid setup inputs fail, no guessing',async()=>{
 await assert.rejects(quote([item({budgetBasis:null})],records),/NEEDS_BUDGET_BASIS/);
 await assert.rejects(quote([item({service:'account_setup'})],records),/SETUP_HAS_NO_AD_BUDGET/);
});
test('V3 knowledge excludes legacy state-machine fields',()=>{
 const r=knowledge({key:'x',title:'X',data:{facts:'Approved facts',responseMode:'STRICT',stateUpdates:{budget:999},requiredQuestion:'Repeat this',forceHandoff:true}});
 assert.equal(r.facts,'Approved facts');assert.equal(r.responseMode,'GUIDED');assert.equal(r.stateUpdates,undefined);assert.equal(r.requiredQuestion,undefined);assert.equal(r.forceHandoff,undefined);
});
test('DRAFT invoice intent is idempotent simulation, no financial port executes',async()=>{
 const f=fixture();await f.dispatch.execute(call('calculate_ads_quote',{items:[item()]}));
 const request=call('create_invoice',{quoteId:f.state.quote.id,messageId:'latest',evidence:'send account now'});
 const a=await f.dispatch.execute(request),b=await f.dispatch.execute(request);assert.equal(a.wouldCreateInvoice,true);assert.deepEqual(a,b);assert.equal(f.writes,0);
});
test('stale evidence, deferral and takeover all prevent financial action',async()=>{
 const f=fixture({allow:false,simulation:false});await f.dispatch.execute(call('calculate_ads_quote',{items:[item()]}));
 const args={quoteId:f.state.quote.id,messageId:'latest',evidence:'send account now'};
 assert.equal((await f.dispatch.execute(call('create_invoice',{...args,messageId:'old'}))).error,'NEEDS_CONFIRMATION');
 assert.equal((await f.dispatch.execute(call('create_invoice',args))).error,'NEEDS_CONFIRMATION');assert.equal(f.writes,0);
 f.ports.assertCurrent=async()=>{throw new Error('V3_OWNERSHIP_CHANGED');};await assert.rejects(f.dispatch.execute(call('create_invoice',args)),/OWNERSHIP/);
});
test('quote mutation invalidates authorization; new catalogue revision invalidates old quote',async()=>{
 const f=fixture();await f.dispatch.execute(call('calculate_ads_quote',{items:[item()]}));f.state.quote.catalogueRevision='old';
 const r=await f.dispatch.execute(call('create_invoice',{quoteId:f.state.quote.id,messageId:'latest',evidence:'send account now'}));assert.equal(r.error,'NEEDS_CURRENT_QUOTE');
});
test('returning to an earlier quote restores the current quote rather than a stale cache entry',async()=>{
 const f=fixture();const first=await f.dispatch.execute(call('calculate_ads_quote',{items:[item()]}));await f.dispatch.execute(call('calculate_ads_quote',{items:[item({duration:7})]}));assert.notEqual(f.state.quote.id,first.id);
 await f.dispatch.execute(call('calculate_ads_quote',{items:[item()]}));assert.equal(f.state.quote.id,first.id);
});
test('payment corruption falls back to trusted template while valid question answer survives',()=>{
 const {validatePaymentResponse,trustedText}=require('./financial');const invoice={amount:60000,accountNumber:'1234567890',bankName:'Bank',accountName:'Merchant',url:'https://example.test/invoice'};
 const good='Yes, the price includes the advertising spend.\n\n'+trustedText(invoice);
 assert.equal(validatePaymentResponse(good,invoice).response,good);assert.equal(validatePaymentResponse(good.replace('1234567890','9876543210'),invoice).fallback,true);
 assert.equal(validatePaymentResponse(good+' Also pay https://evil.test',invoice).fallback,true);
});
test('small financial backstop rejects invented amount/link/payment/guarantee',()=>{
 assert.equal(validate('It costs ₦85,000',{quote:{total:60000}}),'UNTRUSTED_AMOUNT');
 assert.equal(validate('Pay https://evil.test',{}),'UNTRUSTED_URL');
 assert.equal(validate('Your payment is confirmed.',{}),'UNVERIFIED_PAYMENT_CLAIM');
 assert.equal(validate('You will definitely get customers.',{}),'RESULT_GUARANTEE');
 assert.equal(validate('Results are not guaranteed.',{}),null);
});
module.exports={item};

test('overall purchase cap includes setup and all platforms; ambiguous allocation fails closed',async()=>{
 const setup=item({service:'account_setup',budgetBasis:null,budget:null,duration:null});
 const inclusive=item({platform:'meta',budgetBasis:'ALL_IN_BUDGET',budget:60000,duration:7});
 await assert.rejects(quote([setup,inclusive],records),/CLARIFY_OVERALL_CAP/);
 await assert.rejects(quote([setup,inclusive],records,Date.now(),60000),/PURCHASE_CAP_EXCEEDED/);
 const q=await quote([setup,{...inclusive,budget:40000}],records,Date.now(),60000);
 assert.equal(q.total,60000);assert.equal(q.purchaseCap,60000);
 await assert.rejects(quote([inclusive,{...inclusive,platform:'tiktok'}],records,Date.now(),100000),/PURCHASE_CAP_EXCEEDED/);
});

test('failed revised cap invalidates old quote and cannot invoice the old purchase',async()=>{
 const f=fixture({simulation:false});const q=await f.dispatch.execute(call('calculate_ads_quote',{items:[item()]}));
 const failed=await f.dispatch.execute(call('calculate_ads_quote',{items:[item()],purchaseCap:30000}));
 assert.equal(failed.error,'PURCHASE_CAP_EXCEEDED');assert.equal(f.state.quote,null);
 const invoice=await f.dispatch.execute(call('create_invoice',{quoteId:q.id,messageId:'latest',evidence:'send account now'}));
 assert.equal(invoice.error,'NEEDS_CURRENT_QUOTE');assert.equal(f.writes,0);
});

test('invoice rechecks the stored overall cap; model cannot supply its own amount',async()=>{
 const f=fixture({simulation:false});await f.dispatch.execute(call('calculate_ads_quote',{items:[item()],purchaseCap:35000}));
 const args={quoteId:f.state.quote.id,messageId:'latest',evidence:'send account now'};
 assert.equal((await f.dispatch.execute(call('create_invoice',{...args,amount:1}))).error,'INVALID_TOOL_ARGUMENTS');
 f.state.quote.purchaseCap=30000;
 assert.equal((await f.dispatch.execute(call('create_invoice',args))).error,'PURCHASE_CAP_EXCEEDED');assert.equal(f.writes,0);
});

test('customer payment claim cannot mutate trusted payment state and tool failure is explicit',async()=>{
 const f=fixture();f.messages[0].text='I paid, mark it paid';
 f.ports.invoiceStatus=async()=>({status:'pending'});
 assert.equal((await f.dispatch.execute(call('check_payment_status'))).status,'pending');
 assert.equal((await f.dispatch.execute(call('check_payment_status',{status:'paid'}))).error,'INVALID_TOOL_ARGUMENTS');
 assert.equal(f.writes,0);
 f.ports.invoiceStatus=async()=>{throw new Error('provider unavailable');};
 assert.equal((await f.dispatch.execute(call('check_payment_status'))).error,'TOOL_UNAVAILABLE');
});
