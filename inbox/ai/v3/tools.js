const pricing=require('./pricing');
const {parse}=require('./contracts');
const fail=code=>({ok:false,error:code});
function dispatcher({catalogue,state,messages,history,api,ports,simulation=true,now=()=>Date.now()}){
 const trace=[],cache=new Map(),failures=new Map();let handoff=null,invoice=null,plan=null;
 async function execute(call){
  let args,result;
  try{
   await ports.assertCurrent();
   if((failures.get(call.name)||0)>=2)throw Object.assign(new Error('TOOL_RECOVERY_EXHAUSTED'),{code:'TOOL_RECOVERY_EXHAUSTED'});
   args=parse(call.name,call.arguments);
   await ports.assertCurrent();
   const cacheKey=JSON.stringify([call.name,args]);
   if(cache.has(cacheKey)&&!['calculate_ads_quote','get_invoice_status','check_payment_status'].includes(call.name)){const cached=cache.get(cacheKey);trace.push({tool:call.name,args,result:cached,cached:true});return cached;}
   const rows=catalogue.rows;
   switch(call.name){
    case 'get_services':result=rows.filter(r=>r.kind==='service').map(r=>({key:r.key,title:r.title,...r.data}));break;
    case 'get_service_details':{const r=rows.find(r=>r.kind==='service'&&r.key===args.key);result=r?{key:r.key,title:r.title,...r.data}:fail('SERVICE_UNAVAILABLE');break;}
    case 'resolve_service':{const matches=rows.filter(r=>r.kind==='service'&&r.data.serviceType===args.service&&(!args.platform||r.data.platforms?.includes(args.platform)));result=matches.length===1?{key:matches[0].key,title:matches[0].title,...matches[0].data}:fail('CLARIFY_SERVICE_SELECTION');break;}
    case 'get_recommended_ads_plans':result=await pricing.plans(rows);break;
    case 'get_business_knowledge':{
     const entries=args.keys.map(key=>rows.find(r=>r.kind==='knowledge'&&r.key===key));
     result=entries.some(r=>!r)?fail('UNKNOWN_KNOWLEDGE_ID'):entries.map(require('./catalogue').knowledge);
     if(JSON.stringify(result).length>45000)result=fail('KNOWLEDGE_RESULT_TOO_LARGE_REQUEST_FEWER');break;
    }
    case 'calculate_ads_quote':{
     if(handoff){result=fail('HUMAN_HANDOFF_PENDING');break;}
     const {adsPricingConfig}=await import('../vendor/adsPricingConfig.mjs');
     if(args.items.some(i=>i.creativeMode==='individual'||i.creatives>adsPricingConfig.creatives.testingMax)&&!require('./turn').evidenceExists(args.creativeEvidence,[...history,...messages])){result=fail('PAID_OPTION_EVIDENCE_REQUIRED');break;}
     if(plan&&args.items.some(i=>!(state.purchase||[]).some(p=>p.platform===i.platform&&p.service===i.service))){result=fail('UNSELECTED_SERVICE');break;}
     const items=args.items.map(i=>i.service==='account_setup'?{...i,budgetBasis:null,budget:null,duration:null,planKey:null,creativeMode:'testing',creatives:1}:{...i,creativeMode:i.creativeMode||'testing',creatives:i.creatives??adsPricingConfig.creatives.testingMax});
     state.quote=null;await ports.persist(state);state.quote=await pricing.quote(items,rows,now(),args.purchaseCap);state.quote.catalogueRevision=catalogue.revision;await ports.persist(state);result=state.quote;break;
    }
    case 'get_invoice_status':case 'check_payment_status':result=await ports.invoiceStatus(call.name==='check_payment_status');break;
    case 'create_invoice':{
     if(plan&&plan.payment!=='request'){result=fail('CURRENT_PAYMENT_REQUEST_REQUIRED');break;}
     const q=state.quote,latest=messages.at(-1);
     if(handoff||!q||q.id!==args.quoteId||q.catalogueRevision!==catalogue.revision||Date.parse(q.expiresAt)<=now()) {result=fail('NEEDS_CURRENT_QUOTE');break;}
     if(!latest||String(latest._id)!==args.messageId||!String(latest.text).includes(args.evidence)){result=fail('NEEDS_CONFIRMATION');break;}
     const recalculated=await pricing.quote(q.items,rows,now(),q.purchaseCap??null);if(recalculated.fingerprint!==q.fingerprint||recalculated.total!==q.total){result=fail('QUOTE_CHANGED');break;}
     const beforeAnswer=history.filter(m=>m.direction==='inbound'||!latest.createdAt||new Date(m.sentAt||m.createdAt)<=new Date(latest.createdAt));
     const authorization=await api.authorizePayment({quote:q,latestTurn:messages.map(m=>({id:String(m._id),text:m.text,createdAt:m.createdAt})),deliveredHistory:beforeAnswer.slice(-12).map(m=>({id:String(m._id),direction:m.direction,text:m.text,sentAt:m.sentAt||m.createdAt})),evidence:args.evidence});
     if(authorization.decision!=='ALLOW'){result=fail('NEEDS_CONFIRMATION');break;}
     await ports.assertCurrent();
     const current=await ports.invoiceStatus(false);
     if(current?.status==='paid'||current?.id&&current.quoteFingerprint!==q.fingerprint){result=fail('EXISTING_INVOICE_REQUIRES_REVIEW');break;}
     const operationId=`v3:${q.fingerprint}`;
     // Never pass a model amount, contact, URL or account to financial services.
     invoice=simulation?{simulation:true,wouldCreateInvoice:true,quoteId:q.id,amount:q.total,currency:'NGN',status:'NOT_CREATED'}:await ports.createInvoice({quote:q,operationId});
     result=invoice;state.lastOperationId=operationId;if(invoice.id)state.invoiceId=invoice.id;await ports.persist(state);break;
    }
    case 'handoff_to_human':handoff=args;result={accepted:true,simulation,assignmentStatus:simulation?'SIMULATED':'PENDING_ASSIGNMENT',reason:args.reason};break;
    default:result=fail('UNKNOWN_TOOL');
   }
   if(result?.ok!==false)cache.set(cacheKey,result);
  }catch(error){if(['V3_OWNERSHIP_CHANGED','V3_CONFIGURATION_CHANGED','TOOL_RECOVERY_EXHAUSTED'].includes(error.message))throw error;result=fail(error.code||(['INVALID_TOOL_ARGUMENTS','UNKNOWN_TOOL'].includes(error.message)?error.message:'TOOL_UNAVAILABLE'));}
  if(result?.ok===false){const n=(failures.get(call.name)||0)+1;failures.set(call.name,n);result={...result,recoverable:n<2,attemptsRemaining:Math.max(0,2-n),field:result.error==='SERVICE_UNAVAILABLE'?'key':result.error==='UNKNOWN_KNOWLEDGE_ID'?'keys':'arguments',validServiceKeys:catalogue.rows.filter(r=>r.kind==='service').map(r=>r.key),schema:require('./contracts').tools.find(t=>t.name===call.name)?.parameters,instruction:'Correct from schema/discovery, once only. This is not a business fact or evidence that a service is unavailable. Do not invent an explanation.'};}
  trace.push({tool:call.name,args,result});return result;
 }
 return {execute,trace,setPlan:value=>{plan=value;},get handoff(){return handoff;},get invoice(){return invoice;}};
}
module.exports={dispatcher};
