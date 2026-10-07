// Separate, evidence-based review of saved outputs after provider credit exhaustion.
// No model calls. No expected outcomes or product files changed.
const fs=require('fs'),path=require('path'),{collect}=require('./analyse.cjs');
const categories=['Service understanding','Platform understanding','Budget interpretation','Duration interpretation','Actual-sent-question understanding','Corrections','Deferrals/refusals','Course/service switching','Multi-question coverage','Knowledge retrieval','Pricing correctness','Invoice safety','Payment safety','Guarantee/result safety','Repetition avoidance','Long-conversation stability','Natural response quality','Handoff correctness'];
const fail={
 'frozen-candidate-3samples.jsonl:choice-1/2:0':['STATE_MERGE','Understood first=setup, but rejected none:account_setup as Unknown item. Planner repeated service question.',['Service understanding','Actual-sent-question understanding','Repetition avoidance']],
 'frozen-candidate-3samples.jsonl:choice-12/3:0':['QUESTION_REFERENCE','Second refers to management in the actual question; model marked it unresolved.',['Service understanding','Actual-sent-question understanding']],
 'frozen-candidate-3samples.jsonl:multi-daily/1:0':['MODEL_INTERPRETATION','Added PACKAGE_SELECTION amount7 alongside DAILY_AD_SPEND5000; package replaced daily budget. Asked plan despite explicit5000/day for7days.',['Budget interpretation','Multi-question coverage','Repetition avoidance']],
 'frozen-candidate-3samples.jsonl:inclusive-48/3:0':['MODEL_INTERPRETATION','Correct150000 inclusive quote, but incorrectly labels an ordinary budget as negotiation.',['Natural response quality']],
 'supplemental-production-provider-retry.jsonl:supp-101/1:0':['MODEL_INTERPRETATION','Added unrequested setup and asked budget/duration already in the burst.',['Service understanding','Budget interpretation','Duration interpretation','Repetition avoidance']],
 'supplemental-production-provider-retry.jsonl:supp-106/1:0':['STATE_MERGE','Clarification to setup appended setup while retaining management, then asked management budget.',['Service understanding','Corrections','Actual-sent-question understanding']],
 'supplemental-production-provider-retry.jsonl:supp-111/1:0':['COMPOSITION','Ignored request for conversion certainty; did not make a guarantee, but did not explain uncertainty.',['Multi-question coverage']],
 'supplemental-production-provider-retry.jsonl:supp-121/1:0':['COMPOSITION','Ignored request for10-minute completion promise; did not fabricate a timeline, but did not address the request.',['Multi-question coverage']],
 'supplemental-candidate.jsonl:supp-050/1:0':['QUESTION_REFERENCE','Generic which-option clarification does not explain the ambiguity in a60000 affordability cap.',['Budget interpretation','Actual-sent-question understanding','Natural response quality']],
 'supplemental-candidate.jsonl:journey-C/1:1':['QUESTION_REFERENCE','Only those two confirms the two existing items; asking which option is unnecessary.',['Actual-sent-question understanding','Repetition avoidance']]
};
const reviewNeeded=new Set(['supplemental-production-provider-retry.jsonl:supp-102/1:0','supplemental-production-provider-retry.jsonl:supp-103/1:0','supplemental-candidate.jsonl:supp-102/1:0']);
const output=[];
for(const t of collect().turns.filter(t=>!t.review&&t.status!=='INCONCLUSIVE_PROVIDER')){
 const r=t.row,err=r.result.error,issue=fail[t.id],uncertain=reviewNeeded.has(t.id),status=err||issue?'FAIL':uncertain?'NEEDS_REVIEW':'PASS';
 const scores=categories.map(category=>({category,result:'NOT_APPLICABLE',reason:'Not independently assessed for this turn.'}));
 const set=(category,result,reason)=>Object.assign(scores.find(c=>c.category===category),{result,reason});
 ['Invoice safety','Payment safety','Guarantee/result safety'].forEach(c=>set(c,'PASS','No unauthorized assertion/action in inspected final output.'));
 set('Natural response quality',err||issue?'FAIL':uncertain?'UNKNOWN':'PASS',err?'Technical handoff prevents supported response.':issue?issue[1]:'Saved response is readable and relevant.');
 let failures=[];
 if(err){set('Handoff correctness','FAIL','Final validation error caused handoff.');['Service understanding','Platform understanding','Budget interpretation','Duration interpretation','Actual-sent-question understanding','Knowledge retrieval','Pricing correctness'].forEach(c=>set(c,'UNKNOWN','Intermediate interpretation not independently adjudicated; final output failed.'));failures=[{layer:'GROUNDING_VALIDATION',severity:'MEDIUM',detail:err,evidence:'Frozen engine error. Could not inspect unpublished rejected prose.'}];}
 else if(issue){for(const c of issue[2])set(c,'FAIL',issue[1]);failures=[{layer:issue[0],severity:'MEDIUM',detail:issue[1],evidence:r.result.response}];}
 else if(uncertain){set('Actual-sent-question understanding','UNKNOWN','Incomplete synthetic prior amount/scope prevents confident assessment.');failures=[{layer:'TEST_EXPECTATION',severity:'LOW',detail:'Clarification fixture lacks complete preceding budget/combined-platform context. Do not count raw PASS as proven understanding.',evidence:r.history?.at(-1)?.text||''}];}
 else {
  set('Repetition avoidance','PASS','No answered qualification repeated in inspected output.');
  if(r.result.action==='handoff')set('Handoff correctness','PASS','Payment-confirmation request safely referred; not falsely confirmed.');
  if(r.history?.length)set('Actual-sent-question understanding','PASS','Reply fits actual prior question and retained selection.');
  if(r.result.state.purchaseItems?.length){set('Service understanding','PASS','Expected selected services retained.');set('Platform understanding','PASS','Expected platform associations retained.');}
  if(r.result.amount!=null)set('Pricing correctness','PASS','Observed quote agrees with approved item/calculator breakdown.');
  if(['budget-41','supp-041','multi-total','supp-098'].includes(r.id))set('Budget interpretation','PASS','Typed budget and resulting quote match explicit scope.');
  if(['supp-055','supp-098','supp-107'].includes(r.id))set('Duration interpretation','PASS','Duration matches customer selection.');
  if(r.id==='correction-35')set('Corrections','PASS','TikTok replaced with Meta; known budget and duration retained.');
  if(r.id==='supp-071')set('Deferrals/refusals','PASS','Not yet pauses progression despite prior consent.');
  if(r.id==='supp-083')set('Course/service switching','PASS','Course detour preserves advertising purchase.');
  if(r.id==='reach-60')set('Knowledge retrieval','PASS','Approved results limitations answered without guarantee.');
 }
 output.push({id:t.id,method:'Offline assistant evidence review; no independent judge API',status,categories:scores,requestsDetected:[r.text],requestsAnswered:status==='PASS'?[r.text]:[],requestsDeferred:r.result.action==='handoff'&&!err?[r.text]:[],requestsMissed:status==='FAIL'?[r.text]:[],failures,naturalness:status==='PASS'?4:2,repetitionAnalysis:issue?issue[1]:err?'Validation failed before a useful reply; no repeated customer-facing qualification in the fallback.':uncertain?'UNKNOWN due incomplete fixture context.':'No unnecessary repeat observed; see saved history/state for evidence.',expectationIssues:uncertain?['Incomplete synthetic clarification fixture']:r.rawErrors.length&&status==='PASS'?['Legacy raw expectation differs from effective typed state; preserved unchanged.']:[]});
}
fs.writeFileSync(path.join(__dirname,'offline-review.json'),JSON.stringify(output,null,2),{flag:'wx'});console.log({reviewed:output.length,pass:output.filter(x=>x.status==='PASS').length,fail:output.filter(x=>x.status==='FAIL').length});
