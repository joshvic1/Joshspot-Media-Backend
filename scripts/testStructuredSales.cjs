// Explicit, synthetic provider evaluation. No Mongo connection, worker, invoice,
// payment or WhatsApp action is executed. Model calls use normal API billing.
if(!process.argv.includes('--live-provider'))throw new Error('Use --live-provider to run the synthetic OpenAI evaluation.');
require('dotenv').config({path:require('node:path').join(__dirname,'../.env'),quiet:true});
const assert=require('node:assert/strict');
const engine=require('../inbox/ai/engine'),defaults=require('../inbox/ai/defaults'),kb=require('../inbox/ai/structuredKnowledge');
const records=[...defaults.records,...kb.seeds];
const config={...defaults.config,structuredSales:true,invoicesEnabled:true};
const scenarios=process.argv.includes('--setup')?[
 ['How much is TikTok account setup?','reply','CONFIRM_PROCEED'],
 ['What does setup include?','reply','CONFIRM_PROCEED'],
 ['Does that include my advertising budget?','reply','CONFIRM_PROCEED'],
 ['Okay send the account details','invoice','SEND_INVOICE'],
]:[
 ['Hi','reply','DISCOVER_SERVICE'],
 ['I want you to manage and run my TikTok campaign, not account setup.','reply','GET_BUDGET_DURATION'],
 ['My advertising budget is 100k.','reply','GET_DURATION'],
 ['10 days please','reply','CONFIRM_PROCEED'],
 ['Yes','reply','OFFER_PAYMENT_DETAILS'],
 ['Yes, send the account details','invoice','SEND_INVOICE'],
];
(async()=>{
 let state={},history=[];
 for(const [text,action,objective]of scenarios){
   const knowledge=kb.rank(records.filter(r=>r.kind==='knowledge'),text,state);
   const result=await engine.decide({text,state,history,config,records,knowledge});
   console.log(JSON.stringify({input:text,action:result.action,objective:result.state?.nextObjective,amount:result.amount,response:result.response,handoff:result.handoff}));
   assert.equal(result.action,action);assert.equal(result.state.nextObjective,objective);
   state=result.state;history.push({direction:'inbound',text},{direction:'outbound',text:result.response});
 }
 console.log('PASS: synthetic provider multi-turn sales flow; no external business actions.');
})().catch(error=>{console.error(error.code||error.name, error.response?'Provider request failed':error.message);process.exitCode=1;});
