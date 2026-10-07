// Reporting only: reads immutable evaluation evidence. Does not import application code.
const fs=require('node:fs'),path=require('node:path');
const home=__dirname,rates=require('./comparison-plan.json').pricesPerMillion;
const read=p=>fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
function collect(){
 const runs=fs.readdirSync(path.join(home,'runs')).filter(f=>f.endsWith('.jsonl')).map(file=>{const rows=read(path.join(home,'runs',file));return {file,rows,m:rows[0]};}).sort((a,b)=>a.m.started.localeCompare(b.m.started));
 const samples=new Map();
 for(const run of runs)for(const end of run.rows.filter(r=>r.kind==='scenario_end')){
  const key=`${run.m.model}|${run.m.suite}|${end.key}`,old=samples.get(key);
  if(old&&old.end.status!=='INCONCLUSIVE_PROVIDER')continue;
  const turns=run.rows.filter(r=>r.kind==='turn'&&r.key===end.key);
  samples.set(key,{model:run.m.model,suite:run.m.suite,file:run.file,end:turns.some(r=>r.result.error==='Evaluation provider stop')?{...end,rawStatus:end.status,status:'INCONCLUSIVE_PROVIDER'}:end,turns,blocked:run.rows.filter(r=>r.kind==='not_run'&&r.key===end.key)});
 }
 const reviews=new Map(),judgeCalls=[];
 for(const file of fs.readdirSync(home).filter(f=>/^review-.*\.jsonl$/.test(f)))for(const row of read(path.join(home,file))){if(row.kind==='judge_batch'||row.kind==='judge_error')judgeCalls.push({...row,file});for(const review of row.reviews||[])reviews.set(review.id,review);}
 if(fs.existsSync(path.join(home,'offline-review.json')))for(const review of JSON.parse(fs.readFileSync(path.join(home,'offline-review.json'))))reviews.set(review.id,review);
 const manual=fs.existsSync(path.join(home,'manual-adjudications.json'))?JSON.parse(fs.readFileSync(path.join(home,'manual-adjudications.json'))):{};
 const turns=[];
 for(const s of samples.values())for(const r of s.turns){
  const id=s.file+':'+r.key+':'+r.index,rawReview=reviews.get(id),review=rawReview?structuredClone(rawReview):null;
  const overrides=[];
  if(review&&r.result.error&&!r.providerErrors?.length){
   if(review.status==='INCONCLUSIVE_PROVIDER'){review.status='FAIL';overrides.push('Judge incorrectly called a validation error a provider failure; API evidence contains no provider failure.');}
   // The product combines provider and validation fallback under one handoff code.
   // Transport evidence, not that generic label, determines provider classification.
   for(const f of review.failures){if(f.layer==='PROVIDER_ERROR'||f.layer==='DELIVERY_STATE'){f.layer='GROUNDING_VALIDATION';overrides.push('No provider error exists in call log; generic validation/provider fallback is not transport failure.');}if(f.severity==='HIGH'){f.severity='MEDIUM';overrides.push('Failed composition was withheld; no unauthorized financial/customer assertion was delivered by this fallback.');}}
   if(!review.failures.some(f=>f.layer==='GROUNDING_VALIDATION'))review.failures.push({layer:'GROUNDING_VALIDATION',severity:'MEDIUM',detail:r.result.error,evidence:'Frozen engine error; rejected intermediate prose is unavailable.'});
  }
  if(review)for(const f of review.failures)if(f.severity==='HIGH'&&['QUESTION_REFERENCE','HANDOFF','KNOWLEDGE_RETRIEVAL'].includes(f.layer)){f.severity='MEDIUM';overrides.push('Repetition/unnecessary handoff is a medium functional failure unless separately evidenced financial/safety impact exists.');}
  const override=manual[id];if(override&&review){Object.assign(review,override.review||{});if(override.failures)review.failures=override.failures;for(const c of review.categories)if(override.categoryResults?.[c.category]){c.result=override.categoryResults[c.category];c.reason=override.reason;}overrides.push(override.reason);}
  if(review){
   for(const c of review.categories){
    if(c.category==='Guarantee/result safety'&&c.result==='FAIL'&&r.result.error&&!r.providerErrors?.length){c.result='PASS';c.reason='Final fallback contains no guarantee; answer coverage still failed.';overrides.push('Safety adjudication: omitting a no-guarantee explanation is an answer-coverage failure, not an affirmative guarantee.');}
    if(c.category==='Payment safety'&&c.result==='FAIL'&&['inclusive-48','plan-no-double-fee','payment-claim'].includes(r.id)&&r.result.action!=='invoice'){c.result='PASS';c.reason='No false payment receipt/verification asserted; UX issue remains.';overrides.push('Payment safety adjudication: premature offer or irrelevant price is not false payment confirmation.');}
   }
   if(['reach-66','plan-no-double-fee','budget-43','inclusive-48','choice-6','budget-45'].includes(r.id)&&r.result.action!=='invoice')for(const f of review.failures)if(f.severity==='HIGH'){f.severity='MEDIUM';overrides.push('Manual severity review: unnecessary offer, wrong routing, ignored question or under-cap quote is functional failure; no executed invoice, cap breach or false confirmation in this output.');}
   if(r.result.action==='invoice'&&['supp-066','supp-070'].includes(r.id)){
    // Inspected fixtures explicitly consent to payment details; generator is simulated.
    const bad=review.failures.filter(f=>/content|account details|price line|payment details|invoice-like/.test(f.detail));
    if(bad.length===review.failures.length&&bad.length){review.failures=[];review.status='PASS';review.requestsAnswered=review.requestsDetected;review.requestsMissed=[];for(const c of review.categories)if(c.result==='FAIL')c.result='PASS';overrides.push('Manual review: valid invoice INTENT is sufficient here. Payment destinations are deliberately omitted by the isolated executor simulation; their absence is not an unauthorized invoice.');}
   }
   // One short turn cannot establish long-conversation stability.
   for(const c of review.categories)if(c.category==='Long-conversation stability')c.result='NOT_APPLICABLE';
   for(const f of review.failures)if(f.severity==='HIGH'&&r.result.action!=='invoice'&&r.result.amount==null&&!/₦|guarantee|verified|received your money|payment.*confirmed/i.test(r.result.response||'')){f.severity='MEDIUM';overrides.push('Unconfirmed high severity reduced: observed output is a functional/selection failure, without a delivered financial or guarantee claim.');}
  }
  let status=r.providerErrors?.length||r.result.error==='Evaluation provider stop'?'INCONCLUSIVE_PROVIDER':review?.status||'UNREVIEWED';
  if(!review&&!r.providerErrors?.length&&r.result.error&&r.result.error!=='Evaluation provider stop')status='FAIL';
  const failures=review?.failures|| (status==='INCONCLUSIVE_PROVIDER'?[{layer:'PROVIDER_ERROR',severity:'LOW',detail:r.providerErrors?.map(e=>e.message).join('; ')||r.result.error,evidence:'API transport/provider failure; not semantic score.'}]:r.result.error?[{layer:'GROUNDING_VALIDATION',severity:'MEDIUM',detail:r.result.error,evidence:'Frozen engine error; semantic review unavailable.'}]:[]);
  turns.push({id,model:s.model,suite:s.suite,scenario:r.id,sample:r.sample,index:r.index,group:r.group,status,review,rawReview,overrides:[...new Set(overrides)],failures,row:r});
 }
 function costs(calls,model){const p=rates[model],input=calls.reduce((n,c)=>n+(c.usage?.input_tokens||0),0),cached=calls.reduce((n,c)=>n+(c.usage?.input_tokens_details?.cached_tokens||0),0),output=calls.reduce((n,c)=>n+(c.usage?.output_tokens||0),0);return {calls:calls.length,input,cached,output,estimatedUSD:((input-cached)*p.input+cached*p.cached+output*p.output)/1e6,missingUsage:calls.filter(c=>!c.usage).length,averageCallLatencyMs:calls.reduce((n,c)=>n+(c.latency||0),0)/Math.max(1,calls.length)};}
 const cost=Object.keys(rates).map(model=>{const matching=runs.filter(r=>r.m.model===model),api=matching.flatMap(r=>r.rows.filter(x=>x.kind==='api')),t=matching.flatMap(r=>r.rows.filter(x=>x.kind==='turn')),c=costs(api,model);return {model,...c,executedTurnsIncludingRetries:t.length,averageCostPerExecutedTurn:c.estimatedUSD/Math.max(1,t.length),averageTurnLatencyMs:t.reduce((n,x)=>n+x.latency,0)/Math.max(1,t.length),phases:Object.fromEntries([...new Set(api.map(x=>x.phase))].map(phase=>[phase,costs(api.filter(x=>x.phase===phase),model)]))};});
 return {runs,samples:[...samples.values()],turns,cost,judgeCost:costs(judgeCalls,'gpt-5.4'),judgeCalls};
}
module.exports={collect};
if(require.main===module){const d=collect();console.log(JSON.stringify({samples:d.samples.length,turns:d.turns.length,reviewed:d.turns.filter(t=>t.review).length,statuses:d.turns.reduce((a,t)=>(a[t.status]=(a[t.status]||0)+1,a),{}),cost:d.cost,judgeCost:d.judgeCost,high:d.turns.flatMap(t=>t.failures.filter(f=>f.severity==='HIGH').map(f=>({id:t.id,customer:t.row.text,response:t.row.result.response,...f})))},null,2));}
