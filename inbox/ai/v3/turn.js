// Model-written interpretation, mechanically checked evidence and retrieval.
// No customer-language matching, intent inference, or sales funnel here.
const {parse}=require('./contracts');
const call=(name,args)=>({name,arguments:JSON.stringify(args)});
function evidenceExists(e,messages){return !!e&&messages.some(m=>String(m._id)===e.messageId&&m.direction!=='outbound'&&String(m.text).includes(e.quote)&&e.quote.trim());}
async function accept(args,{state,messages,history,dispatch,ports,catalogue}){
 const plan=parse('plan_turn',JSON.stringify(args));
 if(!plan.requests.length||new Set(plan.requests.map(r=>r.id)).size!==plan.requests.length)throw new Error('INVALID_REQUESTS');
 if(plan.requests.some(r=>!evidenceExists(r.evidence,messages)))throw new Error('REQUEST_EVIDENCE_REQUIRED');
 if(plan.payment!=='none'&&!evidenceExists(plan.paymentEvidence,messages))throw new Error('CURRENT_PAYMENT_EVIDENCE_REQUIRED');
 let nextPurchase=state.purchase||[];
 if(plan.purchaseChange!=='keep'){
  if(plan.purchaseChange==='clear'&&!plan.requests.some(r=>evidenceExists(r.evidence,messages)))throw new Error('PURCHASE_EVIDENCE_REQUIRED');
  for(const i of plan.purchase)if(!evidenceExists(i.evidence,[...history,...messages]))throw new Error('PURCHASE_EVIDENCE_REQUIRED');
  if(plan.purchaseChange==='replace'&&!plan.purchase.some(i=>evidenceExists(i.evidence,messages)))throw new Error('CURRENT_PURCHASE_EVIDENCE_REQUIRED');
  nextPurchase=plan.purchaseChange==='clear'?[]:plan.purchase;
 }
 // Resolve model-selected IDs against a discovery list, never guessed queries.
 for(const r of plan.requests){
  if(r.serviceKeys.some(k=>!catalogue.rows.some(x=>x.kind==='service'&&x.key===k)))throw new Error('UNKNOWN_SERVICE_KEY_USE_DISCOVERY');
  if(r.knowledgeKeys.some(k=>!catalogue.index.some(x=>x.key===k)))throw new Error('UNKNOWN_KNOWLEDGE_KEY_USE_DISCOVERY');
  if(['business','price','recommendation'].includes(r.kind)&&!r.serviceKeys.length&&!r.knowledgeKeys.length&&!r.plans&&(r.kind==='business'||!state.quote))throw new Error('BUSINESS_RETRIEVAL_REQUIRED');
 }
 const signature=x=>JSON.stringify((x||[]).map(i=>[i.platform,i.service]));
 if(signature(state.purchase)!==signature(nextPurchase)||plan.quoteChange==='invalidate')state.quote=null;
 state.purchase=nextPurchase;await ports.persist(state);
 for(const r of plan.requests){
  const start=dispatch.trace.length;
  for(const key of r.serviceKeys)await dispatch.execute(call('get_service_details',{key}));
  if(r.knowledgeKeys.length)await dispatch.execute(call('get_business_knowledge',{keys:r.knowledgeKeys}));
  if(r.plans)await dispatch.execute(call('get_recommended_ads_plans',{}));
  if(dispatch.trace.slice(start).some(t=>t.result?.ok===false))throw new Error('REQUEST_RETRIEVAL_FAILED');
  r.retrievedSources=dispatch.trace.slice(start).map((_,i)=>`s${start+i}`);
 }
 if(plan.requests.some(r=>r.kind==='human'))await dispatch.execute(call('handoff_to_human',{reason:'CUSTOMER_REQUESTED_HUMAN',summary:plan.requests.map(r=>r.question).join('; ')}));
 if(plan.payment==='claim')await dispatch.execute(call('check_payment_status',{}));
 return plan;
}
function pending(plan,dispatch,state){
 if(plan.requests.some(r=>r.kind==='human')&&!dispatch.handoff)return 'HANDOFF_REQUIRED';
 if(plan.payment==='request'&&state.quote&&!dispatch.invoice&&!dispatch.handoff)return 'INVOICE_ACTION_REQUIRED';
 return null;
}
function validateQuestions(final,plan,state,messages){
 for(const q of final.questions){
  if(plan.requests.some(r=>r.kind==='human'))throw new Error('HANDOFF_NOT_QUALIFICATION');
  if(q.reason==='contradiction'){if(!evidenceExists(q.evidence,messages))throw new Error('QUESTION_CONTRADICTION_EVIDENCE_REQUIRED');continue;}
  if(['budget','duration'].includes(q.field)&&state.purchase?.length&&state.purchase.every(i=>i.service!=='ads_management'))throw new Error('SETUP_COURSE_NEEDS_NO_CAMPAIGN_INPUT');
  if(q.field==='service'&&state.purchase?.length)throw new Error('SERVICE_ALREADY_SELECTED');
  if(q.field==='platform'&&state.purchase?.length&&state.purchase.every(i=>i.platform))throw new Error('PLATFORM_ALREADY_SELECTED');
  if(['budget','duration'].includes(q.field)&&state.quote)throw new Error('QUOTE_ALREADY_DEFINES_INPUT');
  if(q.field==='payment'&&plan.payment==='request')throw new Error('PAYMENT_ALREADY_REQUESTED');
  if(['payment','proceed'].includes(q.field)&&plan.payment==='defer')throw new Error('PAYMENT_DEFERRED');
 }
}
module.exports={accept,pending,evidenceExists,validateQuestions};
