const pricing=require('../pricing');
const {effectiveValue}=require('./state');
function meaning(core,item){
 if(item.budget)return item.budget;if(core.purchaseBudget)return core.purchaseBudget;
 const amount=effectiveValue(core,'budget',item.id),basis=effectiveValue(core,'budgetBasis',item.id);
 return amount?{amount,kind:basis==='daily'?'DAILY_AD_SPEND':basis==='total'?'TOTAL_AD_SPEND':'UNRESOLVED',itemId:null}:null;
}
async function withinCap(platform,duration,cap){
 // Search inputs to the EXISTING monotonic calculator; never duplicate fee formulas.
 if(!Number.isFinite(cap)||cap<=0)return null;
 let lo=1,hi=Math.floor(cap),best=null;
 while(lo<=hi){const amount=Math.floor((lo+hi)/2),quote=await pricing.calculate({platform,budget:amount,duration,budgetBasis:'total'});if(quote.total<=cap){best=quote;lo=amount+1;}else hi=amount-1;}
 return best;
}
module.exports={meaning,withinCap};
