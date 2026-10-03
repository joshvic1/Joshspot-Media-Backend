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
  const ranges = { confidence:[0,1], maxResponseLength:[100,4000], maxHistory:[0,12], debounceSeconds:[1,10], responseDelaySeconds:[0,10], maxConsecutive:[1,30], maxDailyCalls:[1,10000], maxConversationCalls:[1,200], startHour:[0,23], endHour:[1,24] };
  for (const [key,[min,max]] of Object.entries(ranges)) if(out[key]<min || out[key]>max) fail(`${key} must be between ${min} and ${max}.`);
  if (!['OFF','DRAFT','LIVE'].includes(out.mode) || out.provider !== 'openai') fail('Unsupported AI mode/provider.');
  if (!['CSS','SS'].includes(out.handoffTeam) || !['least_loaded','round_robin','fallback'].includes(out.assignment)) fail('Invalid handoff strategy.');
  if (!['handoff','continue'].includes(out.outsideHours) || !['handoff','ignore'].includes(out.stickerAction) || !['handoff','ignore'].includes(out.contactAction)) fail('Invalid handling rule.');
  for (const key of ['fallbackAgent','paymentAgent']) if (out[key] && !/^[a-f0-9]{24}$/i.test(out[key])) fail('Choose a valid staff member.');
  try { new Intl.DateTimeFormat('en',{timeZone:out.timezone}); } catch { fail('Invalid timezone.'); }
  return out;
}
const fields = {
 service:['platforms','serviceType','price','currency','description','requirements','paymentEnabled','workflow','allowCustomBudget','minBudget','maxBudget'],
 plan:['duration','amount','currency','platforms','service','description'],
 knowledge:['question','answer','keywords'], tone:['customer','response'],
 response:['message','mode','intent','workflow','service','platform','description','variables'],
 workflow:['intent','field','operator','value','response','nextStep','action','stateField','stateValue','options','serviceType'],
 handoff:['intent','reason','agent','team','customerResponse'],
};
function validateRecord(input) {
  if (!fields[input.kind]) fail('Invalid record kind.');
  const data = {}; const source = input.data || {};
  for (const key of fields[input.kind]) if (source[key] !== undefined) {
    const value = source[key];
    if (['platforms','variables','options'].includes(key)) { if (!Array.isArray(value) || value.length > 20) fail('Invalid options.'); data[key] = value.map(v=>safeString(v,120)); }
    else if (['price','amount','duration','minBudget','maxBudget'].includes(key)) { if (!Number.isFinite(value) || value<0 || value>100000000) fail('Invalid numeric value.'); data[key] = value; }
    else if (['paymentEnabled','allowCustomBudget'].includes(key)) { if (typeof value !== 'boolean') fail('Invalid checkbox.'); data[key] = value; }
    else data[key] = safeString(value);
  }
  if (input.kind === 'response' && !['STRICT','FLEXIBLE','INFORMATION'].includes(data.mode)) fail('Choose a response mode.');
  if (['response','knowledge'].includes(input.kind) && /[₦$€£]\s*\d|\d[\d,]*\s*(?:naira|NGN|dollars)/i.test(data.message || data.answer || '')) fail('Use {{amount}} for prices; edit the amount in Services or Plans.');
  if (input.kind === 'service' && data.allowCustomBudget && (!(data.minBudget>=100) || !(data.maxBudget>=data.minBudget))) fail('Set valid minimum and maximum custom budgets.');
  if (['service','plan'].includes(input.kind) && (data.currency !== 'NGN' || !data.platforms?.length)) fail('Choose platforms and NGN currency.');
  if (input.kind==='service' && !['account_setup','ads_management'].includes(data.serviceType)) fail('Choose a service type.');
  if (input.kind==='plan' && (!(data.amount >= 100) || !(data.duration >= 1))) fail('Set a plan amount and duration.');
  if (input.kind==='workflow' && (!['reply','handoff'].includes(data.action) || !stateFields.includes(data.field) || !['missing','equals','present'].includes(data.operator) || data.stateField && !stateFields.includes(data.stateField))) fail('Invalid workflow action or state field.');
  if (data.intent && ![...intents,'*'].includes(data.intent) && input.kind !== 'response') fail('Invalid intent.');
  const title = safeString(input.title,160).trim(); if (!title) fail('A title is required.');
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(input.key || '')) fail('Use a unique key with letters, numbers, hyphens or underscores.');
  return {kind:input.kind,key:input.key,title,category:safeString(input.category || '',100),enabled:input.enabled !== false,archived:input.archived === true,priority:Math.max(-1000,Math.min(1000,Number(input.priority)||0)),data};
}
async function getConfig() { const row = await Config.findOne({key:'main'}).lean(); return row ? {...row,data:{...defaults.config,...row.data}} : {revision:-1,data:{...defaults.config,enabled:false}}; }
async function seed(actor) {
  await Config.updateOne({key:'main'},{$setOnInsert:{data:defaults.config,changedBy:actor,revision:0}},{upsert:true});
  for (const item of defaults.records) await Record.updateOne({kind:item.kind,key:item.key},{$setOnInsert:{...item,enabled:true,archived:false,createdBy:actor,changedBy:actor,revision:0}},{upsert:true});
}
async function catalogue() { return Record.find({enabled:true,archived:false,kind:{$ne:'knowledge'}}).sort({priority:-1,_id:1}).limit(300).lean(); }
async function knowledge(text) {
  const query = String(text).replace(/[^\p{L}\p{N}\s]/gu,' ').split(/\s+/).filter(w=>w.length>2).slice(0,20).join(' ');
  if (!query) return [];
  return Record.find({kind:'knowledge',enabled:true,archived:false,$text:{$search:query}},{score:{$meta:'textScore'}}).sort({score:{$meta:'textScore'},priority:-1}).limit(6).lean();
}
module.exports = {validateConfig,validateRecord,getConfig,seed,catalogue,knowledge,stateFields,intents};
