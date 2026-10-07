// Strict API contracts. Commercial facts are proposals, never tool permissions.
const str={type:'string'}, bool={type:'boolean'}, num={type:'number'};
const enumeration=values=>({type:'string',enum:values});
const array=items=>({type:'array',items});
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const fields={platforms:['tiktok','meta'],services:['account_setup','ads_management','course'],budget:[],budgetBasis:['daily','total'],duration:[],plan:[],setupNeeded:['yes','no'],proceed:['yes','no'],paymentRequested:['yes','no']};
const evidence=object({messageId:str,text:str});
const values={platforms:['tiktok','meta','tiktok,meta'],services:['account_setup','ads_management','course','account_setup,ads_management'],budgetBasis:['daily','total'],setupNeeded:['yes','no'],proceed:['yes','no'],paymentRequested:['yes','no']};
const fact={anyOf:Object.keys(fields).map(field=>object({field:enumeration([field]),value:{...(values[field]?enumeration(values[field]):str),...(field==='services'?{description:'A COMMERCIAL SERVICE CHOICE, not general advertising intent. account_setup requires asking for account setup/guidance. ads_management requires explicitly choosing the BUSINESS to operate the campaign. Wanting to advertise or run ads does not establish who will operate it: omit this fact or mark tentative. Both requires requesting both activities.'}:{})},itemId:str,confidence:num,explicit:bool,correction:bool,evidence}))};
const signal=object({value:bool,evidence});
const request=object({text:str,evidence});
const interpretation=object({
  items:array(object({action:enumeration(['add','remove']),platform:enumeration(['tiktok','meta','none']),serviceType:enumeration(['account_setup','ads_management','course']),replaces:str,explicit:bool,confidence:num,evidence})),
  decisions:array(object({type:enumeration(['INTERESTED','READY_TO_PROCEED','PAYMENT_REQUESTED','DEFERRED','DECLINED','RESUMED']),scope:str,explicit:bool,confidence:num,evidence})),
  budgets:array(object({kind:enumeration(['DAILY_AD_SPEND','TOTAL_AD_SPEND','ALL_IN_CAP','PACKAGE_SELECTION','COUNTEROFFER']),amount:num,itemId:str,explicit:bool,confidence:num,evidence})),
  requests:array(object({id:str,type:enumeration(['ask_price','ask_requirements','ask_recommendation','ask_budget_advice','ask_duration','ask_payment_method','request_invoice','answer_previous_question','select_service','select_platform','correct_previous_fact','negotiate','defer_purchase','resume_purchase','ask_course_question','ask_support_question','request_human','other_supported_business_question']),text:str,itemId:str,questionId:str,evidence})),
  intents:array(enumeration(['greeting','advertising','recommendation','requirements','ready_to_pay','request_invoice','request_account_number','payment_question','payment_sent','receipt_sent','payment_problem','human','knowledge','unknown'])),questions:{...array(request),description:'Questions the CUSTOMER actually asked in this turn. Never questions the assistant should ask. Empty for a service selection with no question.'},facts:array(fact),answeredQuestionIds:array(str),
  recommendations:{...array(request),description:'Explicit customer requests for recommendations, or explicitly stated uncertainty about budget/duration. Empty otherwise. Not inferred missing information.'},unresolvedReferences:array(str),
  negotiation:{...signal,description:'True only for a customer counteroffer or request to reduce a service price; not an advertising budget.'},
  deferral:{...signal,description:'True only if the customer says they are not ready to buy or will decide later. This does not stop answering their questions.'},
  humanRequest:{...signal,description:'True ONLY when the customer explicitly asks to TALK/CHAT with a human agent instead of the assistant. Asking the business to run/manage ads or set up an account is a SERVICE ORDER, NOT a human-agent request. Default false.'},
  paymentClaim:{...signal,description:'True only when customer claims a transfer/payment has already been made, not purchase intent or asking how to pay.'},
  sensitiveCase:{...signal,description:'True only for serious security, refund/dispute or exceptional complaint requiring staff judgment. Ordinary service questions and price objections are false.'},
  topic:{...enumeration(['advertising','course','support','other','unchanged']),description:'The topic of THIS message, independently of selected purchase. A question about the video course sets course even while an advertising purchase remains selected.'},
  purchaseChange:object({action:enumeration(['none','select','resume']),path:enumeration(['advertising','course','unchanged']),evidence}),
  confidence:num,
});
const selection=object({entries:array(object({key:str,reason:str})),unsupportedQuestions:array(str)});
const composition=object({parts:array(object({kind:enumeration(['text','knowledge','fact','question']),value:str})),usedKnowledge:array(str)});
const grounding=object({segments:array(object({index:num,claims:array(object({text:str,type:enumeration(['NEUTRAL','BUSINESS_FACT','PRICE','PAYMENT_STATUS','DESTINATION','GUARANTEE','DISCOUNT','PERMISSION','UNSUPPORTED']),sources:array(str),entailed:bool}))})),coverage:array(object({id:str,disposition:enumeration(['ANSWERED','ACTIONED','CLARIFICATION_REQUIRED','DEFERRED_WITH_REASON','HANDOFF_REQUIRED','UNSUPPORTED']),segments:array(num),reason:str}))});
// Validate locally as well as requesting strict outputs. Useful for replays and adapters.
function validate(schema,value,path='result') {
  if(schema.anyOf){for(const candidate of schema.anyOf){try{return validate(candidate,value,path);}catch{}}throw new Error(`Invalid ${path} variant`);}
  if(schema.enum&&!schema.enum.includes(value))throw new Error(`Invalid ${path}`);
  if(schema.type==='object'){
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`Invalid ${path}`);
    if(Object.keys(value).some(k=>!Object.hasOwn(schema.properties,k)))throw new Error(`Unexpected ${path} field`);
    for(const [key,s]of Object.entries(schema.properties))validate(s,value[key],`${path}.${key}`);
  }else if(schema.type==='array'){
    if(!Array.isArray(value)||value.length>40)throw new Error(`Invalid ${path}`);
    if(schema.maxItems!==undefined&&value.length>schema.maxItems)throw new Error(`Invalid ${path} length`);
    value.forEach((v,i)=>validate(schema.items,v,`${path}.${i}`));
  }else if(typeof value!==schema.type||schema.type==='number'&&!Number.isFinite(value)||schema.type==='string'&&value.length>6000)throw new Error(`Invalid ${path}`);
  return value;
}
function forInput(phase,input){
  if(phase==='selection')return object({entries:input.catalogue.length?array(object({key:enumeration(input.catalogue.map(k=>k.key)),reason:str})):{...array(object({key:str,reason:str})),maxItems:0},unsupportedQuestions:array(str)});
  if(phase==='composition'){
    const knowledge=input.knowledge.map(k=>k.key),quotable=input.knowledge.filter(k=>k.quoteable).map(k=>k.key),facts=Object.keys(input.plan.facts);
    const variants=[object({kind:enumeration(['text']),value:str})];
    if(quotable.length)variants.push(object({kind:enumeration(['knowledge']),value:enumeration(quotable)}));
    if(facts.length)variants.push(object({kind:enumeration(['fact']),value:enumeration(facts)}));
    if(input.plan.question)variants.push(object({kind:enumeration(['question']),value:enumeration([input.plan.question.purpose])}));
    return object({parts:array({anyOf:variants}),usedKnowledge:knowledge.length?array(enumeration(knowledge)):{...array(str),maxItems:0}});
  }
  if(phase==='grounding')return grounding;
  return interpretation;
}
function upgrade(value){return {items:[],decisions:[],budgets:[],requests:[],...value};}
module.exports={interpretation,selection,composition,grounding,validate,fields,forInput,upgrade};
