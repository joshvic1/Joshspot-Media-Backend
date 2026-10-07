const policy=require('../structuredKnowledge');
// Explicit compatibility metadata for legacy instructional entries, not message
// matching. New entries use contentRole; no database migration happens on reads.
const legacyGuidance=new Set(['budget_guidance','self_managed_ads','choose_service']);
const plannerKeys=new Set(policy.seeds.filter(r=>r.data.plannerOnly).map(r=>r.key));
function role(r){return r.data.contentRole||(r.data.plannerOnly||legacyGuidance.has(r.key)?'GUIDANCE':r.data.responseMode==='STRICT'?'RESPONSE':'KNOWLEDGE');}
function quoteable(r){return role(r)==='RESPONSE'&&Boolean(r.data.preferredResponse);}
function eligible(records,state){return [...new Map(records.filter(r=>r.enabled!==false&&!r.archived&&r.kind==='knowledge'&&!plannerKeys.has(r.key)&&(policy.eligible(r,state)||(state.core?.items||[]).some(item=>policy.eligible(r,{...state,selectedPlatform:item.platform,serviceType:item.type,budget:require('./state').effectiveValue(state.core,'budget',item.id),duration:require('./state').effectiveValue(state.core,'duration',item.id)})))).map(r=>[r.key,r])).values()];}
function catalogue(records,state){
  return eligible(records,state).map(r=>({key:r.key,title:r.title,role:role(r),priority:r.priority||0,purpose:r.data.purpose||r.data.question||'',description:r.data.semanticTrigger||r.data.triggerExamples||'',when:r.data.whenToUse||'',exclude:r.data.whenNotToUse||'',requiredState:r.data.requiredState||{}}));
}
function select(records,state,selection){
  const candidates=eligible(records,state),seen=new Set();
  if(selection.entries.length>8)throw new Error('Too many knowledge selections');
  return selection.entries.filter(e=>{if(seen.has(e.key))return false;seen.add(e.key);return true;}).map(e=>{
    const r=candidates.find(r=>r.key===e.key);
    if(!r)throw new Error('Unknown knowledge selection');
    return {...r,matchReason:e.reason};
  }).sort((a,b)=>(b.priority||0)-(a.priority||0)||a.key.localeCompare(b.key));
}
async function load(){
  // Pure read: unlike the old catalogue loader, never seed on a request path.
  const rows=await require('../models').Record.find({enabled:true,archived:{$ne:true}}).sort({priority:-1,key:1}).limit(501).lean();
  if(rows.length>500)throw new Error('V2 catalogue exceeds supported size; configure a larger retrieval adapter');
  return rows;
}
module.exports={catalogue,select,load,role,quoteable};
