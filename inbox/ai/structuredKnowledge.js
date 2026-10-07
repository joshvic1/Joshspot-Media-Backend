// Structured business instructions. No financial or ownership fields are writable
// through a knowledge entry; those belong to verified backend actions.
const stateFields = ['selectedPlatform','serviceType','serviceChoiceConfirmed','budgetBasis','budget','duration','selectedService','recommendedPlan','currentSalesStage','currentIntent','customerWantsToProceed','paymentDetailsRequested','lastRequiredQuestion','nextObjective','salesPaused'];
const objectives = ['DISCOVER_SERVICE','GET_SERVICE_TYPE','GET_PLATFORM','GET_BUDGET_DURATION','GET_BUDGET','GET_DURATION','SELECT_PLAN','CONFIRM_PROCEED','OFFER_PAYMENT_DETAILS','CHECK_PAYMENT','ANSWER','HANDOFF','COMPLETE'];
const textFields = ['purpose','intents','triggerExamples','keywords','semanticTrigger','whenToUse','whenNotToUse','preferredResponse','facts','requiredQuestion','notes','paymentBehaviour','handoffReason'];
function validate(data) {
  const fail = message => { throw Object.assign(new Error(message), {status:400}); };
  const out = {schemaVersion:1};
  for (const key of textFields) { const value=data[key] ?? ''; if(typeof value!=='string'||value.length>6000)fail(`Invalid ${key}`);out[key]=value; }
  out.responseMode=data.responseMode || 'KNOWLEDGE';
  out.contentRole=data.contentRole||(out.responseMode==='STRICT'?'RESPONSE':'KNOWLEDGE');
  if(!['KNOWLEDGE','RESPONSE','GUIDANCE'].includes(out.contentRole))fail('Choose knowledge, response or guidance.');
  if(!['STRICT','GUIDED','KNOWLEDGE'].includes(out.responseMode))fail('Choose STRICT, GUIDED or KNOWLEDGE.');
  out.nextObjective=data.nextObjective || 'ANSWER';if(!objectives.includes(out.nextObjective))fail('Choose a supported next objective.');
  for(const key of ['allowContext','forceHandoff']) {out[key]=data[key]??false;if(typeof out[key]!=='boolean')fail(`Invalid ${key}`);}
  for(const key of ['requiredState','excludedState','stateUpdates']) {
    const value=data[key]??{};
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>stateFields.length)fail(`Invalid ${key}`);
    out[key]={};
    for(const [field,item] of Object.entries(value)) {
      if(!stateFields.includes(field)||!['string','number','boolean'].includes(typeof item)||typeof item==='string'&&item.length>160||typeof item==='number'&&!Number.isFinite(item))fail(`Unsupported state field/value: ${field}`);
      if(key==='stateUpdates'&&!['selectedPlatform','serviceType','currentIntent'].includes(field))fail('Knowledge may only update platform, service type or intent; customer consent and money require verified actions.');
      if(field==='selectedPlatform'&&!['tiktok','meta','missing','present'].includes(item))fail('Invalid platform.');
      if(field==='serviceType'&&!['account_setup','ads_management','missing','present'].includes(item))fail('Invalid service type.');
      out[key][field]=item;
    }
  }
  out.displayOrder=Number.isInteger(data.displayOrder)?data.displayOrder:0;
  // Never embed stale prices in behavior. Service and calculator placeholders are authoritative.
  if(/[₦$€£]\s*\d|\d[\d,]*\s*(?:naira|NGN|dollars)/i.test([out.preferredResponse,out.facts,out.requiredQuestion].join(' ')))fail('Use {{price}} or {{plans}}; edit prices in Services.');
  return out;
}
function matchesState(condition={},state={}) {
  return Object.entries(condition).every(([key,value])=>value==='missing'?!state[key]:value==='present'?Boolean(state[key]):state[key]===value);
}
function eligible(entry,state) {
  const d=entry.data||{};
  return entry.enabled!==false&&!entry.archived&&matchesState(d.requiredState,state)&&(!Object.keys(d.excludedState||{}).length||!matchesState(d.excludedState,state));
}
function rank(entries,text,state={},intent='') {
  const words=new Set(String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu)||[]);
  return entries.filter(e=>eligible(e,state)).map(entry=>{
    const d=entry.data||{}, terms=String([entry.title,d.keywords,d.triggerExamples,d.semanticTrigger,d.question].join(' ')).toLowerCase().match(/[\p{L}\p{N}]+/gu)||[];
    const overlap=new Set(terms.filter(w=>w.length>2&&words.has(w))).size;
    const intentMatch=Boolean(intent&&String(d.intents||'').split(/[\s,]+/).includes(intent));
    const specificity=Object.keys(d.requiredState||{}).length;
    return {...entry,match:{reason:[intentMatch&&'intent',specificity&&'conversation state',overlap&&'message terms'].filter(Boolean).join(', ')||'priority candidate',score:(intentMatch?100:0)+specificity*15+overlap*8+(entry.priority||0)/20}};
  }).sort((a,b)=>b.match.score-a.match.score||(b.priority||0)-(a.priority||0)||new Date(b.updatedAt||0)-new Date(a.updatedAt||0)||a.key.localeCompare(b.key)).slice(0,12);
}
const seeds = [
 ['generic_first_contact','Generic first contact','DISCOVER_SERVICE','Hello 👋\n\nWhich of our services are you interested in? Please tell me.'],
 ['ads_service_clarification','Setup or management','GET_SERVICE_TYPE','Do you want us to set up your ads account for you, then teach you how to access it and run the ads yourself?\n\nOr\n\nDo you want us to run the ads straight up for you?'],
 ['ads_platform_selection','Choose platform','GET_PLATFORM','Which platform do you want?\n\nTikTok\n\nor\n\nMeta (Facebook & Instagram)?'],
 ['ads_management_details','Budget and duration','GET_BUDGET_DURATION','What is your daily advertising budget, and how many days would you like to run the ads for?'],
 ['ads_budget','Missing budget','GET_BUDGET','What is your daily advertising budget?'],
 ['ads_duration','Missing duration','GET_DURATION','How many days would you like the ads to run?'],
 ['recommended_ads_plans','Recommended plans','SELECT_PLAN','{{plans}}\n\nWhich one would you like to go with?'],
 ['custom_management_price','Custom ads quote','CONFIRM_PROCEED','The total is {{price}} for {{duration}} days.\n\nThis includes {{ad_budget}} advertising budget and {{management_fee}} management fee.\n\nWould you like to proceed?'],
 ['service_price','Present price','CONFIRM_PROCEED','{{service_name}} costs {{price}}.\n\nWould you like to proceed?'],
 ['confirm_proceed','Confirm purchase decision','CONFIRM_PROCEED','Would you like to proceed?'],
 ['ready_to_proceed','Offer payment details','OFFER_PAYMENT_DETAILS','Should I send the account details now?'],
 ['payment_followup','Pending invoice reminder','CHECK_PAYMENT','Would you still like to proceed? Let us know if you need any help with payment.'],
 ['pending_payment','Payment status question','CHECK_PAYMENT','Have you made payment already?'],
 ['media_handoff','Media handoff','HANDOFF','Hold on, you will get a response shortly.'],
 ['customer_declines','Customer is not ready','COMPLETE','Okay.'],
 ['unrelated_question','Unrelated question','ANSWER',"I’m here to help with Joshspot services 😊 What would you like help with?"],
 ['payment_claim','Payment needs verification','HANDOFF','Thanks for letting us know. Customer support will check the payment before confirming it.'],
 ['payment_verified','Verified payment','HANDOFF','Payment confirmed. Thank you — I’m passing this to customer support for the next step.'],
 ['ai_identity','Automated assistant identity','ANSWER',"This is Joshspot’s automated assistant helping with quick responses 😊 If you’d prefer someone from the team, I can get them for you."],
].map(([key,title,nextObjective,preferredResponse],i)=>({kind:'knowledge',key,title,category:nextObjective==='HANDOFF'?'Handoff':'Sales flow',priority:100,enabled:true,archived:false,data:{...validate({preferredResponse,nextObjective,responseMode:'STRICT',displayOrder:i,purpose:title,whenToUse:`Selected by the sales planner for ${nextObjective}.`}),plannerOnly:true}}));
seeds.push(...[
 ['setup_scope','What account setup includes','What does setup entail cover include what do I get','Account setup covers advertising-account setup and guidance on accessing it and running your own ads.'],
 ['setup_budget_separate','Setup fee and advertising spend','Does setup include ads budget ad spend fee separate','The setup fee covers account setup and guidance. Your advertising budget is separate.'],
 ['setup_requirements','Account setup requirements','What do I need send requirements to get started','{{requirements}}'],
 ['service_difference','Setup versus campaign management','Difference setup management run it myself','With account setup, we set up your advertising account and guide you to run ads yourself. With ads management, we run the campaign for you.'],
].map(([key,title,triggerExamples,preferredResponse])=>({kind:'knowledge',key,title,category:'Services',priority:120,enabled:true,archived:false,data:validate({responseMode:'STRICT',preferredResponse,triggerExamples,keywords:triggerExamples,purpose:title,nextObjective:'ANSWER',whenToUse:title,whenNotToUse:key.startsWith('setup_')?'Do not use for campaign management questions.':''})})));
module.exports={validate,rank,eligible,matchesState,seeds,stateFields,objectives,textFields};
