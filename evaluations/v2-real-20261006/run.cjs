// Evaluation harness only. Frozen product modules are loaded without mutation.
const fs=require('node:fs'),path=require('node:path');
const {manifest,hash,root}=require('./preflight.cjs'),pre=require('./preflight.json'),snapshot=require('./catalogue-snapshot.json');
const arg=k=>process.argv.includes(k)?process.argv[process.argv.indexOf(k)+1]:undefined;
if(!process.argv.includes('--live-model'))throw new Error('Explicit --live-model required');
if(JSON.stringify(manifest())!==JSON.stringify(pre.hashes))throw new Error('Implementation or previous evidence changed; abort');
const env=require('dotenv').parse(fs.readFileSync(path.join(root,'.env')));
for(const k of Object.keys(process.env))if(/MONGO|PAYSTACK|FLUTTERWAVE|WHATSAPP|AI_ENGINE|AI_V2_LIVE/.test(k))delete process.env[k];
process.env.OPENAI_API_KEY=env.OPENAI_API_KEY;delete process.env.OPENAI_V2_MODEL;
const axios=require('axios');axios.interceptors.request.use(request=>{if(request.url!=='https://api.openai.com/v1/responses')throw new Error('EVALUATION_NETWORK_BLOCK');return request;});
const Module=require('node:module'),load=Module._load;
Module._load=function(id,parent,...rest){const target=Module._resolveFilename(id,parent);if([path.join(root,'inbox/ai/worker.js'),path.join(root,'inbox/ai/invoices.js'),path.join(root,'inbox/service.js'),path.join(root,'server.js')].includes(target))throw new Error('EVALUATION_EXECUTOR_BLOCK');return load.call(this,id,parent,...rest);};
const {decide}=require('../../inbox/ai/v2'),states=require('../../inbox/ai/v2/state'),api=require('../../inbox/ai/v2/model');
const frozen=require('../v2-adversarial/dataset.json'),{grade}=require('../v2-adversarial/grade.cjs');
const model=arg('--model')||'gpt-4.1-mini',suite=arg('--suite')||'frozen';
const cases=suite==='frozen'?frozen:require('./supplemental.json');
const config={...snapshot.config.data,model,v2Model:model,mode:'DRAFT',engineVersion:'v2'};
const records=snapshot.records,output=path.join(__dirname,'runs');fs.mkdirSync(output,{recursive:true});
const tag=arg('--tag')||`${suite}-${model}`,logFile=path.join(output,tag+'.jsonl');
const fd=fs.openSync(logFile,'wx'),write=value=>fs.writeSync(fd,JSON.stringify(value)+'\n');
const falseSignal={value:false,evidence:{messageId:'',text:''}};
function seed(c){if(c.initialState)return structuredClone(c.initialState);const text='Synthetic prior customer selection';const i={facts:Object.entries(c.seed||{}).map(([field,value])=>({field,value:String(value),itemId:'',confidence:1,explicit:true,correction:false,evidence:{messageId:'seed',text}})),items:[],decisions:[],budgets:[],requests:[],questions:[],recommendations:[],purchaseChange:{action:'none'},topic:'advertising',negotiation:falseSignal};return states.projection(states.merge({},i,{messages:[{id:'seed',text}],history:[],now:'2026-10-06T10:00:00Z'},records).state);}
const provider=e=>!!(e.response||['ECONNABORTED','ETIMEDOUT','ECONNRESET','ENOTFOUND','EAI_AGAIN'].includes(e.code));
let calls=0,completed=0,quotaFailures=0,halt=false;
const selected=cases.filter(c=>!arg('--ids')||arg('--ids').split(',').includes(c.id));
let jobs=selected.flatMap(c=>Array.from({length:Number(arg('--samples')||c.samples||1)},(_,i)=>({c,sample:i+1})));
if(arg('--retry-from')){const prior=fs.readFileSync(path.join(output,arg('--retry-from')),'utf8').trim().split('\n').map(JSON.parse),retry=new Set(prior.filter(r=>r.kind==='scenario_end'&&r.status==='INCONCLUSIVE_PROVIDER').map(r=>r.key));jobs=jobs.filter(j=>retry.has(`${j.c.id}/${j.sample}`));}
write({kind:'manifest',model,suite,tag,started:new Date().toISOString(),codeHash:pre.workingTreeHash,catalogueHash:pre.catalogueHash,configRevision:pre.configRevision,config:{maxHistory:config.maxHistory,maxResponseLength:config.maxResponseLength,mode:config.mode},jobs:jobs.map(j=>({id:j.c.id,sample:j.sample})),temperature:'omitted, product default',reasoning:'omitted, product default',generation:'real OpenAI at every phase; no interpretation/composition doubles',simulation:'Only successful replies append sent history. Invoices add synthetic prepared/sent metadata; handoff ends a closed loop, remaining turns are BLOCKED_AFTER_HANDOFF.'});
async function run({c,sample}){
 const key=`${c.id}/${sample}`;let state=seed(c),history=[],rows=[],blocked=false;
 if(c.question)history.push({_id:'question-seed',direction:'outbound',status:'sent',text:c.question.text,automation:{question:c.question},sentAt:'2026-10-06T10:00:01Z'});
 write({kind:'scenario_start',key,id:c.id,group:c.group,sample,expected:c.turns,initialState:state});
 for(let index=0;index<c.turns.length;index++){
  const t=c.turns[index];if(blocked||halt){write({kind:'not_run',key,index,text:t.text,reason:halt?'PROVIDER_STOP':'BLOCKED_AFTER_HANDOFF'});continue;}
  const messages=(t.messages||[t.text]).map((text,n)=>({_id:`${c.id}-${sample}-${index}-${n}`,text,type:'text'}));
  const before=structuredClone(state),start=Date.now(),callErrors=[];
  const r=await decide({text:t.text,messages,state,history:history.slice(-config.maxHistory),questionMessages:history.filter(m=>m.automation?.question).slice(-1),effectMessages:history.filter(m=>m.automation?.delivery?.stage).slice(-1),records,config,type:'text',invoiceRecord:state.invoiceId?.startsWith('evaluation-')?{amount:state.invoiceAmount,status:state.paymentStatus||'pending'}:null},{call:async(phase,input,cfg)=>{
   if(halt)throw new Error('Evaluation provider stop');
   calls++;const time=Date.now();let callUsage;
   try{const v=await api.call(phase,input,cfg);callUsage=v.usage;write({kind:'api',key,index,phase,model:v.model,latency:Date.now()-time,usage:v.usage,success:true});return v;}
   catch(e){const p=provider(e),details={provider:p,status:e.response?.status,code:e.response?.data?.error?.code||e.code,message:e.response?.data?.error?.message||e.message};callErrors.push(details);write({kind:'api',key,index,phase,model,latency:Date.now()-time,usage:e.usage,success:false,error:details});if(['insufficient_quota','credit_balance_exhausted'].includes(details.code)&&++quotaFailures>=3)halt=true;throw e;}
  }});
  const rawErrors=grade(r,t.expect||{});const row={kind:'turn',key,id:c.id,group:c.group,sample,index,text:t.text,messages,expected:t.expect,expectedBehavior:t.expectedBehavior||c.expectedBehavior,before,history:structuredClone(history),result:r,rawErrors,providerErrors:callErrors.filter(e=>e.provider),latency:Date.now()-start};rows.push(row);write(row);state=r.state;
  history.push(...messages.map(m=>({...m,direction:'inbound',status:'received'})));
  if(r.action==='invoice'){
   // Intent only: no invoice model/controller/provider is imported or called.
   const invoiceId=`evaluation-${key}-${index}`;Object.assign(state,{invoiceId,invoiceAmount:r.amount,invoiceStatus:'prepared',paymentStatus:'pending'});r.delivery={...r.delivery,stage:'PAYMENT_PENDING',invoiceId};
  }
  if(['reply','invoice'].includes(r.action))history.push({_id:`reply-${key}-${index}`,direction:'outbound',status:'sent',text:r.response+(r.action==='invoice'?'\n[Simulated invoice details sent; no payment destination generated.]':''),automation:{question:r.question,delivery:r.delivery},sentAt:new Date(Date.parse('2026-10-06T10:01:00Z')+index*1000).toISOString()});
  if(r.action==='handoff')blocked=true;
 }
 const status=rows.some(r=>r.providerErrors.length)?'INCONCLUSIVE_PROVIDER':rows.some(r=>r.rawErrors.length)||rows.length<c.turns.length?'FAIL':'PASS';
 write({kind:'scenario_end',key,id:c.id,group:c.group,sample,status,turns:rows.length,plannedTurns:c.turns.length});
 console.log(`${++completed}/${jobs.length} ${key} ${status}`);
}
(async()=>{let cursor=0;await Promise.all(Array.from({length:Number(arg('--concurrency')||3)},async()=>{while(cursor<jobs.length&&!halt)await run(jobs[cursor++]);}));const unchanged=JSON.stringify(manifest())===JSON.stringify(pre.hashes);write({kind:'end',finished:new Date().toISOString(),completed,planned:jobs.length,calls,unchanged,providerStopped:halt});fs.closeSync(fd);if(!unchanged)throw new Error('Freeze integrity changed');console.log(JSON.stringify({completed,calls,unchanged}));})().catch(e=>{write({kind:'fatal',message:e.message});console.error(e.message);process.exitCode=1;});
