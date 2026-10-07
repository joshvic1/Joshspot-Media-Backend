const {createHash}=require('node:crypto');
const reject=code=>{throw Object.assign(new Error(code),{code});};
const money=n=>Math.round(n*100)/100;
async function plans(records){
 const calculator=await import('../vendor/adsPricingConfig.mjs');
 return records.filter(r=>r.kind==='plan').map(r=>{
  const preset=calculator.adsPricingConfig.recommendationPresets.find(p=>p.enabled&&p.duration===r.data.duration);
  const breakdown=preset?calculator.calculateTotal({mode:'recommend',planKey:preset.key,requestedCreatives:calculator.adsPricingConfig.creatives.testingMax}):null;
  return {key:r.key,title:r.title,...r.data,breakdown,quotable:Boolean(breakdown?.valid&&breakdown.total===r.data.amount),...(!breakdown?.valid||breakdown.total!==r.data.amount?{error:'OWNER_DECISION_REQUIRED'}:{})};
 });
}
async function quote(items,records,now=Date.now(),purchaseCap=null){
 if(!items.length)reject('CHOOSE_SERVICE');
 if(purchaseCap!==null&&(!Number.isFinite(purchaseCap)||purchaseCap<=0))reject('INVALID_PURCHASE_CAP');
 if(items.length>1&&items.some(i=>i.budgetBasis==='ALL_IN_BUDGET')&&purchaseCap===null)reject('CLARIFY_OVERALL_CAP_AND_ALLOCATION');
 const calculator=await import('../vendor/adsPricingConfig.mjs');
 const recommended=await plans(records),seen=new Set(),lines=[];
 for(const input of items){
  const key=`${input.platform}:${input.service}`;if(seen.has(key))reject('DUPLICATE_QUOTE_ITEM');seen.add(key);
  const matches=records.filter(r=>r.kind==='service'&&r.data.serviceType===input.service&&r.data.platforms?.includes(input.platform));
  if(matches.length>1)reject('AMBIGUOUS_SERVICE_CATALOGUE');
  const service=matches[0];
  if(!service||!service.data.paymentEnabled)reject('SERVICE_UNAVAILABLE');
  if(input.service==='account_setup'){
   if(input.budget!==null||input.budgetBasis!==null||input.duration!==null||input.planKey!==null)reject('SETUP_HAS_NO_AD_BUDGET');
   if(!Number.isFinite(service.data.price)||service.data.price<=0)reject('INVALID_SERVICE_PRICE');
   lines.push({key,serviceKey:service.key,title:service.title,platform:input.platform,total:service.data.price,advertisingBudget:0,managementFee:0,setupFee:service.data.price,sourceRevision:service.revision});continue;
  }
  if(!input.budgetBasis)reject('NEEDS_BUDGET_BASIS');
  let breakdown;
  const base={mode:'custom',duration:input.duration,creativeMode:input.creativeMode,requestedCreatives:input.creatives,budgetType:'total'};
  if(input.budgetBasis==='PACKAGE'){
   const plan=recommended.find(p=>p.key===input.planKey&&p.platforms?.includes(input.platform));
   if(!plan?.quotable)reject(plan?.error||'PLAN_UNAVAILABLE');
   if(input.budget!==null||input.duration!==null&&input.duration!==plan.duration||input.creativeMode!=='testing'||input.creatives>2)reject('PACKAGE_INPUT_CONFLICT');
   breakdown=plan.breakdown;
  }else{
   if(input.planKey!==null||!Number.isInteger(input.duration)||!Number.isFinite(input.budget)||input.budget<=0)reject('NEEDS_BUDGET_AND_DURATION');
   if(input.budgetBasis==='ALL_IN_BUDGET'){
    // Invert the existing monotone calculator. Never duplicate its fee formula.
    // For individual creatives, the searched budget is per creative, not combined.
    let lo=1,hi=Math.floor(input.budget*100),best=null;
    while(lo<=hi){const mid=Math.floor((lo+hi)/2);const r=calculator.calculateTotal({...base,advertisingBudget:mid/100});if(r.valid&&r.total<=input.budget){best=r;lo=mid+1;}else hi=mid-1;}
    if(!best)reject('CAP_BELOW_MINIMUM_FEE');breakdown=best;
   }else breakdown=calculator.calculateTotal({...base,advertisingBudget:input.budget,budgetType:input.budgetBasis==='DAILY_AD_SPEND'?'daily':'total'});
  }
  if(!breakdown?.valid)reject('CALCULATOR_REJECTED_INPUT');
  lines.push({key,serviceKey:service.key,title:service.title,platform:input.platform,budgetBasis:input.budgetBasis,...breakdown,breakdownText:calculator.generateBreakdownMessage(breakdown)});
 }
 const total=money(lines.reduce((n,l)=>n+l.total,0));
 if(purchaseCap!==null&&total>purchaseCap)reject('PURCHASE_CAP_EXCEEDED');
 if(!Number.isInteger(total)||total<100||total>100000000)reject('INVOICE_AMOUNT_UNSUPPORTED');
 const fingerprint=createHash('sha256').update(JSON.stringify({items,lines,purchaseCap})).digest('hex');
 return {id:`q_${fingerprint.slice(0,24)}`,fingerprint,currency:'NGN',total,items,lines,purchaseCap,createdAt:new Date(now).toISOString(),expiresAt:new Date(now+30*60000).toISOString()};
}
module.exports={quote,plans};
