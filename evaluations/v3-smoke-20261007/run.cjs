// Evaluation instrumentation only. Does not alter the imported V3 runtime.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..'),clone=x=>JSON.parse(JSON.stringify(x));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const write=(name,value)=>fs.writeFileSync(path.join(__dirname,name),JSON.stringify(value,null,2),{flag:'wx'});
function hashes(dir){return Object.fromEntries(fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?Object.entries(hashes(path.join(dir,e.name))):[[path.relative(root,path.join(dir,e.name)),hash(fs.readFileSync(path.join(dir,e.name)))]]));}
async function main(){
 if(process.argv[2]!=='--approved-once')throw Error('Run flag required');
 const pre=require('./preflight.json'),scenarios=require('./scenarios.json');
 if(scenarios.length!==6)throw Error('EXACTLY_SIX_REQUIRED');
 const snap=require('../v3-golden-20261007/evaluation-snapshot.json');
 const records=clone(snap.records);if(records.find(r=>r.kind==='plan'&&r.key==='plan_15')?.data.amount!==265000)throw Error('LOCAL_PLAN_CONFLICT');
 const config={...require('../../inbox/ai/defaults').config,...snap.config.data,...pre.config.data,v3Model:pre.model,model:pre.model,engineVersion:'v3',mode:'DRAFT',autoReply:false};
 const baseline={runtime:hashes(path.join(root,'inbox/ai/v3')),golden:hashes(path.join(root,'evaluations/v3-golden-20261007')),calculator:hash(fs.readFileSync(path.join(root,'inbox/ai/vendor/adsPricingConfig.mjs')))};
 write('manifest.json',{at:new Date().toISOString(),model:pre.model,config,configRevision:pre.config.revision,baseline,datasetHash:hash(fs.readFileSync(path.join(__dirname,'scenarios.json'))),snapshotHash:hash(JSON.stringify(records)),simulation:true,concurrency:1,externalDestinations:['https://api.openai.com/v1/'],stopping:'No turn/scenario retries. Stop scenario on runtime/provider error, handoff or unsafe side effect. Later planned turns remain NOT_RUN.',pricingSource:'https://developers.openai.com/api/docs/models/gpt-4.1-mini',ratesPerMillion:{input:.4,cached:.1,output:1.6}});
 write('local-business-snapshot.json',{records,source:'Unmodified corrected local catalogue from prior evaluation; no production catalogue edits'});
 write('RUN_STARTED.json',{at:new Date().toISOString(),model:pre.model});
 const env=require('dotenv').parse(fs.readFileSync(path.join(root,'.env')));
 for(const k of Object.keys(process.env))if(/MONGO|PAYSTACK|FLUTTERWAVE|WHATSAPP|AI_ENGINE|AI_V.*LIVE/.test(k))delete process.env[k];
 process.env.OPENAI_API_KEY=env.OPENAI_API_KEY;process.env.OPENAI_MODEL=pre.model;
 const axios=require('axios'),{AsyncLocalStorage}=require('node:async_hooks'),als=new AsyncLocalStorage();
 axios.interceptors.request.use(c=>{
  if(!c.url.startsWith('https://api.openai.com/v1/'))throw Error('NON_OPENAI_NETWORK_BLOCKED');
  const t=als.getStore();if(t){const event={method:c.method,path:c.url.replace('https://api.openai.com/v1',''),startedAt:Date.now()};if(event.path==='/responses')event.body=clone(c.data);t.http.push(event);c.smokeEvent=event;}
  return c;
 });
 axios.interceptors.response.use(r=>{const ev=r.config.smokeEvent;if(ev){ev.status=r.status;ev.elapsedMs=Date.now()-ev.startedAt;if(ev.path==='/responses')ev.response=clone(r.data);}return r;},e=>{const ev=e.config?.smokeEvent;if(ev){ev.status=e.response?.status;ev.elapsedMs=Date.now()-ev.startedAt;ev.error={code:e.response?.data?.error?.code,message:e.response?.data?.error?.message||e.message,param:e.response?.data?.error?.param};}return Promise.reject(e);});
 const {client}=require('../../inbox/ai/v3/openai'),{decide}=require('../../inbox/ai/v3'),cost=require('../../inbox/ai/v3/cost');
 const results=[];
 for(const s of scenarios){
  const state={},history=[],result={...s,plannedTurns:s.turns,turns:[],stopReason:null};
  for(let i=0;i<s.turns.length;i++){
   const message={_id:`${s.id}-in-${i+1}`,direction:'inbound',status:'received',type:'text',text:s.turns[i],createdAt:new Date().toISOString()};
   const t={id:`${s.id}.${i+1}`,customer:message,historyBefore:clone(history),stateBefore:clone(state),http:[],usage:{calls:0,input_tokens:0,output_tokens:0,total_tokens:0,cached_input_tokens:0},simulation:true,safety:[]};
   const start=Date.now();
   await als.run(t,async()=>{
    const api=client({config,onAttempt:()=>t.usage.calls++,onUsage:u=>{for(const k of ['input_tokens','output_tokens','total_tokens'])t.usage[k]+=u[k]||0;t.usage.cached_input_tokens+=u.input_tokens_details?.cached_tokens||0;}});
    const ports={assertCurrent:async()=>{},persist:async()=>{},invoiceStatus:async()=>({status:'NONE',simulation:true})};
    try{t.result=await decide({config,records,messages:[message],history,state,ports,api,simulation:true});t.status='COMPLETED';}
    catch(e){t.error={message:e.message,code:e.code,status:e.status};t.debug=e.debug;t.status=t.http.some(h=>h.error)?'PROVIDER_OR_SCHEMA_ERROR':'BACKEND_REJECTED';}
   });
   t.elapsedMs=Date.now()-start;t.stateAfter=clone(state);t.usage.estimated_cost_usd=cost.estimate(pre.model,t.usage);t.httpCalls=t.http.length;
   t.tools=t.result?.debug?.tools||t.debug?.tools||[];t.plan=t.result?.debug?.plan||t.debug?.plan;
   t.knowledge=t.tools.filter(x=>x.tool==='get_business_knowledge');
   t.modelIterations=t.http.filter(h=>h.path==='/responses'&&h.body?.conversation).length;
   t.simulatedActions=t.tools.filter(x=>['create_invoice','handoff_to_human','check_payment_status'].includes(x.tool));
   for(const x of t.tools){if(x.tool==='calculate_ads_quote'&&x.result?.purchaseCap!=null&&x.result.total>x.result.purchaseCap)t.safety.push('QUOTE_OVER_CAP');if(x.tool==='create_invoice'&&x.result?.ok!==false&&!x.result?.simulation)t.safety.push('NONSIMULATED_INVOICE');}
   history.push(message);if(t.result?.response)history.push({_id:`${s.id}-out-${i+1}`,direction:'outbound',type:'text',status:'sent',text:t.result.response,createdAt:new Date().toISOString()});
   result.turns.push(t);write(`${s.id}-turn-${i+1}.json`,t);console.log(`${t.id} ${t.status} calls=${t.usage.calls} ${t.error?.message||''}`);
   if(t.error||t.safety.length||t.result?.action==='handoff'){result.stopReason=t.error?.message||t.safety.join(',')||'SIMULATED_HANDOFF';break;}
  }
  result.completeHistory=history;result.notRun=s.turns.slice(result.turns.length);write(`${s.id}.json`,result);results.push(result);
 }
 const ts=results.flatMap(r=>r.turns),totals={};for(const t of ts)for(const [k,v]of Object.entries(t.usage))totals[k]=(totals[k]||0)+v;
 const after={runtime:hashes(path.join(root,'inbox/ai/v3')),golden:hashes(path.join(root,'evaluations/v3-golden-20261007')),calculator:hash(fs.readFileSync(path.join(root,'inbox/ai/vendor/adsPricingConfig.mjs')))};
 write('totals.json',{model:pre.model,scenarios:results.length,customerTurns:ts.length,plannedTurns:scenarios.reduce((n,s)=>n+s.turns.length,0),totals,httpCalls:ts.reduce((n,t)=>n+t.httpCalls,0),averageLatencyMs:ts.reduce((n,t)=>n+t.elapsedMs,0)/ts.length,averageCost:totals.estimated_cost_usd/ts.length,averageModelCalls:totals.calls/ts.length,slowest:ts.reduce((a,b)=>a.elapsedMs>b.elapsedMs?a:b).id,highestToken:ts.reduce((a,b)=>a.usage.total_tokens>b.usage.total_tokens?a:b).id,integrityUnchanged:JSON.stringify(baseline)===JSON.stringify(after),finishedAt:new Date().toISOString()});
 console.log('SIX SCENARIOS ATTEMPTED ONCE. No reruns.');
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
