// Both paths use the same pricing rules. Recommendations only preset budget and days.
export const adsPricingConfig = {
  minimumAdBudget: 35000, // Advisory minimum retained from the old calculator.
  minimumManagementFee: 25000, roundingIncrement: 5000, scriptSupportPrice: 25000,
  // Setup price is read from the TikTok option in config/services.js, its existing source.
  budgetBands: [{below:100000,fee:25000},{below:200000,fee:30000},{below:300000,fee:50000},{below:400000,fee:65000},{below:500000,fee:80000}],
  highBudget: {threshold:500000,percentage:.20},
  durationAnchors: [{days:7,multiplier:1},{days:10,multiplier:1.15},{days:15,multiplier:1.30},{days:21,multiplier:1.50},{days:30,multiplier:1.75}],
  durationExtension: "continue-last-slope",
  creatives: {testingMax:2,individualManagementFeePerCreative:5000},
  limits: {maximumBudget:1000000000,maximumDuration:365,maximumCreatives:100},
  recommendationPresets: [
    {key:"7-days",duration:7,advertisingBudget:35000,enabled:true},
    {key:"10-days",duration:10,advertisingBudget:100000,enabled:true},
    {key:"15-days",duration:15,advertisingBudget:200000,enabled:true},
    {key:"30-days",duration:30,advertisingBudget:300000,enabled:true},
  ],
};
export const formatNaira = amount => new Intl.NumberFormat("en-NG", {style:"currency",currency:"NGN",minimumFractionDigits:0,maximumFractionDigits:2}).format(amount);
export const roundToNearest5000 = (value, c=adsPricingConfig) => Math.round((value+Number.EPSILON*value)/c.roundingIncrement)*c.roundingIncrement;
export function getBaseManagementFee(budget,c=adsPricingConfig) {
  if (!Number.isFinite(budget)||budget<=0) throw new RangeError("Enter a positive advertising budget.");
  return Math.max(c.minimumManagementFee,budget>=c.highBudget.threshold ? roundToNearest5000(budget*c.highBudget.percentage,c) : c.budgetBands.find(b=>budget<b.below).fee);
}
export function getDurationMultiplier(days,c=adsPricingConfig) {
  if (!Number.isFinite(days)||days<=0) throw new RangeError("Enter a positive number of days.");
  const anchors=c.durationAnchors;
  if(days<=anchors[0].days) return anchors[0].multiplier;
  for(let i=1;i<anchors.length;i++) {
    const a=anchors[i-1],b=anchors[i];
    if(days<=b.days) return a.multiplier+(days-a.days)/(b.days-a.days)*(b.multiplier-a.multiplier);
  }
  const last=anchors.at(-1),previous=anchors.at(-2);
  return c.durationExtension==="continue-last-slope" ? last.multiplier+(days-last.days)*(last.multiplier-previous.multiplier)/(last.days-previous.days) : last.multiplier;
}
export const calculateActualAdBudget=(budget,mode,count)=>mode==="individual"?budget*count:budget;
export const calculateIndividualCreativeFee=(mode,count,c=adsPricingConfig)=>mode==="individual"?count*c.creatives.individualManagementFeePerCreative:0;
export const getManagementFee=(budget,days,c=adsPricingConfig)=>Math.max(c.minimumManagementFee,roundToNearest5000(getBaseManagementFee(budget,c)*getDurationMultiplier(days,c),c));
const supplied=value=>value!==undefined&&value!==null&&String(value).trim()!=="";
const number=value=>supplied(value)?Number(value):NaN;
const moneyValid=(value,min,max)=>Number.isFinite(value)&&value>=min&&value<=max&&Math.abs(value*100-Math.round(value*100))<.0001;
export function calculateTotal(input,c=adsPricingConfig) {
  const mode=input.mode||"custom",creativeMode=input.creativeMode||"testing";
  const plan=mode==="recommend"?c.recommendationPresets.find(p=>p.key===input.planKey&&p.enabled):null;
  const errors={};
  if(!["custom","recommend"].includes(mode)) errors.mode="Choose recommended or custom pricing.";
  if(mode==="recommend"&&!plan) errors.plan="Choose an available plan.";
  if(!["testing","individual"].includes(creativeMode)) errors.creativeMode="Choose how to advertise the videos.";
  const overrides=mode==="custom"?{advertisingBudget:input.overrideAdvertisingBudget,duration:input.overrideDuration,requestedCreatives:input.overrideCreativeLimit,managementFee:input.overrideManagementFee}:{};
  const effective=(key,fallback)=>supplied(overrides[key])?overrides[key]:fallback;
  const duration=number(plan?plan.duration:effective("duration",input.duration));
  const budgetType=plan?"total":input.budgetType||"total";
  if(!["daily","total"].includes(budgetType)) errors.budget="Choose daily or total advertising budget.";
  const enteredBudget=number(input.advertisingBudget);
  const hasBudgetOverride=supplied(overrides.advertisingBudget);
  // Normalize daily input to a campaign budget before applying the unchanged pricing rules.
  const baseAdBudget=plan?plan.advertisingBudget:hasBudgetOverride?number(overrides.advertisingBudget):budgetType==="daily"?Math.round(enteredBudget*duration*100)/100:enteredBudget;
  if(!plan&&!hasBudgetOverride&&!moneyValid(enteredBudget,.01,c.limits.maximumBudget)) errors.budget="Enter a positive budget with at most 2 decimal places.";
  const creativeCount=number(effective("requestedCreatives",input.requestedCreatives??1));
  if(!moneyValid(baseAdBudget,.01,c.limits.maximumBudget)) errors.budget=`Enter a budget above ₦0, up to ${formatNaira(c.limits.maximumBudget)}, with at most 2 decimal places.`;
  if(!Number.isInteger(duration)||duration<1||duration>c.limits.maximumDuration) errors.duration=`Choose a whole number from 1 to ${c.limits.maximumDuration} days.`;
  if(!Number.isInteger(creativeCount)||creativeCount<1||creativeCount>c.limits.maximumCreatives) errors.creatives=`Choose between 1 and ${c.limits.maximumCreatives} videos.`;
  else if(creativeMode==="testing"&&creativeCount>c.creatives.testingMax) errors.creatives=`Testing supports up to ${c.creatives.testingMax} videos. Switch to individual ads for more.`;
  const advertisingBudget=Math.round(calculateActualAdBudget(baseAdBudget,creativeMode,creativeCount)*100)/100;
  if(Number.isFinite(advertisingBudget)&&advertisingBudget>c.limits.maximumBudget) errors.budget=`Combined advertising budget must not exceed ${formatNaira(c.limits.maximumBudget)}.`;
  const manual=supplied(overrides.managementFee);
  if(manual&&!moneyValid(number(overrides.managementFee),c.minimumManagementFee,c.limits.maximumBudget)) errors.management=`Management must be between ${formatNaira(c.minimumManagementFee)} and ${formatNaira(c.limits.maximumBudget)}, with at most 2 decimal places.`;
  const setupServiceFee=input.setupFee===undefined?0:number(input.setupFee);
  if(!moneyValid(setupServiceFee,0,c.limits.maximumBudget)) errors.setup="Check the setup fee.";
  if(Object.keys(errors).length) return {valid:false,errors};
  const baseManagementFee=getBaseManagementFee(advertisingBudget,c);
  const durationMultiplier=getDurationMultiplier(duration,c);
  const calculatedManagementFee=getManagementFee(advertisingBudget,duration,c);
  const managementFee=manual?number(overrides.managementFee):calculatedManagementFee;
  const creativeFee=calculateIndividualCreativeFee(creativeMode,creativeCount,c),serviceFee=managementFee+creativeFee;
  const scriptSupportFee=input.needsScriptSupport?c.scriptSupportPrice:0,addOnsTotal=scriptSupportFee+setupServiceFee;
  const total=Math.round((advertisingBudget+serviceFee+addOnsTotal)*100)/100;
  return {valid:true,errors:{},mode,creativeMode,baseAdBudget,advertisingBudget,duration,creativeCount,baseManagementFee,durationMultiplier,calculatedManagementFee,managementFee,creativeFee,serviceFee,scriptSupportFee,setupServiceFee,addOnsTotal,total,dailyBudget:advertisingBudget/duration,dailyBudgetPerCreative:baseAdBudget/duration,
    manualAdjustment:Object.values(overrides).some(supplied),
    warnings:[
      ...(baseAdBudget<c.minimumAdBudget?[`This budget is below the usual ${formatNaira(c.minimumAdBudget)} starting point.`]:[]),
      ...(mode==="custom"&&duration<c.durationAnchors[0].days?["Campaigns under 7 days use the 7-day minimum management pricing."]:[]),
      ...(mode==="custom"&&duration>c.durationAnchors.at(-1).days?["Beyond 30 days, the final duration slope continues."]:[]),
    ],
  };
}
const plural=(count,unit)=>`${count} ${unit}${count===1?"":"s"}`;
const creativeMessage=r=>r.creativeMode==="individual"
  ? `We will advertise ${plural(r.creativeCount,"video")} individually, each with its own advertising budget.`
  : `You can use up to ${plural(r.creativeCount,"video")} for the ads.`;
const managementMessage=r=>`Throughout ${r.duration===1?"the day":"the "+plural(r.duration,"day")}, we will create and manage the ads for you, monitor the ads, make targeting adjustments and retarget where necessary.`;
const addOnMessage=r=>[r.scriptSupportFee?`Content script support: ${formatNaira(r.scriptSupportFee)}.`:"",r.setupServiceFee?`TikTok Ads Manager setup: ${formatNaira(r.setupServiceFee)}.`:""].filter(Boolean).join("\n");
export function generateSimpleMessage(r) {
  if(!r.valid) return "";
  const extras=[r.scriptSupportFee&&"content script support",r.setupServiceFee&&"TikTok Ads Manager setup"].filter(Boolean);
  return `This will cost you a total of ${formatNaira(r.total)}.\n\nThis includes us managing your ads for ${plural(r.duration,"day")}. ${creativeMessage(r)}${extras.length?"\n\nThis also includes "+extras.join(" and ")+".":""}\n\n${managementMessage(r)}`;
}
export function generateBreakdownMessage(r) {
  if(!r.valid) return "";
  const spend=r.creativeMode==="individual"
    ? `Each video will have an advertising budget of ${formatNaira(r.baseAdBudget)} for ${plural(r.duration,"day")}, making the total advertising budget ${formatNaira(r.advertisingBudget)} for ${plural(r.creativeCount,"video")}.`
    : `We will run approximately ${formatNaira(r.dailyBudget)} daily for ${plural(r.duration,"day")} (${formatNaira(r.advertisingBudget)} advertising budget).`;
  return `Here's a breakdown:\n\n${spend}\n\nOur service fee for helping you run and manage the ads is ${formatNaira(r.serviceFee)}.\n\n${creativeMessage(r)}${addOnMessage(r)?"\n\n"+addOnMessage(r):""}\n\nTotal amount: ${formatNaira(r.total)}\n\n${managementMessage(r)}`;
}
export function getRecommendedPlans(c=adsPricingConfig) {
  return c.recommendationPresets.filter(p=>p.enabled).map(p=>{
    const quote=calculateTotal({mode:"recommend",planKey:p.key,requestedCreatives:c.creatives.testingMax},c);
    return {...p,managementFee:quote.managementFee,totalPrice:quote.total};
  });
}
export function generateRecommendationGuide({setupFee=0,needsScriptSupport=false}={},c=adsPricingConfig) {
  const extras=setupFee+(needsScriptSupport?c.scriptSupportPrice:0);
  return `Not sure how much to start with? You can choose one of these plans:\n\n${getRecommendedPlans(c).map(p=>`${p.duration} days — ${formatNaira(p.totalPrice+extras)}`).join("\n")}\n\nEach plan lets you test up to ${c.creatives.testingMax} videos together. The platform prioritizes performance; equal spend or delivery is not guaranteed.${setupFee?"\n\nThese prices include TikTok Ads Manager setup.":""}${needsScriptSupport?"\n\nThese prices include content script support.":""}\n\nWant each video advertised separately? We can quote that too. Each video gets its own budget, with an extra management fee.\n\nYou can also choose your own advertising budget and number of days. Results depend on your audience, content and offer, as well as budget.\n\nLet me know which option works for you.`;
}


