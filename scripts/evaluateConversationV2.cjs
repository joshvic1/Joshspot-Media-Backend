// Explicit opt-in real-model evaluation. Synthetic customers; no MongoDB, sends,
// invoice creation, assignment or configuration changes. Uses billable API calls.
if(!process.argv.includes('--live-model'))throw new Error('Pass --live-model to authorize the bounded OpenAI evaluation');
require('dotenv').config({quiet:true});
const {decide}=require('../inbox/ai/v2');
const defaults=require('../inbox/ai/defaults'),kb=require('../inbox/ai/structuredKnowledge');
const config={...defaults.config,model:process.env.OPENAI_MODEL,engineVersion:'v1',mode:'DRAFT',structuredSales:true,invoicesEnabled:true,maxResponseLength:4000};
if(process.argv.includes('--model'))config.model=process.argv[process.argv.indexOf('--model')+1];
const records=[...defaults.records,...kb.seeds];
const scenarios=[
 {name:'multi-slot daily budget',turns:['I want you to run TikTok ads for me. Five thousand daily for two days.'],check:r=>r.amount===35000&&r.action==='reply'},
 {name:'contextual choice then course detour',turns:['I want to run ads','The one where you handle the campaign for me','TikTok','What about your course?','Forget the course for now. What daily spend would you suggest for the ads?'],objectives:['SERVICE','PLATFORM','BUDGET_DURATION',null,'SELECT_PLAN'],check:r=>r.state.core.purchasePath==='advertising'&&r.response.includes('60,000')&&r.action==='reply'},
 {name:'combined services',turns:['I want TikTok. Set up the account but still run the campaign for me for a week.'],check:r=>r.amount===80000&&r.action==='reply'},
 {name:'defer then factual question',turns:['Set up my TikTok ads account','Let me discuss it with my partner first','Does the setup fee include the advertising money?'],check:r=>r.state.core.readiness==='deferred'&&r.action==='reply'&&!r.question&&r.response.length>10},
];
(async()=>{
 const selected=process.argv.includes('--case')?scenarios.filter((_,i)=>i===Number(process.argv[process.argv.indexOf('--case')+1])):scenarios;
 let failed=0,calls=0;for(const scenario of selected){let state={},history=[],last;const turns=[];
  for(const [i,text]of scenario.turns.entries()){
   last=await decide({text,state,history,records,config,type:'text',reserveModelCall:async()=>{calls++;}});
   turns.push({text,action:last.action,response:last.response,amount:last.amount,error:last.error,handoff:last.handoff,question:last.question?.purpose,changes:last.debug?.stateChanges,...(last.error?{composition:last.debug?.composition,selection:last.debug?.retrieval?.selected}:{} )});
   state=last.state;history.push({_id:`c-${i}`,direction:'inbound',status:'received',text},{_id:`a-${i}`,direction:'outbound',status:'sent',text:last.response,automation:{question:last.question},sentAt:new Date().toISOString()});
   if(last.action==='handoff')break;
  }
  const pass=scenario.check(last)&&(!scenario.objectives||scenario.objectives.every((q,i)=>(turns[i]?.question||null)===q))&&turns.every(t=>!/(?:When the customer|configured management plans|Do not assume)/.test(t.response));if(!pass)failed++;console.log(JSON.stringify({scenario:scenario.name,pass,turns}));
 }console.log(JSON.stringify({scenarios:selected.length,failed,calls,model:config.model}));process.exitCode=failed?1:0;
})().catch(e=>{console.error(e.message);process.exitCode=1;});
