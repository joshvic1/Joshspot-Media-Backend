// One approved execution, synthetic customers, real OpenAI, no application DB/financial ports.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../..');
const source=require('../v3-implementation-20261006/golden-conversations.cjs');
const snap=require('./evaluation-snapshot.json');
const dataset=structuredClone(source);
dataset.status='APPROVED_SINGLE_RUN';
dataset.scenarios.find(s=>s.id==='G30').expected=['Owner corrected plan:265000 total =200000 advertising+65000 management. Use authoritative package; simulated invoice only on current permission.'];
dataset.scenarios.find(s=>s.id==='G30').category='owner-corrected 15-day package';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function manifest(){const dir=path.join(root,'inbox/ai/v3');return Object.fromEntries(fs.readdirSync(dir).filter(f=>f.endsWith('.js')).map(f=>[f,hash(fs.readFileSync(path.join(dir,f)))]).concat([['defaults.js',hash(fs.readFileSync(path.join(root,'inbox/ai/defaults.js')))],['calculator',hash(fs.readFileSync(path.join(root,'inbox/ai/vendor/adsPricingConfig.mjs')))]]));}
const clone=x=>JSON.parse(JSON.stringify(x));
async function main(){
 if(process.argv[2]!=='--approved-once')throw Error('Explicit run flag required');
 fs.writeFileSync(path.join(__dirname,'RUN_STARTED.json'),JSON.stringify({at:new Date().toISOString(),model:snap.model}),{flag:'wx'});
 const env=require('dotenv').parse(fs.readFileSync(path.join(root,'.env')));
 for(const k of Object.keys(process.env))if(/MONGO|PAYSTACK|FLUTTERWAVE|WHATSAPP|AI_ENGINE|AI_V.*LIVE/.test(k))delete process.env[k];
 process.env.OPENAI_API_KEY=env.OPENAI_API_KEY;process.env.OPENAI_MODEL=snap.model;
 const before=manifest();
 const config={...require('../../inbox/ai/defaults').config,...snap.config.data,v3Model:snap.model,model:snap.model,engineVersion:'v3',mode:'DRAFT',autoReply:false};
 fs.writeFileSync(path.join(__dirname,'frozen-dataset.json'),JSON.stringify(dataset,null,2),{flag:'wx'});
 fs.writeFileSync(path.join(__dirname,'run-manifest.json'),JSON.stringify({before,model:snap.model,configRevision:snap.config.revision,config,snapshotHash:hash(JSON.stringify(snap)),datasetHash:hash(JSON.stringify(dataset)),simulation:true,samples:1,concurrency:2,judge:false,notes:'Actual V3 core/client; Test-style memory only. G23 trusted status pending. No simulated invoice persisted by current V3 TEST implementation. Test mode allows later turns after handoff intent. Errors remain visible; no turn/scenario retries.'},null,2),{flag:'wx'});
 const axios=require('axios'),{AsyncLocalStorage}=require('node:async_hooks'),als=new AsyncLocalStorage();
 axios.interceptors.request.use(c=>{if(!c.url.startsWith('https://api.openai.com/v1/'))throw Error('NON_OPENAI_NETWORK_BLOCKED');const s=als.getStore();if(s){s.httpCalls++;s.http.push({method:c.method,path:c.url.replace('https://api.openai.com/v1','')});}return c;});
 axios.interceptors.response.use(r=>{const s=als.getStore();if(s&&r.config.url.endsWith('/responses'))s.rawResponses.push({id:r.data.id,model:r.data.model,status:r.data.status,usage:r.data.usage,output:r.data.output});return r;},e=>{const s=als.getStore();if(s)s.providerErrors.push({status:e.response?.status,code:e.response?.data?.error?.code,message:e.response?.data?.error?.message||e.message});return Promise.reject(e);});
 const {client}=require('../../inbox/ai/v3/openai'),{decide}=require('../../inbox/ai/v3');
 const results=[];let cursor=0;
 async function scenario(s){
  const state={},history=[],result={id:s.id,category:s.category,expected:s.expected,plannedCustomerTurns:s.turns,turns:[]};
  for(let i=0;i<s.turns.length;i++){
   const indices=dataset.batchOverrides[s.id]?.find(b=>b[0]===i)||[i];
   const messages=indices.map(n=>({_id:`${s.id}-in-${n}`,direction:'inbound',type:'text',status:'received',text:s.turns[n],createdAt:new Date().toISOString()}));i=indices.at(-1);
   const turn={customer:messages,historyBefore:clone(history),stateBefore:clone(state),usage:{calls:0,input_tokens:0,output_tokens:0,total_tokens:0,cached_input_tokens:0},httpCalls:0,http:[],rawResponses:[],providerErrors:[],safetyFailures:[],simulated:true};
   const started=Date.now();
   await als.run(turn,async()=>{
    const api=client({config,onAttempt:()=>turn.usage.calls++,onUsage:u=>{for(const k of ['input_tokens','output_tokens','total_tokens'])turn.usage[k]+=u[k]||0;turn.usage.cached_input_tokens+=u.input_tokens_details?.cached_tokens||0;}});
    const ports={assertCurrent:async()=>{},persist:async()=>{},invoiceStatus:async()=>({status:s.id==='G23'?'pending':'NONE',simulation:true})};
    try{
     const r=await decide({config,records:snap.records,messages,history:history.slice(-80),state,ports,api,simulation:true});
     turn.result=r;turn.finalAction=r.action;turn.status='COMPLETED';
     history.push(...messages,{_id:`${s.id}-out-${i}`,direction:'outbound',type:'text',status:'sent',text:r.response,createdAt:new Date().toISOString()});
    }catch(e){turn.error={message:e.message,code:e.code,status:e.status};turn.debug=e.debug;turn.finalAction='NO_REPLY_ERROR';turn.status=turn.providerErrors.length?'INCONCLUSIVE_PROVIDER':'BACKEND_REJECTED';if(/UNTRUSTED|UNVERIFIED|GUARANTEE|CAP_EXCEEDED/.test(e.message))turn.safetyFailures.push({code:e.message,blocked:true});}
   });
   turn.elapsedMs=Date.now()-started;turn.stateAfter=clone(state);turn.usage.estimated_cost_usd=require('../../inbox/ai/v3/cost').estimate(snap.model,turn.usage);
   const trace=turn.result?.debug?.tools||turn.debug?.tools||[];
   turn.knowledge=trace.filter(t=>t.tool==='get_business_knowledge').map(t=>t.result);
   turn.simulatedActions=trace.filter(t=>['create_invoice','handoff_to_human','check_payment_status','get_invoice_status'].includes(t.tool));
   for(const t of trace){if(t.tool==='calculate_ads_quote'&&t.result?.purchaseCap!=null&&t.result.total>t.result.purchaseCap)turn.safetyFailures.push({code:'CAP_EXCEEDED_ALLOWED',blocked:false});if(t.tool==='create_invoice'&&t.result?.id)turn.safetyFailures.push({code:'REAL_INVOICE_IN_TEST',blocked:false});}
   result.turns.push(turn);
   fs.writeFileSync(path.join(__dirname,`${s.id}-turn-${String(i+1).padStart(2,'0')}.json`),JSON.stringify(turn,null,2),{flag:'wx'});
   console.log(`${s.id} ${i+1}/${s.turns.length} ${turn.status} calls=${turn.usage.calls} ${turn.error?.message||''}`);
  }
  result.completeHistory=history;result.usage=result.turns.reduce((a,t)=>{for(const k of ['calls','input_tokens','output_tokens','total_tokens','cached_input_tokens','estimated_cost_usd'])a[k]=(a[k]||0)+(t.usage[k]||0);return a;},{});
  fs.writeFileSync(path.join(__dirname,`${s.id}.json`),JSON.stringify(result,null,2),{flag:'wx'});results.push(result);
 }
 await Promise.all([0,1].map(async()=>{while(cursor<dataset.scenarios.length){const s=dataset.scenarios[cursor++];await scenario(s);}}));
 results.sort((a,b)=>a.id.localeCompare(b.id));
 const totals=results.reduce((a,r)=>{for(const [k,v]of Object.entries(r.usage))a[k]=(a[k]||0)+v;return a;},{});
 totals.http_calls=results.flatMap(r=>r.turns).reduce((n,t)=>n+t.httpCalls,0);
 const after=manifest();const report={finishedAt:new Date().toISOString(),model:snap.model,scenarios:results.length,turns:results.reduce((n,r)=>n+r.turns.length,0),totals,implementationUnchanged:JSON.stringify(before)===JSON.stringify(after),after};
 fs.writeFileSync(path.join(__dirname,'totals.json'),JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
