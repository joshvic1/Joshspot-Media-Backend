// Independent rescoring; preserves original run files and distinguishes transport errors.
const {valueOf}=require('../../inbox/ai/v2/state');
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function grade(r,e){
 const errors=[],core=r.state?.core,require=(ok,why)=>{if(!ok)errors.push(why);};
 const val=f=>core?.items?.length===1?valueOf(core,f,core.items[0].id)??valueOf(core,f):core?valueOf(core,f):undefined;
 if(r.error)errors.push(`Engine error: ${r.error}`);
 if(e.action)require(r.action===e.action,`Expected ${e.action}, got ${r.action} (${r.handoff||''})`);
 if(e.amount!==undefined)require(r.amount===e.amount,`Expected amount ${e.amount}, got ${r.amount}`);
 if(e.maxAmount)require(!r.amount||r.amount<=e.maxAmount,`Inclusive cap exceeded: ${r.amount} > ${e.maxAmount}`);
 for(const [f,v]of Object.entries(e.facts||{}))require(eq(val(f),v),`Effective ${f}: expected ${JSON.stringify(v)}, got ${JSON.stringify(val(f))}`);
 for(const f of e.notFacts||[])require(val(f)===undefined,`Unjustified ${f}`);
 if(e.noPurchase)require(!val('services')?.length,'Exploration became a purchase selection');
 if(e.question)require(r.question?.purpose===e.question,`Expected question ${e.question}, got ${r.question?.purpose}`);
 if(e.notQuestions)require(!e.notQuestions.includes(r.question?.purpose),'Unwanted qualification question');
 // Equivalent approved source is acceptable; do not demand a particular duplicate fixture ID.
 const equivalents={eval_expected_results:['eval_expected_results','campaign_expectations'],eval_management:['eval_management','ads_management_information'],eval_setup_timing:['eval_setup_timing','service_timing_review'],eval_tiktok_requirements:['eval_tiktok_requirements','tiktok_setup_information','setup_requirements'],eval_meta_requirements:['eval_meta_requirements','meta_setup_information','setup_requirements']};
 if(e.selected)require((equivalents[e.selected]||[e.selected]).some(k=>r.knowledge?.includes(k)),`No relevant approved source for ${e.selected}`);
 if(e.questions)require(r.debug?.interpretation?.questions.length>=e.questions,'Missing separate question interpretation');
 if(e.contains)require(r.response?.toLowerCase().includes(e.contains.toLowerCase()),`Expected response content: ${e.contains}`);
 if(e.path)require(core?.purchasePath===e.path,'Wrong purchase path');
 if(e.noPressure)require(!r.question,'Progression question after deferral');
 if(e.noInvoice)require(r.action!=='invoice','Unauthorized invoice intent');
 if(e.noPaid)require(r.state?.paymentStatus!=='paid'&&!/payment (received|confirmed|verified)/i.test(r.response||''),'Unverified payment confirmed');
 if(e.items)require(eq(core?.items.map(i=>i.id).sort(),[...e.items].sort()),'Wrong service/platform association');
 for(const f of r.question?.fields||[])if(!['proceed','paymentRequested','plan'].includes(f)&&val(f)!==undefined&&!['BUDGET_ALLOCATION','SETUP_CONSENT'].includes(r.question.purpose))errors.push(`Asked confirmed field ${f}`);
 return errors;
}
module.exports={grade};
if(require.main===module){const fs=require('node:fs'),path=require('node:path'),out=[];for(const file of fs.readdirSync(__dirname).filter(f=>/^results-.*\.json$/.test(f))){const run=JSON.parse(fs.readFileSync(path.join(__dirname,file)));const scenarios=run.scenarios.map(s=>{const provider=s.rows.some(row=>/status code (429|5\d\d)|timeout|Evaluation stopped/.test(row.result?.error||''));const errors=s.rows.flatMap(row=>row.result?grade(row.result,row.expect):row.errors);return {id:s.id,group:s.group,status:provider?'INCONCLUSIVE_PROVIDER':errors.length?'FAIL':'PASS',errors,turnsExecuted:s.rows.filter(row=>row.result).length,questions:s.rows.filter(row=>row.result?.question).map(row=>row.result.question.purpose)};});out.push({file,model:run.model,calls:run.calls,summary:{total:scenarios.length,pass:scenarios.filter(s=>s.status==='PASS').length,fail:scenarios.filter(s=>s.status==='FAIL').length,inconclusive:scenarios.filter(s=>s.status==='INCONCLUSIVE_PROVIDER').length},scenarios});}fs.writeFileSync(path.join(__dirname,'adjudicated-results.json'),JSON.stringify(out,null,2));for(const r of out)console.log(JSON.stringify({file:r.file,...r.summary}));}
