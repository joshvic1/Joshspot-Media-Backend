const {valueOf,effectiveValue,evidenced}=require('./state'),consent=require('./consent'),authority=require('./authority'),budget=require('./budget'),pricing=require('../pricing');
const money=n=>new Intl.NumberFormat('en-NG',{style:'currency',currency:'NGN',maximumFractionDigits:2,minimumFractionDigits:0}).format(n);
const questions={
 DISCOVER:['Which of our services are you interested in?',['services']],
 SERVICE:['Do you want us to set up your ads account for you, then teach you how to access it and run the ads yourself?\n\nOr\n\nDo you want us to run the ads straight up for you?',['services']],
 PLATFORM:['Which platform do you want: TikTok or Meta (Facebook & Instagram)?',['platforms']],
 BUDGET_DURATION:['What is your daily advertising budget, and how many days would you like to run the ads for?',['budget','duration']],
 BUDGET:['What is your daily advertising budget?',['budget']],DURATION:['How many days would you like to run the ads for?',['duration']],
 BASIS:['Is that daily ad spend, total ad spend, or your total including our fee?',['budgetBasis']],
 PROCEED:['Would you like to proceed?',['proceed']],PAYMENT:['Should I send the account details now?',['paymentRequested']],
 BUDGET_ALLOCATION:['Is that amount for each platform, or a combined total for both?',['budget']],
 RELATIONSHIPS:['Which service would you like for each platform?',[]],
 SETUP_CONSENT:['Would you also like us to set up the account, or will you arrange it yourself?',['services','setupNeeded']],
 CLARIFY_REFERENCE:['Could you clarify which option you mean?',[]],
 SELECT_PLAN:['Which plan would you like to go with?',['plan']],
 CAP:['Would you like to change the total budget or the selected services?',[]],
};
const templates={SERVICE:'ads_service_clarification',PLATFORM:'ads_platform_selection',BUDGET_DURATION:'ads_management_details',BUDGET:'ads_budget',DURATION:'ads_duration',PROCEED:'confirm_proceed',PAYMENT:'ready_to_proceed',DISCOVER:'generic_first_contact'};
function question(key,records,itemId=''){
 const [text,fields]=questions[key];const source=records.find(r=>r.kind==='knowledge'&&r.enabled!==false&&!r.archived&&r.key===(templates[key]||`v2_${key.toLowerCase()}`));
 const configured=source?.data.preferredResponse;
 const choices=key==='SERVICE'?[{label:'Account setup and guidance',value:'account_setup'},{label:'Campaign management',value:'ads_management'}]:key==='PLATFORM'?[{label:'TikTok',value:'tiktok'},{label:'Meta (Facebook & Instagram)',value:'meta'}]:[];
 return {text:configured&&!configured.includes('{{')?configured:text,defaultText:text,source:configured?source.key:null,purpose:key,fields,choices,itemId};
}
async function plan({core,state,interpretation:i,context,records,knowledge,unsupportedQuestions=[],config,paymentVerified,invoiceRecord,type,ledger=[]}){
 const p={action:'reply',facts:{},provenance:{},requiredFacts:[],question:null,reason:'ANSWER',quotes:[],amount:null,ledger,warnings:[]};
 const fact=(id,text,claim,source,required=true)=>{authority.fact(p,id,text,claim,source);if(required&&!p.requiredFacts.includes(id))p.requiredFacts.push(id);};
 const policy=(id,required=true)=>{const w=authority.policy(id,records);fact(id,w.text,'POLICY',w.source?{kind:'knowledge',key:w.source.key,unverified:true}:{kind:'builtin',key:id},required);};
 const ask=(key,itemId='')=>{p.question=question(key,records,itemId);p.reason=key;};
 const transfer=reason=>{p.action='handoff';p.handoffReason=reason;p.reason=reason;};
 // Policies change action, not coverage: remaining supported needs still compose.
 if(paymentVerified){fact('paid','Payment confirmed. Thank you.','PAYMENT_STATUS',{kind:'verified_invoice',status:'paid'});transfer('PAYMENT_VERIFIED');}
 if(type!=='text')transfer('MEDIA_RECEIVED');
 for(const [key,reason]of [['humanRequest','CUSTOMER_REQUESTED_HUMAN'],['sensitiveCase','SENSITIVE_CASE'],['paymentClaim','PAYMENT_VERIFICATION_REQUIRED']])if(i[key]?.value&&evidenced(i[key].evidence,context))transfer(reason);
 if(i.intents.some(x=>config.disallowedIntents?.includes(x)||config.allowedIntents&&!config.allowedIntents.includes(x)))transfer('UNSUPPORTED_REQUEST');
 const mandatory=records.find(r=>r.kind==='handoff'&&r.data.mandatory&&(r.data.intent==='*'||i.intents.includes(r.data.intent))),kb=knowledge.find(r=>r.data.forceHandoff);
 if(mandatory||kb){p.handoffRule=mandatory?.key;transfer(mandatory?.data.reason||kb.data.handoffReason||'MANUAL_ADMIN_RULE');}
 if(config.businessHoursEnabled&&config.outsideHours==='handoff'){const h=Number(new Intl.DateTimeFormat('en',{hour:'numeric',hourCycle:'h23',timeZone:config.timezone}).format(new Date(context.now)));if(!(config.startHour<config.endHour?h>=config.startHour&&h<config.endHour:h>=config.startHour||h<config.endHour))transfer('OUTSIDE_BUSINESS_HOURS');}
 if(unsupportedQuestions.length)transfer('NO_APPROVED_KNOWLEDGE');
 if(i.negotiation?.value&&evidenced(i.negotiation.evidence,context)||(i.budgets||[]).some(b=>b.kind==='COUNTEROFFER'&&evidenced(b.evidence,context)))policy('negotiation');
 const decision=consent.effective(core),needs=ledger.map(n=>n.type),recommending=i.recommendations.length>0||needs.some(n=>['ask_recommendation','ask_budget_advice'].includes(n));
 if(decision.blocked&&!i.questions.length&&!recommending)policy('deferred');
 const course=records.find(r=>r.kind==='service'&&r.data.serviceType==='course');
 if(course)fact('course',`${course.title}\n\n${money(course.data.price)}\n${course.data.checkoutUrl||''}`,'PRICE',{kind:'service',key:course.key,amount:course.data.price,checkoutUrl:course.data.checkoutUrl},core.topic==='course'||needs.includes('ask_course_question'));
 const setupRecords=records.filter(r=>r.kind==='service'&&r.data.serviceType==='account_setup');
 fact('setup_prices',setupRecords.map(r=>`${r.title}: ${money(r.data.price)}`).join('\n'),'PRICE',{kind:'services',keys:setupRecords.map(r=>r.key)},false);
 const services=valueOf(core,'services')||[],platforms=valueOf(core,'platforms')||[];
 const plans=records.filter(r=>r.kind==='plan'&&(!platforms.length||platforms.every(x=>r.data.platforms.includes(x))));
 if(recommending){const rows=[];for(const r of plans){try{const b=await pricing.calculate({platform:platforms[0]||'tiktok',budget:r.data.amount,duration:r.data.duration,planAmount:r.data.amount});rows.push(`${b.duration} days — ${money(b.total)} (${money(b.advertisingBudget)} ads + ${money(b.managementFee)} management; ${money(b.dailyBudget)} daily)`);}catch(e){p.warnings.push({key:r.key,reason:e.message});rows.push(`${r.data.duration} days — ${money(r.data.amount)}. Breakdown needs confirmation.`);}}if(rows.length)fact('plans',rows.join('\n\n'),'PRICE',{kind:'plans',keys:plans.map(r=>r.key)});}
 const activeItems=core.items.filter(x=>x.type!=='course');
 if(core.relationshipsUnresolved)ask('RELATIONSHIPS');
 else if(!services.length&&!activeItems.length)ask(i.intents.includes('greeting')?'DISCOVER':'SERVICE');
 else if(!platforms.length&&!activeItems.length&&!services.includes('course'))ask('PLATFORM');
 else {
  const setupTotal=activeItems.filter(x=>x.type==='account_setup').reduce((sum,x)=>sum+(setupRecords.find(r=>r.data.platforms.includes(x.platform))?.data.price||0),0);
  const managementItems=activeItems.filter(x=>x.type==='ads_management');
  for(const item of activeItems){
   const svc=records.find(r=>r.kind==='service'&&r.data.serviceType===item.type&&r.data.platforms.includes(item.platform));
   if(!svc){transfer('SERVICE_UNAVAILABLE');continue;}
   // Requirements are untrusted business prose, passed through selected knowledge,
   // never smuggled into a trusted financial fact segment.
   if(item.type==='account_setup'){p.quotes.push({itemId:item.id,serviceKey:svc.key,total:svc.data.price,text:`${svc.title}: ${money(svc.data.price)}`,paymentEnabled:svc.data.paymentEnabled,dependencies:{serviceKey:svc.key,price:svc.data.price}});continue;}
   const b=budget.meaning(core,item),duration=effectiveValue(core,'duration',item.id),planKey=effectiveValue(core,'plan',item.id);
   const packages=plans.filter(r=>r.data.platforms.includes(item.platform)&&r.data.amount===b?.amount&&(!duration||r.data.duration===duration));
   const selected=plans.find(r=>r.key===planKey)||(b?.kind==='PACKAGE_SELECTION'&&packages.length===1?packages[0]:null)||(!b&&duration?plans.find(r=>r.data.duration===duration):null);
   if(b?.kind==='PACKAGE_SELECTION'&&!selected){ask('SELECT_PLAN',item.id);continue;}
   if(managementItems.length>1&&b&&!item.budget&&!valueOf(core,'budget',item.id)){ask('BUDGET_ALLOCATION',item.id);continue;}
   if(b?.kind==='COUNTEROFFER'){policy('negotiation');continue;}
   if(b&&!['DAILY_AD_SPEND','TOTAL_AD_SPEND','ALL_IN_CAP'].includes(b.kind)&&!selected){ask('BASIS',item.id);continue;}
   if(!(selected||b&&duration)){if(!p.question)ask(!b&&!duration?'BUDGET_DURATION':b?'DURATION':'BUDGET',item.id);continue;}
   try{
    const available=b?.kind==='ALL_IN_CAP'?b.amount-(b.itemId?0:setupTotal):null;
    const quote=selected?await pricing.calculate({platform:item.platform,budget:selected.data.amount,duration:selected.data.duration,planAmount:selected.data.amount}):b.kind==='ALL_IN_CAP'?await budget.withinCap(item.platform,duration,available):await pricing.calculate({platform:item.platform,budget:b.amount,duration,budgetBasis:b.kind==='DAILY_AD_SPEND'?'daily':'total'});
    if(!quote){policy('cap');ask('CAP',item.id);continue;}
    p.quotes.push({itemId:item.id,serviceKey:svc.key,total:quote.total,text:`${item.platform==='meta'?'Meta':'TikTok'} ads management, ${quote.duration} days: ${money(quote.advertisingBudget)} advertising + ${money(quote.managementFee)} management = ${money(quote.total)} total (${money(quote.dailyBudget)} daily ad spend)`,breakdown:quote,paymentEnabled:svc.data.paymentEnabled,dependencies:{budget:b,duration,plan:selected?.key,planAmount:selected?.data.amount}});
   }catch(e){p.warnings.push({itemId:item.id,reason:e.message});policy('mismatch');transfer('CATALOGUE_PRICING_CONFLICT');}
  }
 }
 const aggregate=p.quotes.reduce((sum,q)=>sum+q.total,0);
 if(core.purchaseBudget?.kind==='ALL_IN_CAP'&&aggregate>core.purchaseBudget.amount){policy('cap');ask('CAP');}
 const complete=activeItems.length>0&&p.quotes.length===activeItems.length&&!p.question;
 if(p.quotes.length){p.amount=complete?p.quotes.reduce((s,q)=>s+q.total,0):null;fact('quote',p.quotes.map(q=>q.text).join('\n\n')+(complete&&p.quotes.length>1?`\n\nCombined total: ${money(p.amount)}`:''),'PRICE',{kind:'calculator_and_services',items:p.quotes},!decision.blocked&&(!i.questions.length||needs.includes('ask_price')));}
 if(complete){
  if(state.invoiceId&&invoiceRecord?.status==='pending'&&!core.selectionChanged){p.reason='PAYMENT_PENDING';p.amount=invoiceRecord.amount;fact('quote',`Your existing invoice total is ${money(invoiceRecord.amount)}.`,'PRICE',{kind:'invoice',id:state.invoiceId,amount:invoiceRecord.amount},false);}
  else if(valueOf(core,'setupNeeded')==='yes'&&!services.includes('account_setup'))ask('SETUP_CONSENT');
  else if(decision.ready&&decision.payment&&!decision.blocked&&core.purchasePath==='advertising'&&p.action!=='handoff'){if(config.invoicesEnabled&&p.quotes.every(q=>q.paymentEnabled)){p.action='invoice';p.reason='SEND_INVOICE';}else transfer('PAYMENT_NOT_AUTHORIZED');}
  else if(!decision.blocked)ask(decision.ready?'PAYMENT':'PROCEED');
 }
 if(recommending&&p.facts.plans&&!decision.blocked){ask('SELECT_PLAN');p.question.choices=plans.map(r=>({label:r.title,value:r.key}));}
 if(i.unresolvedReferences.length)ask('CLARIFY_REFERENCE');
 if(p.action==='handoff'){p.reason=p.handoffReason;p.question=null;policy('handoff');}
 if(decision.blocked||core.topic==='course'||core.topic==='support'||core.purchasePath==='course')p.question=null;
 if(p.question&&context.pendingQuestion?.purpose===p.question.purpose&&context.pendingQuestion?.itemId===p.question.itemId&&i.questions.length)p.question=null;
 const sameEvidence=e=>e&&context.messages.some(m=>m.id===e.messageId)&&evidenced(e,context);
 for(const need of ledger){
  const matches=e=>sameEvidence(e)&&e.messageId===need.evidence.messageId&&(e.text.includes(need.evidence.text)||need.evidence.text.includes(e.text));
  const decisionHandled=core.decisions.some(e=>matches(e.evidence)&&(need.type==='defer_purchase'?['DEFERRED','DECLINED'].includes(e.type):need.type==='resume_purchase'?['RESUMED','READY_TO_PROCEED','PAYMENT_REQUESTED'].includes(e.type):false));
  const selectionHandled=['select_service','select_platform'].includes(need.type)&&core.items.some(x=>matches(x.evidence));
  const answerHandled=need.type==='answer_previous_question'&&core.answeredQuestions.some(a=>a.id===need.questionId&&matches(a.evidence));
  const correctionHandled=need.type==='correct_previous_fact'&&Object.values(core.facts).some(f=>f.status==='CONFIRMED'&&matches(f.evidence));
  if(decisionHandled||selectionHandled||answerHandled||correctionHandled)need.disposition='ACTIONED';
  else if(need.type==='request_invoice'&&p.action==='invoice'){need.disposition='DEFERRED_WITH_REASON';need.reason='Trusted invoice executor required';}
  else if(need.type==='request_human'&&p.action==='handoff')need.disposition='HANDOFF_REQUIRED';
 }
 return p;
}
module.exports={plan,question};
