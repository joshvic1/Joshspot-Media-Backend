const provider = require('./provider');
const { sensitive } = require('./privacy');
const money = value => `₦${Number(value).toLocaleString('en-NG')}`;
const paymentIntents = ['ready_to_pay','request_invoice','request_account_number','payment_question','payment_sent','receipt_sent','payment_problem'];
const varsIn = text => [...String(text).matchAll(/\{\{([a-z_]+)\}\}/g)].map(m=>m[1]);
function render(text, variables) {
  return String(text || '').replace(/\{\{([a-z_]+)\}\}/g,(_,key)=> { if(variables[key]===undefined || variables[key]===null) throw new Error(`Missing approved response variable: ${key}`); return String(variables[key]); });
}
function reply(record,variables,decision,config) {
  let text = record?.data?.message || '';
  // Model wording can never supply financial facts. All amounts and payment details
  // come from deterministic render variables; strict templates remain byte-for-byte.
  if(record?.data.mode !== 'STRICT' && decision?.responseKey === record?.key && decision.phrasing) {
    const proposed = decision.phrasing;
    const safe = !/[\d₦$€£]|https?:|\b(?:free|discount|refund|guarantee|bank|account number|naira|dollars|thousand|hundred|million|percent)\b/i.test(proposed.replace(/\{\{[a-z_]+\}\}/g,''));
    if(safe && JSON.stringify(varsIn(proposed).sort())===JSON.stringify(varsIn(text).sort()) && proposed.length<=config.maxResponseLength) text=proposed;
  }
  if(!text) return null;
  const result = render(text,variables);
  return `${result}${config.signature ? `\n${config.signature}`:''}`.slice(0,config.maxResponseLength);
}
async function decide({text,type='text',state={},config,records,knowledge=[],history=[]}) {
  const next = {...state};
  const handoff = (reason,extra={})=>({action:'handoff',handoff:reason,state:next,response:config.fallbackResponse,intent:'unknown',confidence:1,priority:false,...extra});
  if(type!=='text') {
    if(type==='sticker' && config.stickerAction==='ignore' || type==='contact' && config.contactAction==='ignore') return {action:'ignore',state:next};
    return handoff('MEDIA_RECEIVED',{priority:Boolean(next.invoiceId)});
  }
  if(sensitive(text)) return handoff('SENSITIVE_CASE');
  if(config.businessHoursEnabled && config.outsideHours==='handoff') {
    const hour=Number(new Intl.DateTimeFormat('en',{hour:'numeric',hourCycle:'h23',timeZone:config.timezone}).format(new Date()));
    const inside=config.startHour<config.endHour ? hour>=config.startHour && hour<config.endHour : hour>=config.startHour || hour<config.endHour;
    if(!inside) return handoff('OUTSIDE_BUSINESS_HOURS');
  }
  const decision = await provider.interpret({text,state,config,records,knowledge,history});
  const meta={intent:decision.intent,confidence:decision.confidence,model:decision.model,usage:decision.usage,knowledge:[],priority:paymentIntents.includes(decision.intent)};
  if(decision.intent==='human') return handoff('CUSTOMER_REQUESTED_HUMAN',meta);
  if(['payment_sent','receipt_sent','payment_problem'].includes(decision.intent)) return handoff('PAYMENT_VERIFICATION_REQUIRED',meta);
  if(!config.allowedIntents.includes(decision.intent) || config.disallowedIntents.includes(decision.intent)) return handoff('UNSUPPORTED_REQUEST',meta);
  if(decision.confidence<config.confidence) return handoff('LOW_CONFIDENCE',meta);
  if(decision.intent==='unknown') return handoff('NO_KNOWLEDGE',meta);
  for(const [from,to] of [['platform','selectedPlatform'],['serviceType','serviceType'],['budget','budget'],['duration','duration']]) if(decision[from]!==null && decision[from]!==undefined) next[to]=decision[from];
  if(next.selectedPlatform!==state.selectedPlatform || next.serviceType!==state.serviceType) { delete next.recommendedPlan; delete next.selectedService; }
  next.currentIntent=decision.intent;
  const customRule=records.find(r=>r.kind==='handoff' && [decision.intent,'*'].includes(r.data.intent));
  if(customRule) return handoff(customRule.data.reason || 'ADMIN_RULE',{...meta,handoffRule:customRule.key,response:customRule.data.customerResponse || config.fallbackResponse});
  const service=records.find(r=>r.kind==='service' && r.data.serviceType===next.serviceType && r.data.platforms.includes(next.selectedPlatform));
  if(service) next.selectedService=service.key;
  const plans=records.filter(r=>r.kind==='plan' && r.data.platforms.includes(next.selectedPlatform) && (!service || r.data.service===service.key));
  const selectedPlan=plans.find(p=>p.key===decision.planKey) || plans.find(p=>p.data.duration===next.duration && (!next.budget || p.data.amount===next.budget));
  if(selectedPlan){ next.recommendedPlan=selectedPlan.key; next.duration=selectedPlan.data.duration; next.budget=selectedPlan.data.amount; }
  let amount=service?.data.serviceType==='account_setup'?service.data.price:selectedPlan?.data.amount;
  if(!amount && service?.data.allowCustomBudget && next.budget>=service.data.minBudget && next.budget<=service.data.maxBudget && next.duration>0) amount=next.budget;
  const variables={customer_name:'there',agent_name:config.displayName,service:service?.title || '',platform:next.selectedPlatform==='meta'?'Meta (Facebook & Instagram)':next.selectedPlatform==='tiktok'?'TikTok':'',amount:amount?money(amount):'',duration:next.duration || '',requirements:service?.data.requirements || '',plans:plans.map(p=>`${p.data.duration} days — ${money(p.data.amount)}`).join('\n')};
  const respond = (key,step=key)=>{const record=records.find(r=>r.kind==='response'&&r.key===key);const response=reply(record,variables,decision,config);return response?{...meta,action:'reply',state:{...next,currentStep:step,awaitingCustomerResponse:true},response,responseKey:key,amount,serviceKey:service?.key}:handoff('MISSING_RESPONSE',meta);};
  if(decision.intent==='greeting' && !next.selectedService && config.greeting) return respond('greeting');
  if(decision.intent==='knowledge') {
    const entry=knowledge.find(k=>k.key===decision.knowledgeKey);
    if(!entry) return handoff('NO_KNOWLEDGE',meta);
    if(/[₦$€£]\s*\d|\d[\d,]*\s*(?:naira|NGN|dollars)/i.test(entry.data.answer))return handoff('PRICING_KNOWLEDGE_REVIEW',meta);
    if(varsIn(entry.data.answer).some(key=>!variables[key]))return handoff('INCOMPLETE_KNOWLEDGE_CONTEXT',meta);
    return {...meta,action:'reply',response:render(entry.data.answer,variables).slice(0,config.maxResponseLength),state:next,knowledge:[entry.key]};
  }
  if(decision.intent==='requirements' && service) return respond('requirements');
  if(decision.intent==='recommendation' && next.selectedPlatform && plans.length) return respond('plans','select_plan');
  // Configured stages are deliberately limited to safe state and response actions.
  for(const rule of records.filter(r=>r.kind==='workflow')) {
    const d=rule.data;
    const salesIntent=['advertising','recommendation','requirements',...paymentIntents].includes(decision.intent);
    if(!(d.intent===decision.intent || d.intent==='*' || d.intent==='advertising'&&salesIntent) || d.serviceType && d.serviceType!==next.serviceType) continue;
    const matches=d.operator==='missing'?!next[d.field]:d.operator==='present'?Boolean(next[d.field]):String(next[d.field])===d.value;
    if(!matches) continue;
    if(d.stateField) next[d.stateField]=d.stateValue;
    if(d.action==='handoff') return handoff('ADMIN_RULE',meta);
    const output=respond(d.response,d.nextStep);
    if(d.options?.length && output.response)output.response+=`\n${d.options.join(' · ')}`;
    return {...output,workflow:rule.key};
  }
  if(['ready_to_pay','request_invoice','request_account_number'].includes(decision.intent)) {
    if(!amount || !service?.data.paymentEnabled || !config.invoicesEnabled) return handoff('PAYMENT_REVIEW_REQUIRED',meta);
    return {...meta,action:'invoice',state:{...next,currentStep:'payment'},amount,serviceKey:service.key,response:''};
  }
  if(amount && service) return respond('quote','quote_presented');
  return handoff(service ? 'CUSTOM_PLAN_REVIEW' : 'NO_KNOWLEDGE',meta);
}
module.exports={decide,render,money,paymentIntents};
