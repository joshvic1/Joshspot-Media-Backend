// Acceptance harness only. No application, database, worker or real action ports.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),cp=require('child_process');
const root=path.resolve(__dirname,'../..'),write=(n,v)=>fs.writeFileSync(path.join(__dirname,n),JSON.stringify(v,null,2));
const scenarios=[
 {id:'A',name:'Ambiguous ads to setup',turns:['Good evening boss, abeg I need help with adverts','Na the one you arrange the account then I go operate am myself','Tiktok is the one I use','How much for that one and wetin you need from me?'],expected:'Setup only; TikTok 20000; approved requirements; no campaign budget/duration.'},
 {id:'B',name:'Daily management to payment',turns:['I need your team to handle my TikTok advert for me','I fit put like 5k into the ad every day','Make we try seven days first','Give me the full amount please, separate the ad money from your own charge','Yes I am ready now, send the account let me pay'],expected:'Management only; 5000 daily x7, 35000 ads +25000 management =60000; simulated invoice on current consent.'},
 {id:'C',name:'Recommended 15-day package',turns:['You people should run my TikTok ads. I no sabi what budget or days to choose, advise me','That fifteen days package sounds okay, na that one I want','What exactly am I paying for, the money for the ads dey inside?'],expected:'Plans without forced budget; 265000 total =200000 ads +65000 management; no setup/285000.'},
 {id:'D',name:'Mixed purchase and total cap',turns:['Set up TikTok account for me, but it is Facebook and Instagram I want you to manage. For those ones use 6k daily for ten days','Everything together must not pass 100k o, including TikTok setup and all your charges','Change the Facebook and Instagram to seven days instead, that 100k ceiling still stands'],expected:'TikTok setup + Meta management only; cap100000; duration correction7; no duplicated platforms or unrequested paid creatives.'},
 {id:'E',name:'Course detour switch and return',turns:['Please manage my TikTok campaign, 5k a day for one week','By the way do you sell any lesson where person can learn this thing? Just asking','Leave the campaign for now, I want to buy the training instead','How much be the training and where do I get access?','Actually let us continue that campaign you were going to manage earlier'],expected:'Course enquiry keeps management; explicit switch COURSE; approved8000/link; return management from actual history.'},
 {id:'F',name:'Deferral overrides consent',turns:['I want TikTok account setup only, tell me the price','Okay I am ready to go with it','Hold on first, dont send any account yet. I need to settle something before I come back','While I sort that, what does the setup cover please?','I am back and ready now. Send payment details for that setup'],expected:'Setup20000; deferral stops payment pressure; supported answer; invoice only final current request.'},
 {id:'G',name:'Three questions together',turns:['I want you to manage TikTok for me, that one week recommended package','How many views or sales can I expect, how many videos should I send and what kind, plus is the advert money part of your package?'],expected:'Results+creative+inclusions requests; scoped management knowledge; no guarantees/invented creative requirements; acknowledge missing facts.'},
 {id:'H',name:'Payment claim then human',turns:['I want only the TikTok ads account setup, please give me the amount','I don transfer the money already, check am please','Abeg connect me to an actual staff person now'],expected:'Trusted payment check remains unverified; human request simulated handoff; no further autonomous reply.'}
];
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(d=>d.isDirectory()?files(path.join(dir,d.name)):[path.join(dir,d.name)]);}
function hashes(){const dirs=['inbox','models','controllers','evaluations/v3-golden-20261007','evaluations/v3-smoke-20261007','evaluations/v4-implementation-20261007'];return Object.fromEntries(dirs.flatMap(d=>files(path.join(root,d))).map(p=>[path.relative(root,p),crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]));}
const snapshot=require('../v3-golden-20261007/evaluation-snapshot.json');
const config={...require('../../inbox/ai/defaults').config,...snapshot.config.data,engineVersion:'v4',mode:'TEST',v4InterpreterModel:'gpt-6.1-sol',v4InterpreterReasoning:'medium',v4ComposerModel:'gpt-6-luna',v4ComposerReasoning:'medium'};
const records=structuredClone(snapshot.records),adapter=require('../../inbox/ai/v4/model'),testAgent=require('../../inbox/ai/v4/testAgent');
const env=require('dotenv').parse(fs.readFileSync(path.join(root,'.env')));
process.env.OPENAI_API_KEY=env.OPENAI_API_KEY; // Load only the API credential; no DB/payment credentials.
if(!process.env.OPENAI_API_KEY)throw Error('API key missing');
const preflight={revision:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirtyWorkingTreeHashed:true,config,knowledgeSnapshot:'evaluations/v3-golden-20261007/evaluation-snapshot.json',records:records.length,plan15:records.find(r=>r.key==='plan_15'),simulation:true,databaseConnected:false,onlyNetworkDestination:'https://api.openai.com/v1/responses',keyPresent:true,models:adapter.rates};
if(preflight.plan15.data.amount!==265000)throw Error('Local plan15 conflict');
if(process.argv.includes('--preflight')){write('preflight.json',preflight);write('scenarios.json',scenarios);write('integrity-before.json',hashes());console.log(JSON.stringify({models:[config.v4InterpreterModel,config.v4ComposerModel],invoicesEnabled:config.invoicesEnabled,history:config.v4HistoryMessages,outputTokens:config.v4MaxOutputTokens,responseCharacters:config.maxResponseLength,plan15:preflight.plan15.data.amount,conversations:8,turns:scenarios.reduce((n,s)=>n+s.turns.length,0),keyPresent:true}));process.exit(0);}
if(!process.argv.includes('--run-once'))throw Error('Explicit run flag required');
fs.writeFileSync(path.join(__dirname,'RUN-STARTED'),new Date().toISOString(),{flag:'wx'});
const baseline=JSON.parse(fs.readFileSync(path.join(__dirname,'integrity-before.json')));
if(JSON.stringify(hashes())!==JSON.stringify(baseline))throw Error('Frozen sources changed before run');
const results={startedAt:new Date().toISOString(),preflight,scenarios:[],calls:[]};let active;
const axios=require('axios');
const api=adapter.client({config,transport:async request=>{
 if(request.url!=='https://api.openai.com/v1/responses'||request.data.tools)throw Error('Unsafe evaluation transport');
 const call={number:results.calls.length+1,scenario:active.scenario,turn:active.turn,request:request.data,startedAt:new Date().toISOString()};results.calls.push(call);write('raw-results.json',results);
 const start=Date.now();try{const response=await axios(request);call.response=response.data;call.cost=adapter.estimate(request.data.model,response.data.usage||{});return response;}catch(e){call.error={status:e.response?.status,code:e.response?.data?.error?.code,message:e.response?.data?.error?.message||e.code||e.message};throw e;}finally{call.latencyMs=Date.now()-start;write('raw-results.json',results);}
}});
(async()=>{
 for(const scenario of scenarios){const out={...scenario,turns:[],unreached:[]};results.scenarios.push(out);let session;
  for(let i=0;i<scenario.turns.length;i++){
   active={scenario:scenario.id,turn:i+1};const turn={customer:scenario.turns[i],turn:i+1,startedAt:new Date().toISOString()},start=Date.now();out.turns.push(turn);
   try{turn.result=await testAgent.test({actor:'synthetic-v4-acceptance',body:{text:turn.customer,type:'text',v4SessionId:session},config,records,api});session=turn.result.v4SessionId;turn.completed=true;}
   catch(e){turn.completed=false;turn.error={message:e.message,status:e.status,code:e.code,usage:e.usage,debug:e.debug};}
   turn.latencyMs=Date.now()-start;write('raw-results.json',results);console.log(`${scenario.id}${i+1} ${turn.completed?'completed':turn.error.message}`);
   if(!turn.completed||turn.result.action==='handoff'){out.unreached=scenario.turns.slice(i+1);break;}
  }
 }
 results.finishedAt=new Date().toISOString();write('raw-results.json',results);const after=hashes();write('integrity-after.json',{unchanged:JSON.stringify(after)===JSON.stringify(baseline),hashes:after});
})().catch(e=>{console.error(e.message);process.exitCode=1;});
