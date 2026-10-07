// Evaluation only. No database connection, sending, invoice or assignment executors.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {cases}=require('./dataset.cjs');
const {decide}=require('../../inbox/ai/v2'),states=require('../../inbox/ai/v2/state'),modelApi=require('../../inbox/ai/v2/model');
const defaults=require('../../inbox/ai/defaults'),kb=require('../../inbox/ai/structuredKnowledge');
const arg=k=>process.argv.includes(k)?process.argv[process.argv.indexOf(k)+1]:undefined;
if(!process.argv.includes('--live-model'))throw new Error('Use --live-model for bounded, billable synthetic evaluation');
// Load only OpenAI values, never database/provider configuration into the process.
const env=require('dotenv').parse(fs.readFileSync(path.resolve(__dirname,'../../.env')));
process.env.OPENAI_API_KEY=env.OPENAI_API_KEY;
delete process.env.OPENAI_V2_MODEL;
const selectedModel=arg('--model')||env.OPENAI_MODEL||'gpt-4.1-mini';
const config={...defaults.config,model:selectedModel,v2Model:selectedModel,engineVersion:'v1',mode:'DRAFT',structuredSales:true,invoicesEnabled:true,maxResponseLength:4000};
const fixture=(key,title,answer,requiredState={})=>({kind:'knowledge',key,title,enabled:true,priority:90,data:{contentRole:'KNOWLEDGE',responseMode:'KNOWLEDGE',allowContext:true,semanticTrigger:title,purpose:title,answer,facts:answer,requiredState}});
const records=[...defaults.records,...kb.seeds,
 fixture('eval_expected_results','Expected views, engagement, reach and sales','Advertising results vary. Views, reach, engagement and sales cannot be guaranteed.'),
 fixture('eval_management','What ads management includes','We configure the campaign, monitor performance and optimise the campaign. The advertising spend is separate from the management fee.'),
 fixture('eval_setup_timing','Setup timing and what setup includes','Setup and guidance do not include advertising spend. Advertising spend is separate. Setup timing is confirmed by the team after checking the account.'),
 fixture('eval_tiktok_requirements','What to provide for TikTok setup','Provide your email address through the approved onboarding process.',{selectedPlatform:'tiktok',serviceType:'account_setup'}),
 fixture('eval_meta_requirements','What to provide for Meta setup','Use delegated business access through the approved onboarding process.',{selectedPlatform:'meta',serviceType:'account_setup'}),
];
const falseSignal=()=>({value:false,evidence:{messageId:'',text:''}});
const blank=()=>({intents:['advertising'],questions:[],facts:[],answeredQuestionIds:[],recommendations:[],unresolvedReferences:[],negotiation:falseSignal(),deferral:falseSignal(),humanRequest:falseSignal(),paymentClaim:falseSignal(),sensitiveCase:falseSignal(),topic:'advertising',purchaseChange:{action:'none',path:'unchanged',evidence:{messageId:'',text:''}},confidence:1});
function seeded(seed){const i=blank();i.facts=Object.entries(seed).map(([field,value])=>({field,value,itemId:'',confidence:1,explicit:true,correction:false,evidence:{messageId:'seed',text:'Fixture customer explicitly selected these details'}}));const c={messages:[{id:'seed',text:'Fixture customer explicitly selected these details'}],history:[],now:'2026-10-06T10:00:00Z'};return states.projection(states.merge({},i,c,records).state);}
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function grade(r,e){const errors=[];const require=(ok,why)=>{if(!ok)errors.push(why);};const val=f=>states.valueOf(r.state.core,f);
 if(e.action)require(r.action===e.action,`action expected ${e.action}, got ${r.action}: ${r.handoff||r.error||''}`);
 if(e.amount!==undefined)require(r.amount===e.amount,`amount expected ${e.amount}, got ${r.amount}`);
 if(e.maxAmount)require(!r.amount||r.amount<=e.maxAmount,`all-inclusive cap exceeded: ${r.amount} > ${e.maxAmount}`);
 for(const [k,v]of Object.entries(e.facts||{}))require(eq(val(k),v),`fact ${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(val(k))}`);
 for(const k of e.notFacts||[])require(val(k)===undefined,`unjustified ${k} selection`);
 if(e.noPurchase)require(!val('services')?.length,'Exploration or ambiguous reply became purchase choice');
 if(e.question)require(r.question?.purpose===e.question,`expected question ${e.question}, got ${r.question?.purpose}`);
 if(e.notQuestions)require(!e.notQuestions.includes(r.question?.purpose),'Repeated unwanted qualification question');
 if(e.selected)require(r.knowledge?.includes(e.selected),`missing approved knowledge ${e.selected}`);
 if(e.questions)require(r.debug?.interpretation?.questions.length>=e.questions,'Missed customer question(s)');
 if(e.contains)require(r.response?.toLowerCase().includes(e.contains.toLowerCase()),`response missing ${e.contains}`);
 if(e.path)require(r.state.core.purchasePath===e.path,'Purchase path changed incorrectly');
 if(e.noPressure)require(!r.question,'Asked a progression question during deferral');
 if(e.noInvoice)require(r.action!=='invoice','Unauthorized invoice intent');
 if(e.noPaid)require(r.state.paymentStatus!=='paid'&&!/payment (received|confirmed|verified)/i.test(r.response||''),'Unverified payment confirmed');
 if(e.items)require(eq(r.state.core.items.map(x=>x.id).sort(),[...e.items].sort()),'Incorrect platform/service item mapping');
 for(const field of r.question?.fields||[])if(!['proceed','paymentRequested','plan'].includes(field)&&val(field)!==undefined&&!['BUDGET_ALLOCATION','SETUP_CONSENT'].includes(r.question.purpose))errors.push(`Question asks confirmed field ${field}`);
 return errors;
}
const selected=cases.filter(c=>(!arg('--group')||arg('--group').split(',').includes(c.group))&&(!arg('--ids')||arg('--ids').split(',').includes(c.id))).slice(0,Number(arg('--limit')||cases.length));
const out=path.join(__dirname,`results-${selectedModel}${arg('--tag')?'-'+arg('--tag'):''}.json`);
const hashes=()=>Object.fromEntries(fs.readdirSync(path.resolve(__dirname,'../../inbox/ai/v2')).filter(f=>f.endsWith('.js')).map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname,'../../inbox/ai/v2',f))).digest('hex')]));
const result={model:selectedModel,started:new Date().toISOString(),source:'user-reported anonymized reconstructions + synthetic tests, not production logs',catalogue:'local seeds plus five explicit synthetic knowledge fixtures',hashes:hashes(),scenarios:[],calls:0};
let providerBlocked=false;const providerErrors=[];
fs.writeFileSync(path.join(__dirname,'dataset.json'),JSON.stringify(cases,null,2));
async function run(c){let state=seeded(c.seed||{}),history=[],rows=[];
 if(c.question)history.push({_id:'question-seed',direction:'outbound',status:'sent',text:c.question.text,automation:{question:c.question},sentAt:'2026-10-06T10:00:01Z'});
 for(const [j,t]of c.turns.entries()){
  const current={_id:`${c.id}-${j}`,text:t.text,type:'text'};const before=state;const started=Date.now();
  const r=await decide({text:t.text,messages:[current],state,history:history.slice(-6),questionMessages:history.filter(m=>m.automation?.question).slice(-1),records,config,type:'text'}, {call:async(...args)=>{if(providerBlocked)throw new Error('Evaluation stopped after provider rejection');if(++result.calls>450)throw new Error('Evaluation API call cap');await new Promise(resolve=>setTimeout(resolve,Number(arg('--delay')||3000)));try{return await modelApi.call(...args);}catch(error){if(error.response){providerErrors.push({status:error.response.status,code:error.response.data?.error?.code,type:error.response.data?.error?.type,message:error.response.data?.error?.message});if(error.response.status===429)providerBlocked=true;}throw error;}}});
  const errors=grade(r,t.expect);rows.push({text:t.text,expect:t.expect,errors,latency:Date.now()-started,before,result:r});state=r.state;
  history.push({...current,direction:'inbound',status:'received'});
  // Only simulate actual delivery for replies. A handoff ends this replay.
  if(r.action==='reply')history.push({_id:`reply-${c.id}-${j}`,direction:'outbound',status:'sent',text:r.response,automation:{question:r.question},sentAt:new Date(Date.parse('2026-10-06T10:01:00Z')+j*1000).toISOString()});
  if(r.action==='handoff'&&j<c.turns.length-1){rows.push({errors:['Remaining turns blocked by handoff'],notRun:c.turns.slice(j+1)});break;}
 }
 const row={id:c.id,group:c.group,pass:rows.every(r=>!r.errors.length),rows};result.scenarios.push(row);fs.writeFileSync(out,JSON.stringify(result,null,2));console.log(`${row.pass?'PASS':'FAIL'} ${c.id} ${rows.flatMap(r=>r.errors).join('; ')}`);
}
(async()=>{let cursor=0;await Promise.all(Array.from({length:Number(arg('--concurrency')||1)},async()=>{while(cursor<selected.length&&!providerBlocked)await run(selected[cursor++]);}));result.finished=new Date().toISOString();result.providerErrors=providerErrors;result.summary={total:result.scenarios.length,passed:result.scenarios.filter(s=>s.pass).length,failed:result.scenarios.filter(s=>!s.pass).length,calls:result.calls,notRun:selected.length-result.scenarios.length};fs.writeFileSync(out,JSON.stringify(result,null,2));console.log(JSON.stringify(result.summary));})().catch(e=>{console.error(e.message);process.exitCode=1;});
