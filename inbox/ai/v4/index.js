const schemas=require('./schema'),{redact,sensitive}=require('../privacy');
async function decide({config,records,messages,history=[],state={},ports,api,simulation=true,reserveModelCall}){
 if(!simulation&&(process.env.AI_V4_LIVE_APPROVED!=='1'||config.mode!=='LIVE'||!config.autoReply))throw new Error('V4_LIVE_NOT_APPROVED');
 await ports.assertCurrent();if(state.ownership==='HUMAN')throw new Error('V4_HUMAN_OWNS_CONVERSATION');
 const current=messages.map(m=>({...m,_id:String(m._id),text:redact(m.text||'')}));
 if(current.length>200||JSON.stringify(current).length>40000)throw new Error('V4_INPUT_TOO_LARGE');
 if(messages.some(m=>m.type&&m.type!=='text'||sensitive(m.text))){await ports.assertCurrent();const reason=messages.some(m=>sensitive(m.text))?'SENSITIVE_CASE':'MEDIA_RECEIVED';const handoff=simulation?{accepted:true,simulation:true}:await ports.handoff({reason,summary:'Unsupported or sensitive inbound content.'});await ports.persist({...state,ownership:handoff.accepted?'HUMAN':'AI'});return {engineVersion:'v4',action:'handoff',handoff:reason,response:config.fallbackResponse,debug:{engineVersion:'v4',simulation,handoff}};}
 api||=require('./model').client({config,reserve:reserveModelCall});
 const actual=require('../questionContinuity').history(history,config.v4HistoryMessages||40);
 if(JSON.stringify(actual).length>60000)throw new Error('V4_HISTORY_TOO_LARGE');
 const trusted={purchaseItems:state.purchaseItems||[],currentQuote:state.currentQuote||null,activeInvoice:await ports.invoiceStatus(false),readiness:state.readiness||'UNKNOWN',ownership:'AI',unresolvedRequests:state.unresolvedRequests||[]};
 const passes=[],debug={engineVersion:'v4',simulation,passes};
 try{
  const interpreted=await api.pass('interpreter',{history:actual,trusted,current:current.map(m=>({id:m._id,text:m.text}))});passes.push(interpreted.metrics);debug.interpreter=interpreted.value;
  const resolved=await require('./resolver').resolve({plan:interpreted.value,state,messages:current,records,ports,simulation,config});
  resolved.pack.conversation={history:actual,current:current.map(m=>({id:m._id,text:m.text}))};
  require('../questionContinuity').applyV4(resolved.pack);
  Object.assign(debug,{stateChanges:resolved.next,operations:resolved.operations,answerPack:resolved.pack,composition:[]});
  await ports.assertCurrent();await ports.persist(resolved.next);
  const knowledgeFallback=()=>({engineVersion:'v4',action:'handoff',handoff:'NO_APPROVED_KNOWLEDGE',response:config.fallbackResponse||'Hold on, please. You will receive a response shortly.',model:`${config.v4InterpreterModel} / ${config.v4ComposerModel}`,usage:aggregate(passes),debug});
  if(resolved.pack.actions.handoff?.reason==='NO_APPROVED_KNOWLEDGE')return knowledgeFallback();
  let final,errors;
  for(let attempt=0;attempt<2;attempt++){
   await ports.assertCurrent();const composed=await api.pass('composer',resolved.pack,attempt?{errors,previous:final}:null);passes.push(composed.metrics);final=composed.value;
   if(schemas.valid(schemas.composer,final)&&final.unsupported_request_ids.length){
    const requests=resolved.pack.requests.filter(r=>final.unsupported_request_ids.includes(r.id));
    if(requests.length!==new Set(final.unsupported_request_ids).size)throw new Error('V4_INVALID_UNSUPPORTED_REQUEST');
    debug.composition.push({output:final,errors:['NO_APPROVED_KNOWLEDGE'],discarded:true});
    await require('./knowledgeHandoff').handoff({requests,next:resolved.next,pack:resolved.pack,ports,simulation,operations:resolved.operations});
    await ports.assertCurrent();await ports.persist(resolved.next);return knowledgeFallback();
   }
   errors=schemas.valid(schemas.composer,final)?require('./validation').validate(final,resolved.pack,config.maxResponseLength||1500):['INVALID_COMPOSER_SCHEMA'];
   debug.composition.push({output:final,errors});if(!errors.length)break;
  }
  if(errors.length)throw new Error(`V4_COMPOSITION_REJECTED:${errors.join(',')}`);
  await ports.assertCurrent();
  const action=resolved.pack.actions.handoff?.accepted||resolved.pack.actions.handoff?.pending?'handoff':'reply';
  return {engineVersion:'v4',action,handoff:action==='handoff'?resolved.pack.actions.handoff.reason:null,response:final.message,model:`${config.v4InterpreterModel} / ${config.v4ComposerModel}`,usage:aggregate(passes),wouldGenerateInvoice:!!resolved.pack.actions.invoice?.wouldCreateInvoice,debug};
 }catch(e){if(e.metrics)passes.push(e.metrics);e.usage=aggregate(passes);e.debug=debug;throw e;}
}
function aggregate(passes){return passes.reduce((a,p)=>{for(const k of ['input_tokens','output_tokens','total_tokens','cached_input_tokens'])a[k]=(a[k]||0)+(p?.[k]||0);a.calls++;a.estimated_cost_usd=p?.estimated_cost_usd==null||a.estimated_cost_usd===null?null:a.estimated_cost_usd+p.estimated_cost_usd;return a;},{calls:0,estimated_cost_usd:0});}
module.exports={decide,aggregate};
