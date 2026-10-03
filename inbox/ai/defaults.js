// Initial records only. Admin edits are persisted; these values never overwrite edits.
const pack = require('./businessPack');
const config = {
  enabled: true, mode: 'DRAFT', autoReply: true, agentName: 'Joshspot Assistant', displayName: 'Joshspot Assistant', role: 'Customer service and sales', brand: 'Joshspot Media',
  tone: 'Natural, friendly, direct Nigerian-business conversational tone. Avoid corporate filler.', writingStyle: 'Short, helpful sentences. One useful question at a time.', responseLength: 'concise', emojiPreference: 'restrained', language: 'Match the customer language where supported', instructions: pack.instructions, signature: '', greeting: true,
  provider: 'openai', model: '', confidence: 0.78, maxResponseLength: 1500, maxHistory: 6, debounceSeconds: 3, responseDelaySeconds: 1, maxConsecutive: 8, maxDailyCalls: 500, maxConversationCalls: 40,
  handoffTeam: 'CSS', fallbackAgent: '', paymentAgent: '', assignment: 'least_loaded', allowReturn: true, fallbackResponse: 'Let me get someone from the team to help you with this.',
  allowedIntents: ['greeting','advertising','recommendation','requirements','ready_to_pay','request_invoice','request_account_number','payment_question','payment_sent','receipt_sent','payment_problem','human','knowledge','unknown'], disallowedIntents: [],
  businessHoursEnabled: false, timezone: 'Africa/Lagos', startHour: 8, endHour: 18, outsideHours: 'handoff', stickerAction: 'handoff', contactAction: 'handoff',
  invoicesEnabled: false, paymentTemplate: 'Pay {{amount}} for {{service}} to the account below and send your receipt after.\n\nAccount number: {{account_number}}\nBank: {{bank_name}}\nAccount name: {{account_name}}\n\nOr pay via the link below:\n{{invoice_url}}',
};
const records = [
  ...pack.knowledge, ...pack.handoffs,
  ...[['tiktok_setup','TikTok Ads Account Setup','tiktok',20000],['meta_setup','Meta Ads Account Setup','meta',30000]].map(([key,title,platform,price])=>({kind:'service',key,title,data:{platforms:[platform],serviceType:'account_setup',price,currency:'NGN',description:'Advertising account setup and guidance.',requirements:'Provide your email address. A team member will arrange secure access; do not send passwords in this chat.',paymentEnabled:true,workflow:'ads',allowCustomBudget:false}})),
  {kind:'service',key:'ads_management',title:'Ads Management',data:{platforms:['tiktok','meta'],serviceType:'ads_management',price:0,currency:'NGN',description:'We run and manage your campaign.',requirements:'A team member will guide you through delegated business/ad-account access. Do not share your personal password.',paymentEnabled:true,workflow:'ads',allowCustomBudget:false}},
  ...[[7,60000],[10,135000],[15,285000],[30,415000]].map(([duration,amount],i)=>({kind:'plan',key:`plan_${duration}`,title:`${duration} Days`,priority:10-i,data:{duration,amount,currency:'NGN',platforms:['tiktok','meta'],service:'ads_management',description:''}})),
  ...[
    ['greeting','Greeting','Hello 👋 Please let us know which of our services you’re interested in.'],
    ['platform','Ask platform','Which platform would you like to run ads on: TikTok or Meta (Facebook & Instagram)?'],
    ['service','Ask service','Would you like us to set up your {{platform}} ads account and guide you, or run the ads for you?'],
    ['budget','Ask budget','What is your ads budget?'], ['duration','Ask duration','How many days would you like the ads to run?'],
    ['quote','Service quote','{{service}} costs {{amount}}. Would you like to proceed?'],
    ['plans','Recommended plans','Here are our recommended plans:\n{{plans}}\nWhich would you prefer?'],
    ['requirements','Onboarding requirements','{{requirements}}'],
    ['email','Invoice email','Which email address should we put on your invoice?'],
  ].map(([key,title,message])=>({kind:'response',key,title,data:{message,mode:['greeting','platform','budget','duration'].includes(key)?'FLEXIBLE':'STRICT',intent:key,workflow:'ads',description:'',variables:[]}})),
  {kind:'tone',key:'friendly',title:'Simple greeting',data:{customer:'Hi',response:'Hello 👋 Please let us know which of our services you’re interested in.'}},
  ...[
    ['platform','advertising','selectedPlatform','missing','platform','ask_platform'],
    ['service','advertising','serviceType','missing','service','ask_service'],
    ['budget','advertising','budget','missing','budget','ask_budget'],
    ['duration','advertising','duration','missing','duration','ask_duration'],
  ].map(([key,intent,field,operator,response,nextStep],i)=>({kind:'workflow',key,title:`Ask ${key}`,priority:100-i,data:{intent,field,operator,value:'',response,nextStep,action:'reply',stateField:'',stateValue:'',options:[],serviceType:['budget','duration'].includes(key)?'ads_management':''}})),
];
config.paymentTemplate=pack.paymentTemplate;
config.fallbackResponse='A customer-service representative needs to review this before we continue. Please leave any relevant details here.';
module.exports = { config, records };
