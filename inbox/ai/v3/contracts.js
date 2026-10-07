const string = {type:'string',maxLength:160};
const enumeration = (...values) => ({type:'string',enum:values});
const nullable = schema => ({anyOf:[schema,{type:'null'}]});
const object = properties => ({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const array = (items,maxItems=8) => ({type:'array',items,maxItems});
const evidence=object({messageId:string,quote:{type:'string',minLength:1,maxLength:2000}});
const request=object({id:string,kind:enumeration('social','clarification','business','price','recommendation','payment','human'),question:string,evidence,knowledgeKeys:array(string),serviceKeys:array(string),plans:{type:'boolean'}});
const plan=object({requests:array(request,12),purchaseChange:enumeration('keep','replace','clear'),purchase:array(object({platform:nullable(enumeration('tiktok','meta')),service:enumeration('account_setup','ads_management','course'),evidence})),quoteChange:enumeration('keep','invalidate'),payment:enumeration('none','request','defer','claim'),paymentEvidence:nullable(evidence)});
const finish=object({text:{type:'string',maxLength:6000},sources:array(string,30),questions:array(object({field:enumeration('service','platform','budget','duration','proceed','payment','other'),reason:enumeration('missing','contradiction'),evidence:nullable(evidence)}),4),coverage:array(object({requestId:string,status:enumeration('answered','deferred','unsupported'),sources:array(string,20),reason:{type:'string',maxLength:500}}),12)});
const item = {anyOf:[object({platform:enumeration('tiktok','meta'),service:enumeration('account_setup')}),object({platform:enumeration('tiktok','meta'),service:enumeration('ads_management'),budgetBasis:nullable(enumeration('DAILY_AD_SPEND','TOTAL_AD_SPEND','ALL_IN_BUDGET','PACKAGE')),budget:nullable({type:'number',minimum:0.01,maximum:100000000}),duration:nullable({type:'integer',minimum:1,maximum:365}),planKey:nullable(string),creativeMode:nullable(enumeration('testing','individual')),creatives:nullable({type:'integer',minimum:1,maximum:100})})]};
const definitions = [
  ['plan_turn','REQUIRED first. Interpret ALL current requests against actual sent history. Cite exact inbound evidence. Choose relevant catalogue keys, do not invent them. Keep purchase for a detour; replace only on explicit selection/correction. Classify current payment/human intent, not old consent. This plan retrieves selected approved facts before composition.',plan.properties],
  ['finish_response','Only customer text, with {{value:ID}} placeholders from provenance values for ALL numbers and URLs. No literal numeric values, money words, URLs or internal envelopes. Cite source IDs for business answers and account for every request. Deferred needs a genuine missing-information reason; unsupported requires handoff.',finish.properties],
  ['get_services','Read the enabled authoritative service catalogue. Prices in knowledge never override this.',{}],
  ['get_service_details','Read one enabled service, requirements, price and checkout URL.',{key:string}],
  ['resolve_service','Resolve a semantic service/platform concept to enabled authoritative data; never guess internal keys. Course may use null platform. Does not select a purchase or add services.',{service:enumeration('account_setup','ads_management','course'),platform:nullable(enumeration('tiktok','meta'))}],
  ['get_recommended_ads_plans','Read configured inclusive plans AND calculator breakdowns. Conflicting plans cannot be quoted or invoiced.',{}],
  ['calculate_ads_quote','Calculate exactly selected platform/service pairs. Setup needs ONLY platform and service; never ask setup budget/duration. PACKAGE uses discovered planKey, null budget. Null creativeMode/creatives means approved testing default; individual or extra creatives need exact customer creativeEvidence. purchaseCap caps ENTIRE purchase. Clarify shared allocations, never guess or add setup.',{items:array(item,4),purchaseCap:nullable({type:'number',minimum:0.01,maximum:100000000}),creativeEvidence:nullable(evidence)}],
  ['get_business_knowledge','Select relevant IDs from the supplied index semantically. Combine entries to answer all customer questions.',{keys:array(string,8)}],
  ['create_invoice','Request an invoice against the latest authoritative quote, only when the latest customer turn explicitly requests payment details now. The server independently checks current evidence. Test/DRAFT returns simulation only.',{quoteId:string,messageId:string,evidence:{type:'string',minLength:1,maxLength:6000}}],
  ['get_invoice_status','Read the current conversation invoice. No model-supplied customer or invoice ID.',{}],
  ['check_payment_status','Read trusted payment status; customer claims and receipts are not verification.',{}],
  ['handoff_to_human','Request actual assignment via the existing worker; Test/DRAFT simulates only. Never hand off for an ordinary answer available in the knowledge catalogue.',{reason:enumeration('CUSTOMER_REQUESTED_HUMAN','MEDIA_RECEIVED','NO_APPROVED_KNOWLEDGE','PAYMENT_VERIFICATION','SENSITIVE_CASE','TECHNICAL_FAILURE','MANUAL_ADMIN_RULE'),summary:{type:'string',minLength:1,maxLength:1500}}],
];
const tools=definitions.map(([name,description,properties])=>({type:'function',name,description,strict:true,parameters:object(properties)}));
// Validate again server-side: strict model output is not a security boundary.
function valid(schema,value){
  if(schema.anyOf)return schema.anyOf.some(s=>valid(s,value));
  if(schema.enum&&!schema.enum.includes(value))return false;
  if(schema.type==='null')return value===null;
  if(schema.type==='object')return value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>Object.hasOwn(schema.properties,k))&&schema.required.every(k=>Object.hasOwn(value,k)&&valid(schema.properties[k],value[k]));
  if(schema.type==='array')return Array.isArray(value)&&value.length<=schema.maxItems&&value.every(v=>valid(schema.items,v));
  if(schema.type==='string')return typeof value==='string'&&value.length<=(schema.maxLength??Infinity)&&value.length>=(schema.minLength??0);
  if(schema.type==='number'||schema.type==='integer')return typeof value==='number'&&Number.isFinite(value)&&(schema.type!=='integer'||Number.isInteger(value))&&value>=schema.minimum&&value<=schema.maximum;
  if(schema.type==='boolean')return typeof value==='boolean';
  return false;
}
function parse(name,argumentsText){const tool=tools.find(t=>t.name===name);if(!tool)throw new Error('UNKNOWN_TOOL');let args;try{args=JSON.parse(argumentsText);}catch{throw new Error('INVALID_TOOL_ARGUMENTS');}if(!valid(tool.parameters,args))throw new Error('INVALID_TOOL_ARGUMENTS');return args;}
module.exports={tools,parse,valid,object,enumeration,plan,finish};
