const {tools,parse}=require('./contracts');
const {catalogue}=require('./catalogue');
const {dispatcher}=require('./tools');
const {prepare,delivered}=require('./context');
const {client}=require('./openai');
const {sensitive,redact}=require('../privacy');
const provenance=require('./provenance'),turn=require('./turn');
async function decide({config,records,messages,history=[],state={},ports,api:injected,reserveModelCall,simulation=true}){
 if(!simulation&&(config.mode!=='LIVE'||!ports.createInvoice))throw new Error('V3_LIVE_NOT_RELEASED');
 const started=Date.now(),usage={input_tokens:0,output_tokens:0,total_tokens:0,cached_input_tokens:0,calls:0};
 const unsupported=messages.some(m=>m.type&&m.type!=='text'||sensitive(m.text));
 const api=injected||(unsupported?{model:'not-called'}:client({config,reserve:reserveModelCall,onAttempt:()=>usage.calls++,onUsage:u=>{for(const k of ['input_tokens','output_tokens','total_tokens'])usage[k]+=u[k]||0;usage.cached_input_tokens+=u.input_tokens_details?.cached_tokens||0;}}));
 const book=catalogue(records),actual=delivered(history).map(m=>({...m,text:redact(m.text)})),current=messages.map(m=>({...m,_id:String(m._id),text:redact(m.text)}));
 const base={engineVersion:'v3',state:{},model:api.model,usage,debug:{engineVersion:'v3',catalogueRevision:book.revision,simulation}};
 if(state.quote?.catalogueRevision!==book.revision)delete state.quote;
 if(unsupported)return {...base,action:'handoff',handoff:messages.some(m=>sensitive(m.text))?'SENSITIVE_CASE':'MEDIA_RECEIVED',response:config.fallbackResponse||'Hold on, you will get a response shortly.'};
 let cleanup,dispatch,turnError,plan=null,answer='',outputProof=null;
 try{
  await ports.assertCurrent();cleanup=await prepare({api,state,messages:[...actual,...current],persist:ports.persist});
  dispatch=dispatcher({catalogue:book,state,messages:current,history:actual,api,ports,simulation});
  const trustedInvoice=await ports.invoiceStatus(false);
  const discovery=book.rows.filter(r=>r.kind==='service'||r.kind==='plan').map(r=>({key:r.key,kind:r.kind,title:r.title,service:r.data.serviceType||r.data.service,platforms:r.data.platforms,duration:r.data.duration}));
  let input=[{role:'developer',content:JSON.stringify({mode:simulation?'TEST/DRAFT: simulated actions only':'LIVE: guarded actions only',evidenceMessages:[...actual.slice(-12),...current].map(m=>({id:m._id,role:m.direction,text:m.text})),latestInboundIds:current.map(m=>m._id),knowledgeIndex:book.index,discovery,purchase:state.purchase||[],quote:state.quote||null,invoice:trustedInvoice,responseCharacterLimit:config.maxResponseLength||1500})}];
  let calls=0,repairs=0;
  for(let round=0;round<8;round++){
   await ports.assertCurrent();
   const response=await api.response({conversation:state.openaiConversationId,instructions:require('./instructions'),input,tools:plan?tools.filter(t=>t.name!=='plan_turn'):tools.filter(t=>t.name==='plan_turn'),tool_choice:plan?'required':{type:'function',name:'plan_turn'},parallel_tool_calls:false});
   const functions=(response.output||[]).filter(o=>o.type==='function_call');input=[];
   if(!functions.length){if(++repairs>1)throw new Error('V3_STRUCTURED_RESPONSE_REQUIRED');input=[{role:'developer',content:'A raw response is not accepted. Submit the required tool contract, with no internal envelope in customer text.'}];continue;}
   for(const call of functions){
    if(++calls>16)throw new Error('V3_TOOL_LIMIT');let result;
    try{
     if(!plan){
      if(call.name!=='plan_turn')throw new Error('PLAN_REQUIRED');
      plan=await turn.accept(parse(call.name,call.arguments),{state,messages:current,history:actual,dispatch,ports,catalogue:book});dispatch.setPlan(plan);
      result={accepted:true,plan,purchase:state.purchase||[],retrieved:dispatch.trace};
     }else if(call.name==='finish_response'){
      const final=parse(call.name,call.arguments);
      turn.validateQuestions(final,plan,state,current);
      if(final.coverage.some(c=>c.status==='unsupported')&&!dispatch.handoff)throw new Error('UNSUPPORTED_REQUEST_REQUIRES_HANDOFF');
      if(plan.payment==='request'&&state.quote&&!dispatch.invoice&&!dispatch.handoff){
       const e=plan.paymentEvidence;result=await dispatch.execute({name:'create_invoice',arguments:JSON.stringify({quoteId:state.quote.id,messageId:e.messageId,evidence:e.quote})});
       if(result.ok===false)throw new Error(result.error);
       result={invoiceAction:result,instruction:'Now compose the final answer, answering accompanying questions as well.'};
      }else{
       const missing=turn.pending(plan,dispatch,state);if(missing)throw new Error(missing);
       const payment=dispatch.invoice||dispatch.trace.findLast(t=>['get_invoice_status','check_payment_status'].includes(t.tool))?.result||trustedInvoice;
       outputProof=provenance.render(final,provenance.ledger(dispatch.trace,state.quote,payment),plan);answer=outputProof.text;
       const rejected=require('./validation').validate(answer,{trace:dispatch.trace,quote:state.quote,records:book.rows,invoice:payment});if(rejected)throw new Error(rejected);
       if(answer.length>(config.maxResponseLength||1500))throw new Error('V3_RESPONSE_TOO_LONG');
       if(payment?.accountNumber&&require('./financial').validatePaymentResponse(answer,payment).fallback)throw new Error('PAYMENT_BLOCK_REQUIRED');
       result={accepted:true};
      }
     }else result=await dispatch.execute(call);
    }catch(error){
     if(['V3_OWNERSHIP_CHANGED','V3_CONFIGURATION_CHANGED','TOOL_RECOVERY_EXHAUSTED'].includes(error.message))throw error;
     answer='';outputProof=null;if(++repairs>1)throw error;
     result={ok:false,error:error.message,recoverable:true,attemptsRemaining:1,instruction:'Correct the contract using approved sources, not a fabricated explanation. Use provenance values; no raw numeric claims. Do not repeat qualification for known information.'};
    }
    input.push({type:'function_call_output',call_id:call.call_id,output:JSON.stringify(result)});
   }
   if(answer)break;
   const payment=dispatch.invoice||dispatch.trace.findLast(t=>['get_invoice_status','check_payment_status'].includes(t.tool))?.result||trustedInvoice;
   if(plan)input.push({role:'developer',content:JSON.stringify({provenance:provenance.ledger(dispatch.trace,state.quote,payment),purchase:state.purchase||[],quote:state.quote||null,requiredAction:turn.pending(plan,dispatch,state)})});
  }
  if(!answer)throw new Error('V3_NO_FINAL_RESPONSE');
  await ports.assertCurrent();usage.estimated_cost_usd=require('./cost').estimate(api.model,usage);
  return {...base,action:dispatch.handoff?'handoff':'reply',handoff:dispatch.handoff?.reason,response:answer,summary:dispatch.handoff?.summary,wouldGenerateInvoice:Boolean(dispatch.invoice?.wouldCreateInvoice),debug:{...base.debug,plan,provenance:outputProof.provenance,coverage:outputProof.coverage,tools:dispatch.trace,latency:Date.now()-started,openaiConversationId:state.openaiConversationId}};
 }catch(error){turnError=error;error.usage=usage;error.model=api.model;error.debug={...base.debug,plan,tools:dispatch?.trace||[],openaiConversationId:state.openaiConversationId};throw error;}
 finally{if(cleanup)try{await cleanup();}catch(error){if(!turnError){error.usage=usage;error.model=api.model;error.debug={...base.debug,tools:dispatch?.trace||[]};throw error;}}}
}
module.exports={decide};
