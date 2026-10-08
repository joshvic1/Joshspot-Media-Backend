const { Config, Record } = require('./models');
const defaults = require('./defaults');
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
const stateFields = ['selectedPlatform','serviceType','currentStep','budget','duration','selectedService','recommendedPlan'];
const intents = defaults.config.allowedIntents;
function safeString(value, max = 6000) { if (typeof value !== 'string' || value.length > max) fail('Invalid or oversized text.'); return value; }
function validateConfig(input) {
  const out = {};
  for (const [key, fallback] of Object.entries(defaults.config)) {
    const value = input[key] ?? fallback;
    if (Array.isArray(fallback)) { if (!Array.isArray(value) || value.length > 30 || value.some(v => !intents.includes(v))) fail('Choose supported intents.'); out[key] = value; }
    else if (typeof fallback === 'boolean') { if (typeof value !== 'boolean') fail(`Invalid ${key}`); out[key] = value; }
    else if (typeof fallback === 'number') { if (!Number.isFinite(value)) fail(`Invalid ${key}`); out[key] = value; }
    else out[key] = safeString(value);
  }
  const ranges = { followupFirstHours:[1,168],followupSecondHours:[1,168],followupMaximum:[1,2],paymentQuestionCooldownMinutes:[1,1440], confidence:[0,1], maxResponseLength:[100,4000], maxHistory:[0,12], debounceSeconds:[1,10], responseDelaySeconds:[0,10], maxConsecutive:[0,30], maxDailyCalls:[0,10000], maxConversationCalls:[0,200], startHour:[0,23], endHour:[1,24] };
  for (const [key,[min,max]] of Object.entries(ranges)) if(out[key]<min || out[key]>max) fail(`${key} must be between ${min} and ${max}.`);
  if(!Number.isInteger(out.followupMaximum)||out.followupSecondHours<=out.followupFirstHours)fail('Follow-up count must be 1 or 2 and the second reminder must be later than the first.');
  if (!(out.engineVersion==='v4'?['OFF','TEST','DRAFT','LIVE']:['OFF','DRAFT','LIVE']).includes(out.mode) || out.provider !== 'openai') fail('Unsupported AI mode/provider.');
  if(!['v1','shadow','v2','v3','v4'].includes(out.engineVersion))fail('Choose v1, shadow, v2, v3 or v4.');
  if(out.engineVersion==='v4'&&out.mode==='LIVE'&&process.env.AI_V4_LIVE_APPROVED!=='1')fail('V4 LIVE requires explicit backend approval after validation.');
  for(const stage of ['Interpreter','Composer']){if(!/^gpt-[a-z0-9.\-]+$/.test(out[`v4${stage}Model`]))fail('Enter a valid V4 model name.');if(!['none','low','medium','high','xhigh','max'].includes(out[`v4${stage}Reasoning`]))fail('Choose supported V4 reasoning.');if(out[`v4${stage}Model`]==='gpt-6.1-sol'&&out[`v4${stage}Reasoning`]==='none')fail('GPT-6.1 Sol requires low or higher reasoning.');}
  if(!Number.isInteger(out.v4HistoryMessages)||out.v4HistoryMessages<4||out.v4HistoryMessages>80||!Number.isInteger(out.v4MaxOutputTokens)||out.v4MaxOutputTokens<1000||out.v4MaxOutputTokens>12000)fail('V4 history must be 4–80 messages and output 1000–12000 tokens.');
  if(!Number.isInteger(out.v3MaxOutputTokens)||out.v3MaxOutputTokens<500||out.v3MaxOutputTokens>4000)fail('V3 output tokens must be between 500 and 4000.');
  if (!['CSS','SS'].includes(out.handoffTeam) || !['least_loaded','round_robin','fallback'].includes(out.assignment)) fail('Invalid handoff strategy.');
  if (!['handoff','continue'].includes(out.outsideHours) || !['handoff','ignore'].includes(out.stickerAction) || !['handoff','ignore'].includes(out.contactAction)) fail('Invalid handling rule.');
  for (const key of ['fallbackAgent','paymentAgent']) if (out[key] && !/^[a-f0-9]{24}$/i.test(out[key])) fail('Choose a valid staff member.');
  try { new Intl.DateTimeFormat('en',{timeZone:out.timezone}); } catch { fail('Invalid timezone.'); }
  return out;
}
const fields = {
 service:['checkoutUrl','platforms','serviceType','price','currency','description','requirements','paymentEnabled','workflow','allowCustomBudget','minBudget','maxBudget'],
 plan:['duration','amount','currency','platforms','service','description'],
 knowledge:['question','answer','keywords','handoffAfterReply','handoffReason','handoffTeam'], tone:['customer','response'],
 response:['message','mode','intent','workflow','service','platform','description','variables','handoffAfterReply'],
 workflow:['intent','field','operator','value','response','nextStep','action','stateField','stateValue','options','serviceType'],
 handoff:['intent','reason','agent','team','customerResponse','mandatory'],
};
function validateRecord(input) {
  if (!fields[input.kind]) fail('Invalid record kind.');
  const data = {}; const source = input.data || {};
  if(input.kind==='knowledge' && source.schemaVersion===1) Object.assign(data,require('./structuredKnowledge').validate(source));
  if(input.kind==='knowledge'){
    for(const [field,allowed]of Object.entries({v4Topics:require('./v4/schema').requests,v4Platforms:require('./v4/schema').platforms,v4Services:require('./v4/schema').services,v4ExcludedServices:require('./v4/schema').services}))if(source[field]!==undefined){if(!Array.isArray(source[field])||source[field].some(v=>!allowed.includes(v)))fail('Invalid V4 knowledge metadata.');data[field]=source[field];}
    if(source.v4Mandatory!==undefined){if(typeof source.v4Mandatory!=='boolean')fail('Invalid V4 mandatory flag.');data.v4Mandatory=source.v4Mandatory;}
  }
  for (const key of fields[input.kind]) if (source[key] !== undefined) {
    if(input.kind==='knowledge'&&source.schemaVersion===1)continue;
    const value = source[key];
    if (['platforms','variables','options'].includes(key)) { if (!Array.isArray(value) || value.length > 20) fail('Invalid options.'); data[key] = value.map(v=>safeString(v,120)); }
    else if (['price','amount','duration','minBudget','maxBudget'].includes(key)) { if (!Number.isFinite(value) || value<0 || value>100000000) fail('Invalid numeric value.'); data[key] = value; }
    else if (['paymentEnabled','allowCustomBudget','handoffAfterReply','mandatory'].includes(key)) { if (typeof value !== 'boolean') fail('Invalid checkbox.'); data[key] = value; }
    else data[key] = safeString(value);
  }
  if(input.kind==='knowledge'&&data.schemaVersion===1){data.answer=[data.preferredResponse,data.facts].filter(Boolean).join('\n');data.question=[data.triggerExamples,data.semanticTrigger,data.whenToUse].filter(Boolean).join('\n');}
  if (data.handoffTeam && data.handoffTeam!=='CSS') fail('Knowledge handoff uses the customer-service team.');
  if (input.kind === 'response' && !['STRICT','FLEXIBLE','INFORMATION'].includes(data.mode)) fail('Choose a response mode.');
  if (['response','knowledge'].includes(input.kind) && /[₦$€£]\s*\d|\d[\d,]*\s*(?:naira|NGN|dollars)/i.test(data.message || data.answer || '')) fail('Use {{amount}} for prices; edit the amount in Services or Plans.');
  if (input.kind === 'service' && data.allowCustomBudget && (!(data.minBudget>=100) || !(data.maxBudget>=data.minBudget))) fail('Set valid minimum and maximum custom budgets.');
  if (['service','plan'].includes(input.kind) && (data.currency !== 'NGN' || !data.platforms?.length)) fail('Choose platforms and NGN currency.');
  if (input.kind==='service' && !['account_setup','ads_management','course'].includes(data.serviceType)) fail('Choose a service type.');
  if (input.kind==='plan' && (!(data.amount >= 100) || !(data.duration >= 1))) fail('Set a plan amount and duration.');
  if (input.kind==='workflow' && (!['reply','handoff'].includes(data.action) || !stateFields.includes(data.field) || !['missing','equals','present'].includes(data.operator) || data.stateField && !stateFields.includes(data.stateField))) fail('Invalid workflow action or state field.');
  if (data.intent && ![...intents,'*'].includes(data.intent) && input.kind !== 'response') fail('Invalid intent.');
  const title = safeString(input.title,160).trim(); if (!title) fail('A title is required.');
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(input.key || '')) fail('Use a unique key with letters, numbers, hyphens or underscores.');
  return {kind:input.kind,key:input.key,title,category:safeString(input.category || '',100),enabled:input.enabled !== false,archived:input.archived === true,priority:Math.max(-1000,Math.min(1000,Number(input.priority)||0)),data};
}
async function getConfig() {
  let row = await Config.findOne({key:'main'}).lean();
  // One-time policy migration; preserve later administrator edits.
  if(row && row.usageLimitsVersion!==1){
    await Config.updateOne({key:'main',usageLimitsVersion:{$ne:1}},{$set:{usageLimitsVersion:1,'data.maxDailyCalls':0,'data.maxConversationCalls':0,'data.maxConsecutive':0},$inc:{revision:1}});
    row=await Config.findOne({key:'main'}).lean();
  }
  return row ? {...row,data:{...defaults.config,...row.data,masterInstructions:row.masterInstructions ?? require('./masterKnowledge').starter}} : {revision:-1,data:{...defaults.config,enabled:false}};
}
async function seed(actor) {
  await Config.updateOne({key:'main'},{$setOnInsert:{data:defaults.config,changedBy:actor,revision:0,usageLimitsVersion:1}},{upsert:true});
  for (const item of [...defaults.records,...require('./structuredKnowledge').seeds]) await Record.updateOne({kind:item.kind,key:item.key},{$setOnInsert:{...item,enabled:true,archived:false,createdBy:actor,changedBy:actor,revision:0}},{upsert:true});
}
async function catalogue(structured=false) { const course=defaults.records.find(r=>r.key==='ads_video_course');await Record.updateOne({kind:'service',key:course.key},{$setOnInsert:{...course,enabled:true,archived:false,createdBy:'system',revision:0}},{upsert:true}); return Record.find({enabled:true,archived:false,$or:[{kind:{$ne:'knowledge'}},...(structured?[{kind:'knowledge',key:{$in:require('./structuredKnowledge').seeds.map(s=>s.key)}}]:[])]}).sort({priority:-1,_id:1}).limit(300).lean(); }
async function knowledge(text,state,structured=false) {
  if(structured){
    const base={kind:'knowledge',enabled:true,archived:false};
    const terms=String(text).replace(/[^\p{L}\p{N}\s]/gu,' ').split(/\s+/).filter(w=>w.length>2).slice(0,20).join(' ');
    const [priority,matched]=await Promise.all([Record.find(base).sort({priority:-1,_id:1}).limit(40).lean(),terms?Record.find({...base,$text:{$search:terms}},{score:{$meta:'textScore'}}).sort({score:{$meta:'textScore'}}).limit(40).lean():[]]);
    return require('./structuredKnowledge').rank([...new Map([...matched,...priority].map(r=>[r.key,r])).values()],text,state);
  }
  const query = String(text).replace(/[^\p{L}\p{N}\s]/gu,' ').split(/\s+/).filter(w=>w.length>2).slice(0,20).join(' ');
  if (!query) return Record.find({kind:'knowledge',enabled:true,archived:false,'data.schemaVersion':{$ne:1}}).sort({priority:-1}).limit(12).lean();
  const matches=await Record.find({kind:'knowledge',enabled:true,archived:false,'data.schemaVersion':{$ne:1},$text:{$search:query}},{score:{$meta:'textScore'}}).sort({score:{$meta:'textScore'},priority:-1}).limit(12).lean();
  return matches.length?matches:Record.find({kind:'knowledge',enabled:true,archived:false,'data.schemaVersion':{$ne:1}}).sort({priority:-1}).limit(12).lean();
}
module.exports = {validateConfig,validateRecord,getConfig,seed,catalogue,knowledge,stateFields,intents};
