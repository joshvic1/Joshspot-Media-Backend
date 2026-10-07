// Backend-issued segments: caller-provided JSON cannot grant itself claim authority.
const issued=new WeakMap();
function fact(plan,id,text,type,source){plan.facts[id]=text;plan.provenance||={};plan.provenance[id]={type,source};issued.set(plan,JSON.stringify({facts:plan.facts,provenance:plan.provenance}));}
function trusted(plan){return issued.get(plan)===JSON.stringify({facts:plan.facts,provenance:plan.provenance});}
const wording={negotiation:"Sorry boss, it's not negotiable. That's the last price.",deferred:"All right, take your time. We'll be here when you're ready.",handoff:'Hold on, you will get a response shortly.',cap:'That total cannot cover the configured services. We can review a different budget or service selection.',mismatch:'The package breakdown needs confirmation before we can issue an invoice.',reference:'Could you clarify which option you mean?'};
function policy(key,records){const r=records.find(r=>r.kind==='knowledge'&&r.enabled!==false&&!r.archived&&r.key===`v2_${key}`);return {text:r?.data.preferredResponse||wording[key],source:r||null};}
module.exports={fact,trusted,policy,wording};
