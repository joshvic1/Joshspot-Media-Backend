const model=require('./model'),contracts=require('./contracts'),contextBuilder=require('./context'),states=require('./state'),retrieval=require('./knowledge'),planner=require('./planner'),composer=require('./compose'),ledgerBuilder=require('./ledger');
async function decide(args,deps={}){
 args={...args,config:{...args.config,v2Deadline:Date.now()+65000,model:args.config.v2Model||process.env.OPENAI_V2_MODEL||args.config.model}};
 const trace={engineVersion:'v2',steps:[]},usage={input_tokens:0,output_tokens:0,total_tokens:0};let selectedModel,core=states.initial(args.state),state=states.projection(core,args.state),context;
 const call=async(phase,input)=>{const start=Date.now();try{const r=await(deps.call||model.call)(phase,input,args.config,args.reserveModelCall);selectedModel=r.model;for(const k of Object.keys(usage))usage[k]+=r.usage?.[k]||0;trace.steps.push({phase,latency:Date.now()-start});return contracts.validate(contracts[phase],phase==='interpretation'?contracts.upgrade(r.value):r.value);}catch(e){for(const k of Object.keys(usage))usage[k]+=e.usage?.[k]||0;throw e;}};
 try{
  const raw=args.messages?.length?args.messages:[{text:args.text||''}];
  if(raw.reduce((sum,m)=>sum+String(m.text||'').length,0)>24000)throw new Error('COMPLETE_TURN_TOO_LARGE: staff review required; no truncation performed');
  context=contextBuilder.build(args);trace.context=context;
  require('./delivery').reconcile(core,context);state=states.projection(core,args.state);
  const records=(args.records||[]).filter(r=>r.enabled!==false&&!r.archived);
  if(args.type&&args.type!=='text'||args.paymentVerified){return {action:'handoff',handoff:args.paymentVerified?'PAYMENT_VERIFIED':'MEDIA_RECEIVED',state,response:args.paymentVerified?'Payment confirmed. Thank you — customer support will help with the next step.':require('./authority').wording.handoff,debug:trace,usage};}
  const interpretation=await call('interpretation',{context,state:core,catalogue:records.filter(r=>['service','plan'].includes(r.kind)).map(r=>({key:r.key,title:r.title,kind:r.kind,platforms:r.data.platforms,type:r.data.serviceType,duration:r.data.duration}))});trace.interpretation=interpretation;
  for(const key of ['questions','recommendations','requests'])interpretation[key]=interpretation[key].filter(r=>states.evidenced(r.evidence,context));
  const merged=states.merge({...args.state,core},interpretation,context,records);core=merged.state;state=states.projection(core,args.state);trace.stateChanges={accepted:merged.accepted,rejected:merged.rejected};
  const ledger=ledgerBuilder.build(interpretation,context);trace.requestLedger=ledger;
  // Semantic selection sees the updated state on EVERY text turn, including
  // statements and policy triggers. Only selected bodies reach composition.
  const catalogue=retrieval.catalogue(records,state);
  const selection=await call('selection',{requests:ledger,questions:interpretation.questions,intents:interpretation.intents,context,state:core,catalogue,commercialRecords:records.filter(r=>['service','plan'].includes(r.kind))});
  trace.retrieval={candidates:catalogue.map(r=>r.key),selected:selection};
  const knowledge=retrieval.select(records,state,selection),sources=knowledge.filter(k=>retrieval.role(k)!=='GUIDANCE');
  const plan=await(deps.plan||planner.plan)({core,state,interpretation,context,records,knowledge,unsupportedQuestions:selection.unsupportedQuestions,config:args.config,paymentVerified:args.paymentVerified,invoiceRecord:args.invoiceRecord,type:args.type||'text',ledger});trace.plan=plan;
  const prepared={parts:[...plan.requiredFacts.map(value=>({kind:'fact',value})),...(plan.question?[{kind:'question',value:plan.question.purpose}]:[])],usedKnowledge:[]};
  const input={context,state:core,questions:interpretation.questions,requestLedger:ledger,plan:{...plan,facts:Object.fromEntries(Object.keys(plan.facts).map(k=>[k,`Reference backend fact ${k}`])),quotes:undefined,amount:undefined},knowledge:sources.map(k=>({key:k.key,mode:k.data.responseMode,allowContext:k.data.allowContext,quoteable:retrieval.quoteable(k),role:retrieval.role(k),facts:k.data.facts,text:k.data.preferredResponse||k.data.answer||k.data.facts})),internalGuidance:knowledge.filter(k=>retrieval.role(k)==='GUIDANCE').map(k=>({key:k.key,instructions:k.data.notes||k.data.answer})),tone:{tone:args.config.tone,style:args.config.writingStyle},maxCharacters:args.config.maxResponseLength};
  let output=ledger.some(n=>n.disposition==='PENDING')||!prepared.parts.length?await call('composition',input):prepared,response;
  // Bounded format/provenance repair; never turn malformed output into an
  // invoice or permit an unsupported assertion just to avoid handoff.
  const plannedLedger=JSON.parse(JSON.stringify(ledger));
  for(let attempt=0;attempt<2;attempt++){
   ledger.splice(0,ledger.length,...JSON.parse(JSON.stringify(plannedLedger)));
   try{await composer.validate(output,plan,sources,call);response=composer.render(output,plan,sources,args.config);break;}
   catch(error){trace.steps.push({phase:'validation',attempt,error:error.message});if(attempt===1)throw error;output=await call('composition',{...input,repair:{error:error.message,previous:output}});}
  }
  trace.composition=output;
  if(plan.amount){core.quote={amount:plan.amount,items:plan.quotes,at:context.now,selectionVersion:core.selectionVersion};for(const q of plan.quotes){const item=core.items.find(x=>x.id===q.itemId);if(item)item.quote=q;}}
  core.prepared={at:context.now,question:plan.question,quote:core.quote,action:plan.action};
  state={...states.projection(core,args.state),nextObjective:plan.reason};
  const includesQuote=plan.requiredFacts.includes('quote')||output.parts.some(p=>p.kind==='fact'&&p.value==='quote');
  const delivery={selectionVersion:core.selectionVersion,question:plan.question,quote:includesQuote?core.quote:null,stage:plan.question?.purpose==='PAYMENT'?'PAYMENT_OFFERED':includesQuote?'PRICE_PRESENTED':null};
  return {action:plan.action,handoff:plan.action==='handoff'?plan.reason:undefined,handoffRule:plan.handoffRule,state,response,amount:plan.amount,serviceKey:plan.quotes.map(q=>q.itemId).sort().join('+'),intent:interpretation.intents[0]||'knowledge',confidence:interpretation.confidence,model:selectedModel,usage,knowledge:knowledge.map(k=>k.key),question:plan.question,delivery,debug:model.clean(trace)};
 }catch(error){trace.failure={message:error.message,providerCode:error.response?.data?.error?.code};return {action:'handoff',handoff:'V2_VALIDATION_OR_PROVIDER_FAILURE',state,response:require('./authority').wording.handoff,error:error.message,model:selectedModel,usage,debug:model.clean(trace)};}
}
module.exports={decide};
