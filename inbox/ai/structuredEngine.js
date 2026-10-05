const provider=require('./provider');

const knowledgePolicy=require('./structuredKnowledge');

const {sensitive}=require('./privacy');
const qualification=require('./qualification');

const {render,money}=require('./engine');



async function decide({text='',type='text',customerName='there',state={},config,records=[],knowledge=[],history=[],paymentVerified=false,invoiceRecord=null,reserveModelCall=async()=>{},now=Date.now()}) {

  const next={...state,aiActive:true}, time=new Date(now).toISOString();

  const entries=[...new Map([...records.filter(r=>r.kind==='knowledge'),...knowledge].map(e=>[e.key,e])).values()].filter(e=>knowledgePolicy.eligible(e,next)).sort((a,b)=>(b.priority||0)-(a.priority||0)||Object.keys(b.data.requiredState||{}).length-Object.keys(a.data.requiredState||{}).length||new Date(b.updatedAt||0)-new Date(a.updatedAt||0)||a.key.localeCompare(b.key));

  const entryFor=key=>entries.find(e=>e.key===key&&knowledgePolicy.eligible(e,next));

  const base={state:next,knowledge:[],debug:{engineVersion:2,stateBefore:state,retrieval:entries.map(e=>({key:e.key,reason:e.match?.reason||'state/flow candidate'}))}};

  const handoff=(reason,key='media_handoff')=>{

    let response=entryFor(key)?.data.preferredResponse||config.fallbackResponse,error;

    try{response=render(response,{customer_name:customerName||'there'});if(/\{\{/.test(response))throw Error('Missing variable');}

    catch{response='Hold on, you will get a response shortly.';error='Review the handoff response: a required variable is unavailable.';}

    return {...base,action:'handoff',handoff:reason,handoffTeam:'CSS',response,error,state:{...next,humanHandoffReason:reason,aiActive:false,handoffAt:time,nextObjective:'HANDOFF'}};

  };

  if(paymentVerified){next.paymentStatus='paid';next.invoiceStatus='paid';next.currentSalesStage='PAID';return handoff('PAYMENT_VERIFIED','payment_verified');}

  if(type!=='text')return handoff('MEDIA_RECEIVED');

  if(sensitive(text))return handoff('SENSITIVE_CASE');

  if(config.businessHoursEnabled&&config.outsideHours==='handoff'){

    const hour=Number(new Intl.DateTimeFormat('en-GB',{hour:'numeric',hourCycle:'h23',timeZone:config.timezone}).format(new Date(now)));

    if(!(config.startHour<config.endHour?hour>=config.startHour&&hour<config.endHour:hour>=config.startHour||hour<config.endHour))return handoff('OUTSIDE_BUSINESS_HOURS');

  }

  // Only a generic, standalone greeting is deterministic. Intent-bearing greetings

  // always reach semantic interpretation so their useful details are retained.

  const greeting=/^(?:hi|hey|hello(?: josh)?|good (?:morning|afternoon|evening))[\s!.👋]*$/iu.test(text.trim())&&!next.serviceType&&!next.selectedPlatform;

  if(!greeting)await reserveModelCall();

  const d=greeting?{intent:'greeting',confidence:1,answer:'',answerKind:'none'}:await provider.interpret({text,state:next,history,records,knowledge:entries.filter(e=>!knowledgePolicy.seeds.some(seed=>seed.data.plannerOnly&&seed.key===e.key)),config:{...config,structuredSales:true,masterInstructions:''}});

  Object.assign(base,{intent:d.intent,confidence:d.confidence,model:d.model,usage:d.usage});

  base.debug.extracted={platform:d.platform,serviceType:d.serviceType,budget:d.budget,duration:d.duration};

  if(d.intent==='human')return handoff('CUSTOMER_REQUESTED_HUMAN');

  if(['payment_sent','receipt_sent'].includes(d.intent)){next.paymentStatus='claimed';next.currentSalesStage='PAYMENT_CLAIMED';return handoff('PAYMENT_VERIFICATION_REQUIRED','payment_claim');}

  if(!config.allowedIntents.includes(d.intent)||config.disallowedIntents.includes(d.intent))return handoff('MANUAL_ADMIN_RULE');

  const mandatory=records.find(r=>r.kind==='handoff'&&r.data.mandatory===true&&(r.data.intent===d.intent||r.data.intent==='*'));

  if(mandatory)return {...handoff(mandatory.data.reason||'MANUAL_ADMIN_RULE'),handoffRule:mandatory.key};

  const groundedPlatforms=qualification.platforms(text,state,d);
  const inferredPlatform=Boolean((d.platform||d.platforms?.length)&&!groundedPlatforms.length&&!state.selectedPlatform);
  d.platforms=groundedPlatforms;
  d.platform=groundedPlatforms.length===1?groundedPlatforms[0]:null;
  base.debug.qualification={platformInferenceBlocked:inferredPlatform};
  if(!state.selectedPlatform&&!groundedPlatforms.length && (inferredPlatform||/\b(?:personal account|business account|business page|ads manager)\b/i.test(text)||/\b(?:tiktok|meta|facebook|instagram)\b/i.test(d.answer||''))){
    return {...base,action:'reply',response:entryFor('ads_platform_selection')?.data.preferredResponse||'Which platform are you asking about: TikTok or Meta (Facebook & Instagram)?',state:{...next,nextObjective:'GET_PLATFORM',lastRequiredQuestion:'GET_PLATFORM',currentSalesStage:'PLATFORM_SELECTION',updatedAt:time}};
  }
  const deferred=d.deferPurchase===true || /\b(?:let me (?:speak|talk|discuss|consult|check)|(?:i[’']?ll|i will) (?:get back|hit you up)|not (?:now|yet|ready)|once i agree|make payments? soon)\b/i.test(text) || /^no(?:[\s,.!]|$)/i.test(text.trim()) && ['CONFIRM_PROCEED','OFFER_PAYMENT_DETAILS','CHECK_PAYMENT'].includes(state.lastRequiredQuestion);

  if(deferred){return {...base,action:'reply',response:"All right, take your time. We'll be expecting your response.",state:{...next,salesPaused:true,customerWantsToProceed:false,paymentDetailsRequested:false,nextObjective:'WAIT_FOR_CUSTOMER',lastRequiredQuestion:'',updatedAt:time},debug:{...base.debug,deferredPurchase:true}};}

  const unsureBudget=d.needsRecommendation===true || (['GET_BUDGET','GET_BUDGET_DURATION','GET_DURATION','SELECT_PLAN'].includes(state.lastRequiredQuestion) && /\b(?:don[’']?t know|do not know|not sure|no idea|you (?:suggest|recommend)|what.*(?:budget|recommend))\b/i.test(text));

  if(unsureBudget){next.needsBudgetGuidance=true;d.needsRecommendation=true;}

  const allPlatforms=state.lastRequiredQuestion==='GET_PLATFORM' && /^(?:all(?: of them)?|both(?: of them)?)(?: please)?[.!\s]*$/i.test(text.trim());

  const chosenPlatforms=allPlatforms?['tiktok','meta']:(d.platforms||[]).filter(p=>['tiktok','meta'].includes(p));

  if(chosenPlatforms.length && !(chosenPlatforms.length===1&&state.selectedPlatforms?.length>1&&/\bfirst\b/i.test(text)))next.selectedPlatforms=[...new Set(chosenPlatforms)];

  if(chosenPlatforms.length===1)d.platform=chosenPlatforms[0];

  if(chosenPlatforms.length>1){d.platform=null;delete next.selectedPlatform;}

  const asksDaily=d.asksDailyCost===true || /\b(?:daily.*(?:how much|cost|price)|how much.*(?:daily|per day)|per day.*how much)\b/i.test(text);

  if(asksDaily && (state.lastRequiredQuestion==='SELECT_PLAN'||state.recommendedPlan)) {

    const options=records.filter(r=>r.kind==='plan'&&r.enabled!==false&&!r.archived&&r.data.platforms.includes(state.selectedPlatform)&&(!state.recommendedPlan||r.key===state.recommendedPlan));

    if(options.length){

      try {

        const breakdowns=await Promise.all(options.map(p=>require('./pricing').calculate({platform:state.selectedPlatform,budget:p.data.amount,duration:p.data.duration,planAmount:p.data.amount}).catch(()=>({duration:p.data.duration,total:p.data.amount,unavailable:true}))));

        return {...base,action:'reply',response:breakdowns.map(p=>p.unavailable?`${p.duration} days: ${money(p.total)} total. The daily spend breakdown needs confirmation.`:`${p.duration} days: ${money(p.dailyBudget)} daily ad spend (${money(p.advertisingBudget)} advertising + ${money(p.managementFee)} management = ${money(p.total)} total).`).join('\n\n')+(options.length>1?'\n\nWhich plan would you like?':''),state:{...next,nextObjective:'SELECT_PLAN',lastRequiredQuestion:'SELECT_PLAN'},debug:{...base.debug,planBreakdowns:breakdowns}};

      }catch{return handoff('CALCULATOR_ERROR');}

    }

  }

  const negotiating=Boolean(state.quotedAmount && (d.negotiating===true || /\b(discount|negotiab\w*|reduce (?:it|the price)|last price|let'?s do|can (?:you|we) (?:do|take|accept))\b/i.test(text)));

  if(negotiating){d.budget=null;d.declines=false;}

  const platformOnly=/^(?:tiktok|tik tok|meta|facebook|instagram)[.!\s]*$/i.test(text.trim()) && state.lastRequiredQuestion==='GET_PLATFORM';

  const selectedKeys=d.knowledgeKeys||[d.knowledgeKey].filter(Boolean);

  const matched=entries.filter(e=>selectedKeys.includes(e.key));

  for(const e of [...matched].reverse())for(const [key,value]of Object.entries(e.data.stateUpdates||{}))if(['currentIntent'].includes(key)&&!d[{selectedPlatform:'platform',serviceType:'serviceType',currentIntent:'intent'}[key]])next[key]=value;

  const yes=/^(?:yes|yes please|okay|ok|sure|please do|go ahead)[.!\s]*$/i.test(text.trim());

  const explicitService=qualification.serviceChoice(text,state);
  if(explicitService){next.serviceChoiceConfirmed=true;d.serviceType=explicitService;}
  else if(!state.serviceChoiceConfirmed){next.serviceChoiceConfirmed=false;delete next.serviceType;delete next.needsBudgetGuidance;d.serviceType=null;}
  else if(state.serviceType && d.serviceType!==state.serviceType)d.serviceType=state.serviceType;
  base.debug.qualification.serviceChoice=explicitService;
  // A duration or inferred package price is not a customer-stated ad budget.

  const statedAmounts=[...text.matchAll(/(?:₦|NGN\s*)?(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|m|million)?(?![a-z])/gi)].filter(m=>!/^\s*(?:days?|weeks?|months?)\b/i.test(text.slice(m.index+m[0].length))).map(m=>Number(m[1].replace(/,/g,''))*(/^(k|thousand)$/i.test(m[2]||'')?1000:/^(m|million)$/i.test(m[2]||'')?1000000:1));

  if(d.budget!=null&&!statedAmounts.includes(d.budget))d.budget=null;

  if(d.budget!=null)next.budgetBasis=d.budgetBasis==='total'||/\b(?:total|overall|entire)\s*(?:ad(?:vertising)?\s*)?budget\b/i.test(text)?'total':d.budgetBasis==='daily'?'daily':next.budgetBasis||'daily';

  if(d.budget!=null){next.budgetSource='customer';next.needsBudgetGuidance=false;}

  const oldSelection=[next.selectedPlatform,next.serviceType,next.budget,next.duration,next.recommendedPlan].join(':');

  for(const [source,target]of [['platform','selectedPlatform'],['serviceType','serviceType'],['budget','budget'],['duration','duration']])if(!yes&&d[source]!==null&&d[source]!==undefined)next[target]=d[source];

  if(!yes&&(d.platform&&d.platform!==state.selectedPlatform||d.serviceType&&d.serviceType!==state.serviceType||d.budget!=null&&d.budget!==state.budget||d.duration!=null&&d.duration!==state.duration))delete next.recommendedPlan;

  // A stored package amount must never become custom ad spend when duration changes.

  if(next.budgetBasis==='package'&&!next.recommendedPlan){delete next.budget;delete next.budgetBasis;}

  const services=records.filter(r=>r.kind==='service'&&r.enabled!==false&&!r.archived);

  if(next.selectedPlatforms?.length>1 && !next.selectedPlatform && next.serviceType){

    const labels={tiktok:'TikTok',meta:'Meta (Facebook & Instagram)'};

    const quotes=next.selectedPlatforms.map(platform=>{

      const svc=services.find(r=>r.data.serviceType===next.serviceType&&r.data.platforms.includes(platform));

      if(!svc)return `${labels[platform]}: pricing needs confirmation.`;

      if(next.serviceType==='account_setup')return `${labels[platform]} account setup: ${money(svc.data.price)}.`;

      const options=records.filter(r=>r.kind==='plan'&&r.enabled!==false&&!r.archived&&r.data.service===svc.key&&r.data.platforms.includes(platform)&&(!next.duration||r.data.duration===next.duration));

      return `${labels[platform]} management:\n`+(options.length?options.map(p=>`${p.data.duration} days — ${money(p.data.amount)} total, including management.`).join('\n'):'A custom quote needs your daily ad budget and duration.');

    });

    return {...base,action:'reply',response:`Both platforms — understood.\n\n${quotes.join('\n\n')}\n\nThese are separate platform prices. Which campaign should we arrange first?`,state:{...next,nextObjective:'SELECT_PLATFORM_ORDER',lastRequiredQuestion:'SELECT_PLATFORM_ORDER',updatedAt:time},debug:{...base.debug,platforms:next.selectedPlatforms}};

  }

  const service=services.find(r=>r.data.serviceType===next.serviceType&&r.data.platforms.includes(next.selectedPlatform));

  next.selectedService=service?.key;next.currentIntent=d.intent;

  const plans=records.filter(r=>r.kind==='plan'&&r.enabled!==false&&!r.archived&&r.data.platforms.includes(next.selectedPlatform)&&r.data.service===service?.key);

  const acceptsPlan=state.lastRequiredQuestion==='SELECT_PLAN'||(!next.budget&&d.budget==null);

  const selected=plans.find(p=>p.key===(!yes&&acceptsPlan?d.planKey||next.recommendedPlan:next.recommendedPlan)) || ((state.lastRequiredQuestion==='SELECT_PLAN'||!next.budget) && (d.budget==null || plans.some(p=>p.data.duration===d.duration&&p.data.amount===d.budget)) && plans.filter(p=>p.data.duration===d.duration).length===1 ? plans.find(p=>p.data.duration===d.duration) : null);

  if(selected){next.budgetSource='plan';next.needsBudgetGuidance=false;next.budgetBasis='package';next.recommendedPlan=selected.key;next.duration=selected.data.duration;next.budget=selected.data.amount;}

  if(oldSelection!==[next.selectedPlatform,next.serviceType,next.budget,next.duration,next.recommendedPlan].join(':')) {

    // Preserve the actual invoice in the financial system; unlink stale sales

    // context rather than silently repurposing its payment account.

    if(next.invoiceId){next.previousInvoiceId=next.invoiceId;delete next.invoiceId;}

    for(const key of ['quotedAmount','quoteSource','invoiceStatus','paymentDetailsSentAt','paymentStatus','customerWantsToProceed','paymentDetailsRequested'])delete next[key];

  }

  let amount=service?.data.serviceType==='account_setup'?service.data.price:selected?.data.amount;

  if(!amount&&service?.data.serviceType==='ads_management'&&next.budget>0&&next.duration>0) {

    try {

      const pricing=await require('./pricing').calculate({platform:next.selectedPlatform,budget:next.budget,duration:next.duration,budgetBasis:next.budgetBasis==='total'?'total':'daily'});

      amount=pricing.total;base.debug.calculator=pricing;next.quoteSource='ads_calculator';

    }catch{return handoff('CALCULATOR_ERROR');}

  } else if(amount)next.quoteSource=selected?`plan:${selected.key}`:`service:${service.key}`;

  if(next.invoiceId&&invoiceRecord?.status==='pending'&&new Date(invoiceRecord.expiresAt)>new Date(now)){amount=invoiceRecord.amount;next.quoteSource='existing_invoice';}

  if(amount){next.quotedAmount=amount;next.quotedAt=time;}

  const vars={customer_name:customerName||'there',service_name:service?.title||'',service:service?.title||'',price:amount?money(amount):'',amount:amount?money(amount):'',platform:next.selectedPlatform==='meta'?'Meta (Facebook & Instagram)':next.selectedPlatform==='tiktok'?'TikTok':'',budget:next.budget?money(next.budget):'',duration:next.duration||'',plan_name:selected?.title||'',plans:plans.map(p=>`${p.data.duration} days — ${money(p.data.amount)}`).join('\n'),ad_budget:base.debug.calculator?money(base.debug.calculator.advertisingBudget):'',management_fee:base.debug.calculator?money(base.debug.calculator.managementFee):'',requirements:service?.data.requirements||''};

  const respond=(key,stage,objective)=>{

    const e=entryFor(key);

    if(!e)return {...handoff('MISSING_KNOWLEDGE_RULE'),debug:{...base.debug,missingKnowledgeKey:key}};

    let response;try{const template=e.data.preferredResponse||e.data.answer;for(const [,key]of String(template).matchAll(/\{\{([a-z_]+)\}\}/g))if(vars[key]===''||vars[key]===undefined)throw Error('Missing variable');response=render(e.data.preferredResponse||e.data.answer,vars);if(/\{\{/.test(response))throw Error('Unresolved variable');}catch{return handoff('INCOMPLETE_KNOWLEDGE_CONTEXT');}

    next.currentSalesStage=stage||next.currentSalesStage||'DISCOVERY';next.nextObjective=objective||e.data.nextObjective;

    next.lastRequiredQuestion=next.nextObjective;next.lastProgressionQuestionAt=time;next.updatedAt=time;

    return {...base,action:'reply',response,state:next,amount,serviceKey:service?.key,knowledge:[e.key],responseMode:e.data.responseMode,debug:{...base.debug,nextObjective:next.nextObjective,authoritativeQuote:{amount,source:next.quoteSource}}};

  };

  if(d.compareServices===true){

    const setup=services.find(r=>r.data.serviceType==='account_setup'&&r.data.platforms.includes(next.selectedPlatform));

    const intro=setup?`Ads account setup: ${money(setup.data.price)}. We set up your account and guide you to run ads yourself.`:'For account setup, which platform do you want: TikTok or Meta?';

    return {...base,action:'reply',response:intro+'\n\nFor ads management (we run the ads for you), what is your daily advertising budget and how many days would you like to run?',state:{...next,serviceChoiceConfirmed:false,serviceType:undefined,nextObjective:'GET_SERVICE_TYPE',lastRequiredQuestion:'GET_SERVICE_TYPE'}};

  }

  if(negotiating && amount && service){

    next.salesPaused=false;

    return {...base,action:'reply',response:`I'm sorry, the price is not negotiable. ${service.title} costs ${money(amount)}.\n\nWould you like to proceed?`,amount,serviceKey:service.key,state:{...next,currentSalesStage:'PRICE_PRESENTED',nextObjective:'CONFIRM_PROCEED',lastRequiredQuestion:'CONFIRM_PROCEED'},debug:{...base.debug,pricePolicy:'NON_NEGOTIABLE'}};

  }

  if(d.declines===true){next.salesPaused=true;next.customerWantsToProceed=false;next.paymentDetailsRequested=false;return respond('customer_declines',next.currentSalesStage,'COMPLETE');}

  if(d.unrelated===true)return respond('unrelated_question',next.currentSalesStage,'ANSWER');

  if(d.identityQuestion===true)return respond('ai_identity',next.currentSalesStage,'ANSWER');

  if(d.wantsToProceed===true&&state.quotedAmount||d.intent==='ready_to_pay'||yes&&state.lastRequiredQuestion==='CONFIRM_PROCEED')next.customerWantsToProceed=true;

  const explicitPaymentRequest=/^(?:(?:okay|ok|yes|please)[,\s]*)*(?:(?:can|could) you\s+)?(?:send|share|give)(?: me| us)?\s+(?:the |your )?(?:account|bank|payment|invoice)\b|\bhow (?:do|can|should) i pay\b/i.test(text.trim());

  if(explicitPaymentRequest||!yes&&(d.paymentDetailsRequested===true||['request_invoice','request_account_number'].includes(d.intent))||yes&&state.lastRequiredQuestion==='OFFER_PAYMENT_DETAILS'){next.customerWantsToProceed=true;next.paymentDetailsRequested=true;}

  if(next.customerWantsToProceed)next.salesPaused=false;

  if(matched.some(e=>e.data.forceHandoff))return handoff(matched.find(e=>e.data.forceHandoff).data.handoffReason||'MANUAL_ADMIN_RULE');

  let answer='';

  const priceOnly=(d.asksPrice||/\b(how much|price|cost|fee)\b/i.test(text))&&!/\b(include|cover|entail|need|require|and|also|views?|engagements?|reach|impressions?|clicks?|results?|expect)\b/i.test(text);

  if(!platformOnly&&!priceOnly&&d.answerKind==='answer'&&d.answerSupported&&matched.length) {

    const strict=matched.find(e=>e.data.preferredResponse&&(e.data.responseMode==='STRICT'||e.data.responseMode==='GUIDED'&&!e.data.allowContext));

    const raw=strict?strict.data.preferredResponse:d.answer;

    // Dynamic money/payment data must be bound by the server, never generated.

    const withoutVars=String(raw||'').replace(/\{\{[a-z_]+\}\}/g,'');

    if(!/[₦$€£]|\b\d[\d,.]*\s*(?:naira|NGN|dollars)\b|https?:|\b\d{5,}\b|\b(?:payment|transfer)\s+(?:is\s+|has been\s+)?(?:confirmed|received|successful|verified)\b/i.test(withoutVars)){

      try{for(const [,key]of String(raw).matchAll(/\{\{([a-z_]+)\}\}/g))if(vars[key]===''||vars[key]===undefined)throw Error('Missing variable');answer=render(raw,vars);}catch{/* Missing context is resolved by the planner below. */}

    }

    base.knowledge=matched.map(e=>e.key);

    base.responseMode=strict?'STRICT':matched[0].data.responseMode||'KNOWLEDGE';

  }

  let result;

  if(next.salesPaused)result=respond('customer_declines',next.currentSalesStage,'COMPLETE');

  else if(!next.serviceType&&!next.selectedPlatform&&d.intent==='greeting')result=respond('generic_first_contact','DISCOVERY');

  else if(!next.serviceType)result=respond('ads_service_clarification','SERVICE_CLARIFICATION');

  else if(!next.selectedPlatform)result=respond('ads_platform_selection','PLATFORM_SELECTION');

  else if(!service)return handoff('NO_APPROVED_SERVICE');

  else if((d.needsRecommendation===true||next.needsBudgetGuidance)&&!amount&&plans.length)result=respond('recommended_ads_plans','QUALIFIED');

  else if(next.serviceType==='ads_management'&&!amount)result=respond(next.budget?'ads_duration':next.duration?'ads_budget':'ads_management_details','QUALIFIED');

  else if(next.paymentDetailsRequested&&next.customerWantsToProceed&&amount) {

    if(!config.invoicesEnabled||!service.data.paymentEnabled)return handoff('PAYMENT_REVIEW_REQUIRED');

    next.currentSalesStage='PAYMENT_DETAILS_REQUESTED';next.nextObjective='SEND_INVOICE';

    result={...base,action:'invoice',response:'',state:next,amount,serviceKey:service.key};

  } else if(next.invoiceId&&next.paymentDetailsSentAt) {

    next.currentSalesStage='PAYMENT_PENDING';

    if(answer&&(now-new Date(state.lastProgressionQuestionAt||0).getTime()<config.paymentQuestionCooldownMinutes*60000||d.notPaidYet))result={...base,action:'reply',state:next,response:answer};

    else result=respond('pending_payment','PAYMENT_PENDING');

  } else if(next.customerWantsToProceed&&amount)result=respond('ready_to_proceed','READY_TO_PROCEED');

  else if(amount&&answer&&state.quotedAmount===amount&&state.selectedService===service.key)result=respond('confirm_proceed','PRICE_PRESENTED');

  else if(amount)result=respond(next.quoteSource==='ads_calculator'?'custom_management_price':'service_price','PRICE_PRESENTED');

  else return handoff('NO_APPROVED_KNOWLEDGE');

  // Missing optional sales copy must not discard an approved answer.

  if(answer && result.action==='handoff' && result.handoff==='MISSING_KNOWLEDGE_RULE') {

    result={...base,action:'reply',response:answer,state:{...next,nextObjective:'ANSWER_PREPAYMENT_QUESTION',updatedAt:time},debug:{...base.debug,missingKnowledgeKey:result.debug.missingKnowledgeKey,progressionSkipped:true}};

  }

  if(d.intent==='unknown'&&!answer&&!d.answerKind?.includes('clarify'))return handoff('NO_APPROVED_KNOWLEDGE');

  if(d.intent==='knowledge'&&!answer&&!priceOnly)return handoff('NO_APPROVED_KNOWLEDGE');

  if(answer&&matched[0]?.data.requiredQuestion&&result.action==='reply'&&matched[0].data.nextObjective===result.state.nextObjective){

    const e=matched[0];try{result.response=render(e.data.requiredQuestion,vars);}catch{return handoff('INCOMPLETE_KNOWLEDGE_CONTEXT');}

  }

  if(answer&&result.action==='reply'&&result.state.nextObjective===state.lastRequiredQuestion){result.response=answer;result.debug={...result.debug,repeatedQuestionSuppressed:true};}

  if(answer&&result.action==='reply'&&result.response!==answer){result.response=answer+'\n\n'+result.response;result.knowledge=[...new Set([...base.knowledge,...result.knowledge])];}

  const asksBreakdown=d.asksBreakdown===true || /\b(break\s*down|breakdown|how (?:does|will) (?:it|this|that|the .*?plan) work)\b/i.test(text);

  if(result.action==='reply' && service?.data.serviceType==='ads_management' && amount && !next.invoiceId && (asksBreakdown || next.quoteSource==='ads_calculator' && !answer)) {

    try {

      const pricing=base.debug.calculator || await require('./pricing').calculate({platform:next.selectedPlatform,budget:next.budget,duration:next.duration,budgetBasis:next.budgetBasis==='total'?'total':'daily',...(selected?{planAmount:selected.data.amount}:{})});

      result.response=pricing.breakdown;

      result.debug={...result.debug,calculator:pricing};

      if(!next.customerWantsToProceed && !next.salesPaused){const question=entryFor('confirm_proceed');if(question)result.response+='\n\n'+render(question.data.preferredResponse,vars);}

    }catch{return handoff('CALCULATOR_ERROR');}

  }

  // Do not send the identical discovery question again when no new field was supplied.

  if(result.action==='reply'&&!answer&&result.state.nextObjective===state.lastRequiredQuestion){

    if(['GET_BUDGET','GET_BUDGET_DURATION','GET_DURATION'].includes(state.lastRequiredQuestion)&&plans.length&&!amount){

      next.needsBudgetGuidance=true;result=respond('recommended_ads_plans','QUALIFIED');

      result.debug={...result.debug,repeatedQuestionSuppressed:true};

    }else if(state.lastRequiredQuestion==='GET_PLATFORM'){

      result.response='You can choose TikTok, Meta (Facebook & Instagram), or both. If you’re unsure, what would you like help deciding?';

      result.debug={...result.debug,repeatedQuestionSuppressed:true};

    }

  }

  if(result.response?.length>config.maxResponseLength)return handoff('RESPONSE_TOO_LONG');

  if(result.action==='reply'&&require('./responsePolicy').promisesHandoff(result.response,config.fallbackResponse))return {...result,...handoff('RESPONSE_REQUIRES_STAFF')};

  return result;

}

module.exports={decide};
