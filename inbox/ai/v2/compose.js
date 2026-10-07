const authority=require('./authority'),retrieval=require('./knowledge'),{assertComplete}=require('./ledger');
const approvals=new WeakMap();
function knowledgeTexts(entries){return Object.fromEntries(entries.filter(retrieval.quoteable).map(e=>[e.key,e.data.preferredResponse]));}
function materialize(output,plan,knowledge){
 const texts=knowledgeTexts(knowledge),seen=new Set(),parts=[];
 for(const p of output.parts){const key=`${p.kind}:${p.value}`;if(seen.has(key))continue;seen.add(key);
  if(p.kind==='fact'){if(!authority.trusted(plan)||!Object.hasOwn(plan.facts,p.value))throw new Error('Unissued financial fact');parts.push({...p,text:plan.facts[p.value],trusted:!plan.provenance[p.value].source.unverified});}
  else if(p.kind==='question'){if(!plan.question||plan.question.purpose!==p.value)throw new Error('Unexpected question');parts.push({...p,text:plan.question.text,trusted:plan.question.text===plan.question.defaultText});}
  else if(p.kind==='knowledge'){if(!texts[p.value])throw new Error('Unavailable approved wording');parts.push({...p,text:texts[p.value],trusted:false});}
  else if(p.kind==='text')parts.push({...p,text:p.value,trusted:false});
  else throw new Error('Invalid response segment');
 }
 for(const id of plan.requiredFacts)if(!seen.has(`fact:${id}`)){if(!authority.trusted(plan))throw new Error('Unissued fact');parts.push({kind:'fact',value:id,text:plan.facts[id],trusted:!plan.provenance[id].source.unverified});}
 if(plan.question&&!seen.has(`question:${plan.question.purpose}`))parts.push({kind:'question',value:plan.question.purpose,text:plan.question.text,trusted:plan.question.text===plan.question.defaultText});
 const strict=knowledge.filter(k=>retrieval.quoteable(k)&&(k.data.responseMode==='STRICT'||k.data.allowContext===false));
 for(const e of strict)if(output.usedKnowledge.includes(e.key)&&!parts.some(p=>p.kind==='knowledge'&&p.value===e.key))throw new Error('Missing scoped STRICT segment');
 if(output.usedKnowledge.some(k=>!knowledge.some(e=>e.key===k)))throw new Error('Unknown source');
 return parts;
}
async function validate(output,plan,knowledge,call){
 const parts=materialize(output,plan,knowledge),untrusted=parts.map((p,index)=>({...p,index})).filter(p=>!p.trusted);
 if(untrusted.length||plan.ledger.some(n=>n.disposition==='PENDING')){
  const proof=await call('grounding',{segments:untrusted,allSegments:parts,knowledge:knowledge.map(k=>({key:k.key,text:k.data.preferredResponse||k.data.answer||k.data.facts,role:retrieval.role(k)})),requestLedger:plan.ledger,action:plan.action,facts:plan.facts});
  for(const segment of untrusted){const verdicts=proof.segments.filter(v=>v.index===segment.index);if(verdicts.length!==1)throw new Error('Missing segment provenance');const claims=verdicts[0].claims;
   if(!claims.length||claims.map(c=>c.text).join('')!==segment.text)throw new Error('Incomplete claim coverage');
   for(const c of claims){if(!c.entailed||!['NEUTRAL','BUSINESS_FACT'].includes(c.type))throw new Error(`Unauthorized typed claim: ${c.type}`);if(c.type==='BUSINESS_FACT'&&(!c.sources.length||c.sources.some(id=>!knowledge.some(k=>k.key===id&&retrieval.role(k)!=='GUIDANCE'))))throw new Error('Unapproved claim source');}
  }
  for(const need of plan.ledger.filter(n=>n.disposition==='PENDING')){const v=proof.coverage.filter(x=>x.id===need.id);if(v.length!==1)throw new Error('Uncovered customer request');const item=v[0];if(!item.segments.length||item.segments.some(index=>!Number.isInteger(index)||!parts[index]))throw new Error('Coverage lacks response evidence');if(item.disposition==='ACTIONED')throw new Error('Model cannot authorize an action');if(['HANDOFF_REQUIRED','DEFERRED_WITH_REASON','UNSUPPORTED'].includes(item.disposition)&&plan.action!=='handoff')throw new Error('Unsupported request needs explicit disposition');if(item.disposition==='CLARIFICATION_REQUIRED'&&!plan.question)throw new Error('Missing clarification');if(item.disposition==='ANSWERED'&&item.segments.every(index=>parts[index].kind==='question'))throw new Error('Question is not an answer');need.disposition=item.disposition;need.reason=item.reason;need.segments=item.segments;}
 }
 assertComplete(plan.ledger);approvals.set(output,JSON.stringify({parts,ledger:plan.ledger}));return parts;
}
function render(output,plan,knowledge,config){
 const parts=materialize(output,plan,knowledge);
 if(parts.some(p=>!p.trusted)||plan.ledger?.length){if(approvals.get(output)!==JSON.stringify({parts,ledger:plan.ledger}))throw new Error('Response has no provenance approval');}
 const response=parts.map(p=>p.text).filter(Boolean).join('\n\n');if(!response.trim()||response.length>config.maxResponseLength)throw new Error('Invalid response length');return response;
}
module.exports={materialize,validate,render,knowledgeTexts};
