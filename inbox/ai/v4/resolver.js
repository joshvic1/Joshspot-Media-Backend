const {createHash}=require('node:crypto');
const {platform,retrieve}=require('./knowledge');
const pricing=require('../v3/pricing'); // Pure business adapter; V3 conversation core is never invoked.
const schema=require('./schema');
const key=i=>`${platform(i.platform)}:${i.service}`;
const dbService=s=>({ACCOUNT_SETUP:'account_setup',ADS_MANAGEMENT:'ads_management',COURSE:'course'}[s]);
function evidence(e,messages){return !!e&&e.text.trim().length>0&&messages.some(m=>String(m._id)===e.messageId&&String(m.text).includes(e.text));}
function validate(plan,messages){
 if(!schema.valid(schema.interpreter,plan))throw new Error('V4_INVALID_INTERPRETATION');
 if(new Set(plan.current_requests.map(r=>r.id)).size!==plan.current_requests.length)throw new Error('V4_DUPLICATE_REQUEST');
 for(const r of [...plan.current_requests,...plan.facts])if(!evidence(r.evidence,messages))throw new Error('V4_CURRENT_EVIDENCE_REQUIRED');
 if(!['KEEP','NONE'].includes(plan.purchase_change.operation)&&(!evidence(plan.purchase_change.evidence,messages)||plan.purchase_change.items.some(i=>!evidence(i.evidence,messages))))throw new Error('V4_PURCHASE_EVIDENCE_REQUIRED');
 if(plan.readiness.value!=='UNKNOWN'&&!evidence(plan.readiness.evidence,messages))throw new Error('V4_READINESS_EVIDENCE_REQUIRED');
 if(plan.whole_purchase_cap&&!evidence(plan.whole_purchase_cap.evidence,messages))throw new Error('V4_CAP_EVIDENCE_REQUIRED');
}
async function resolve({plan,state,messages,records,ports,simulation=true,config={}}){
 validate(plan,messages);await ports.assertCurrent();
 records=records.filter(r=>r.enabled!==false&&!r.archived);
 const revision=createHash('sha256').update(JSON.stringify(records.map(r=>[r.key,r.revision,r.data]))).digest('hex');
 const next=structuredClone(state),operations=[],missing=new Set(),facts=[],actions={};
 next.purchaseItems||=[];next.ownership||='AI';
 if(next.ownership==='HUMAN')throw new Error('V4_HUMAN_OWNS_CONVERSATION');
 const pack={requests:plan.current_requests,priorUnresolved:state.unresolvedRequests||[],purchase:[],customerFacts:plan.facts,facts,knowledge:[],plans:[],quote:null,actions,missing:[],allowedQuestions:[],readiness:plan.readiness.value,verifiedPayment:null};
 const service=(p,s)=>{const rows=records.filter(r=>r.kind==='service'&&r.data.serviceType===dbService(s)&&(s==='COURSE'||r.data.platforms?.includes(platform(p).toLowerCase())));return rows.length===1?rows[0]:null;};
 function fact(role,value,source,field,p='UNKNOWN',s='UNKNOWN'){facts.push({type:typeof value==='number'?'MONEY':'FACT',role,value,source,field,platform:p,service:s});}
 const stopHuman=plan.current_requests.some(r=>r.type==='REQUEST_HUMAN');
 // Human escalation has priority over optional business retrieval, but only its
 // own current evidence is needed; no old requests are synthesized here.
 if(stopHuman){await ports.assertCurrent();actions.handoff=simulation?{simulation:true,accepted:true,reason:'CUSTOMER_REQUESTED_HUMAN'}:await ports.handoff({reason:'CUSTOMER_REQUESTED_HUMAN',summary:'Customer explicitly requested a member of staff.'});if(actions.handoff.accepted||actions.handoff.pending)next.ownership='HUMAN';operations.push('handoff');pack.purchase=next.purchaseItems;return {pack,next,operations};}
 const before=JSON.stringify(next.purchaseItems),change=plan.purchase_change;
 const selected=[...new Map(change.items.map(i=>({platform:platform(i.platform),service:i.service,status:'confirmed',evidenceMessageId:i.evidence.messageId,evidenceText:i.evidence.text})).map(i=>[key(i),i])).values()];
 if(change.operation==='REPLACE'&&JSON.stringify(selected.map(key).sort())!==JSON.stringify(next.purchaseItems.map(key).sort()))next.purchaseCap=null;
 if(change.operation==='REPLACE')next.purchaseItems=selected;
 if(change.operation==='ADD')next.purchaseItems=[...new Map([...next.purchaseItems,...selected].map(i=>[key(i),i])).values()];
 if(change.operation==='REMOVE')next.purchaseItems=next.purchaseItems.filter(i=>!selected.some(x=>key(x)===key(i)));
 for(const f of plan.facts){
  const matches=next.purchaseItems.filter(i=>(f.platform==='UNKNOWN'||i.platform===platform(f.platform))&&(f.service==='UNKNOWN'||i.service===f.service));
  if(matches.length!==1){if(f.budget||f.duration_days||f.package_duration_days)missing.add('allocation');continue;}
  const i=matches[0];
  if(f.budget&&f.budget.basis!=='COUNTEROFFER'){i.budget=f.budget;i.packageDuration=null;}
  if(f.duration_days){i.duration=f.duration_days;if(i.packageDuration&&i.packageDuration!==f.duration_days)i.packageDuration=null;}
  if(f.package_duration_days){i.packageDuration=f.package_duration_days;i.duration=f.package_duration_days;i.budget=null;}
 }
 if(plan.readiness.value!=='UNKNOWN')next.readiness=plan.readiness.value;
 if(plan.whole_purchase_cap)next.purchaseCap=plan.whole_purchase_cap.amount;
 if(before!==JSON.stringify(next.purchaseItems)||plan.whole_purchase_cap||next.currentQuote?.catalogueRevision!==revision)next.currentQuote=null;
 pack.readiness=next.readiness||'UNKNOWN';pack.purchase=next.purchaseItems;
 const requestTypes=new Set(plan.current_requests.map(r=>r.type));
 const payment=await ports.invoiceStatus(requestTypes.has('CLAIM_PAYMENT'));
 actions.payment={...payment,simulation};next.activeInvoice=payment.id?payment:null;next.verifiedPayment=payment.status==='paid'?payment:null;pack.verifiedPayment=next.verifiedPayment;
 operations.push(requestTypes.has('CLAIM_PAYMENT')?'verify_payment':'read_invoice');
 const needs=[...plan.knowledge_needs];
 for(const r of plan.current_requests)if(['ASK_REQUIREMENTS','ASK_SERVICE_INCLUSIONS','ASK_EXPECTED_RESULTS','ASK_CREATIVE_REQUIREMENTS','ASK_TECHNICAL_HELP','ASK_COURSE_DETAILS','NEGOTIATE'].includes(r.type)&&!needs.some(n=>n.topic===r.type&&n.platform===r.platform&&n.service===r.service))needs.push({topic:r.type,platform:r.platform,service:r.service,query:''});
 const scopes=[...next.purchaseItems,...plan.current_requests];
 const seen=new Set();
 for(const i of scopes){const r=service(i.platform,i.service);if(!r||seen.has(r.key))continue;seen.add(r.key);operations.push('resolve_service');
  if(r.data.price>0)fact(i.service==='COURSE'?'course_price':'setup_fee',r.data.price,r.key,'data.price',platform(i.platform),i.service);
  if(r.data.requirements)fact('requirements',r.data.requirements,r.key,'data.requirements',platform(i.platform),i.service);
  if(r.data.description)fact('description',r.data.description,r.key,'data.description',platform(i.platform),i.service);
  if(r.data.checkoutUrl)fact('url',r.data.checkoutUrl,r.key,'data.checkoutUrl',platform(i.platform),i.service);
 }
 for(const n of needs){const rows=retrieve(records,n);pack.knowledge.push(...rows);operations.push(`knowledge:${n.topic}`);}
 pack.knowledge=[...new Map(pack.knowledge.map(k=>[k.source,k])).values()].slice(0,9);
 if(requestTypes.has('ASK_RECOMMENDATION')||next.purchaseItems.some(i=>i.packageDuration)||requestTypes.has('ASK_BREAKDOWN')){pack.plans=(await pricing.plans(records)).filter(p=>p.quotable);operations.push('recommended_plans');for(const p of pack.plans){fact('total',p.amount,p.key,'data.amount');fact('advertising_budget',p.breakdown.advertisingBudget,p.key,'breakdown.advertisingBudget');fact('management_fee',p.breakdown.managementFee,p.key,'breakdown.managementFee');}}
 const quoteNeeded=['ASK_PRICE','ASK_QUOTE','ASK_BREAKDOWN','ASK_PAYMENT_DETAILS'].some(t=>requestTypes.has(t))||plan.facts.some(f=>f.package_duration_days||f.duration_days||f.budget&&f.budget.basis!=='COUNTEROFFER');
 if(quoteNeeded&&next.purchaseItems.length&&next.purchaseItems.every(i=>i.service!=='COURSE')){
  const items=[];let setupTotal=0;const management=next.purchaseItems.filter(i=>i.service==='ADS_MANAGEMENT');
  for(const i of next.purchaseItems){
   if(!['TIKTOK','META'].includes(i.platform)){missing.add('platform');continue;}
   const r=service(i.platform,i.service);if(!r){missing.add('clarification');continue;}
   if(i.service==='ACCOUNT_SETUP'){setupTotal+=r.data.price;items.push({platform:i.platform.toLowerCase(),service:'account_setup',budget:null,budgetBasis:null,duration:null,planKey:null,creativeMode:'testing',creatives:1});continue;}
   if(i.service!=='ADS_MANAGEMENT'){missing.add('service');continue;}
   let budget=i.budget?.amount,basis={DAILY_AD_SPEND:'DAILY_AD_SPEND',TOTAL_AD_SPEND:'TOTAL_AD_SPEND',ALL_IN_MAXIMUM:'ALL_IN_BUDGET'}[i.budget?.basis],planKey=null;
   if(i.packageDuration){const plans=pack.plans.filter(p=>p.duration===i.packageDuration&&p.platforms.includes(i.platform.toLowerCase()));if(plans.length===1){planKey=plans[0].key;basis='PACKAGE';budget=null;}else missing.add('package');}
   if(!i.duration)missing.add('duration');
   if(!basis&&!next.purchaseCap)missing.add(i.budget?'budget_basis':'budget');
   items.push({platform:i.platform.toLowerCase(),service:'ads_management',budget:budget??null,budgetBasis:basis||null,duration:i.duration||null,planKey,creativeMode:'testing',creatives:2});
  }
  if(next.purchaseCap){if(management.length===1&&!management[0].packageDuration){const m=items.find(i=>i.service==='ads_management');if(m){m.budget=next.purchaseCap-setupTotal;m.budgetBasis='ALL_IN_BUDGET';if(m.budget<=0)missing.add('budget');}}else if(management.length>1)missing.add('allocation');}
  if(!missing.size){try{next.currentQuote=await pricing.quote(items,records,Date.now(),next.purchaseCap??null);next.currentQuote.catalogueRevision=revision;operations.push('calculate_quote');}catch(e){pack.resolutionError=e.code||e.message;missing.add('clarification');}}
 }
 pack.quote=next.currentQuote;
 if(pack.quote){for(const l of pack.quote.lines){for(const [k,role]of Object.entries({total:'total',advertisingBudget:'advertising_budget',managementFee:'management_fee',setupFee:'setup_fee'}))if(l[k]>0)fact(role,l[k],pack.quote.id,`lines.${l.key}.${k}`,l.platform.toUpperCase(),l.key.endsWith('account_setup')?'ACCOUNT_SETUP':'ADS_MANAGEMENT');}fact('total',pack.quote.total,pack.quote.id,'total');}
 if(requestTypes.has('NEGOTIATE'))fact('policy',"Sorry boss, it's not negotiable. That's the last price.",'owner-policy','negotiation');
 if(quoteNeeded&&!next.purchaseItems.length)missing.add('service');
 if(plan.clarification.needed)for(const f of plan.clarification.missing_fields)missing.add(f);
 if(next.purchaseItems.length){missing.delete('service');if(next.purchaseItems.every(i=>i.platform!=='UNKNOWN'))missing.delete('platform');if(next.purchaseItems.every(i=>i.service!=='ADS_MANAGEMENT')){missing.delete('budget');missing.delete('duration');missing.delete('budget_basis');}}
 // Missing customer inputs permit clarification. Missing business knowledge must
 // stop before invoice execution and must never be filled with model guesses.
 const factualTypes=new Set(['ASK_REQUIREMENTS','ASK_SERVICE_INCLUSIONS','ASK_EXPECTED_RESULTS','ASK_CREATIVE_REQUIREMENTS','ASK_TECHNICAL_HELP','ASK_COURSE_DETAILS']);
 const scoped=(r,f)=>(r.platform==='UNKNOWN'||f.platform==='UNKNOWN'||platform(r.platform)===f.platform)&&(r.service==='UNKNOWN'||r.service===f.service);
 const unresolved=plan.current_requests.filter(r=>{
  if(['ASK_PRICE','ASK_QUOTE','ASK_BREAKDOWN','ASK_PAYMENT_DETAILS'].includes(r.type)&&r.service!=='UNKNOWN'&&r.platform!=='UNKNOWN'&&!service(r.platform,r.service))return true;
  if(r.type==='ASK_RECOMMENDATION'&&!pack.plans.length)return true;
  if(!factualTypes.has(r.type)&&!needs.some(n=>n.topic===r.type))return false;
  if(pack.knowledge.some(k=>k.topic===r.type&&retrieve(records,{topic:r.type,platform:r.platform,service:r.service,query:''}).some(x=>x.source===k.source)))return false;
  if(r.type==='ASK_REQUIREMENTS'&&facts.some(f=>f.role==='requirements'&&scoped(r,f)))return false;
  if(r.type==='ASK_COURSE_DETAILS'&&facts.some(f=>f.role==='course_price'&&scoped(r,f))&&facts.some(f=>f.role==='url'&&scoped(r,f)))return false;
  // These requests resolve through authoritative tools, not mandatory KB text.
  if(['ASK_PRICE','ASK_QUOTE','ASK_BREAKDOWN','ASK_RECOMMENDATION','ASK_PAYMENT_DETAILS','CLAIM_PAYMENT','NEGOTIATE'].includes(r.type))return false;
  return true;
 });
 next.unresolvedRequests=unresolved;pack.unresolvedRequests=unresolved;
 if(unresolved.length){pack.missing=[...missing];await require('./knowledgeHandoff').handoff({requests:unresolved,next,pack,ports,simulation,operations});return {pack,next,operations};}
 if(requestTypes.has('ASK_PAYMENT_DETAILS')&&!['DEFERRED','DECLINED'].includes(next.readiness)){
  if(next.readiness!=='READY_TO_PAY')missing.add('payment');
  else if(config.invoicesEnabled===false){pack.resolutionError='INVOICES_DISABLED';missing.add('clarification');}
  else if(next.currentQuote&&!missing.size){
   const q=next.currentQuote;
   if(Date.parse(q.expiresAt)<=Date.now())missing.add('clarification');
   else if(payment.status==='paid'||payment.id&&payment.quoteFingerprint!==q.fingerprint){pack.resolutionError='EXISTING_INVOICE_REQUIRES_REVIEW';missing.add('clarification');}
   else {await ports.assertCurrent();const operationId=`v4:${q.fingerprint}`;actions.invoice=simulation&&next.lastInvoiceOperation===operationId&&next.simulatedInvoice?next.simulatedInvoice:simulation?{simulation:true,wouldCreateInvoice:true,amount:q.total,status:'NOT_CREATED',quoteFingerprint:q.fingerprint}:await ports.createInvoice({quote:q,operationId});next.lastInvoiceOperation=operationId;if(simulation)next.simulatedInvoice=actions.invoice;operations.push('invoice');}
  }
 }
 pack.missing=[...missing];pack.allowedQuestions=[...missing].filter(f=>!(['payment','proceed'].includes(f)&&['DEFERRED','DECLINED'].includes(next.readiness)));
 if(!missing.size&&next.currentQuote&&!requestTypes.has('ASK_PAYMENT_DETAILS')&&!['DEFERRED','DECLINED'].includes(next.readiness)&&!next.verifiedPayment)pack.allowedQuestions.push('proceed');
 require('../questionContinuity').applyV4(pack);
 return {pack,next,operations};
}
module.exports={resolve,validate,evidence};
