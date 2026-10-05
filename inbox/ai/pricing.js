// The calculator module is vendored unchanged from frontend/config because the
// frontend and Railway backend deploy from separate repositories. The parity
// regression test prevents formula drift. No AI-specific financial formula.
async function calculate({platform,budget,duration,planAmount,budgetBasis='total'}) {
  if(!['tiktok','meta'].includes(platform)||!Number.isFinite(budget)||budget<=0||!Number.isInteger(duration)||duration<=0)throw new Error('Invalid calculator inputs');
  const {calculateTotal,generateBreakdownMessage,adsPricingConfig}=await import('./vendor/adsPricingConfig.mjs');
  if(planAmount!==undefined){const preset=adsPricingConfig.recommendationPresets.find(p=>p.enabled&&p.duration===duration);if(!preset)throw new Error('Plan breakdown unavailable');budget=preset.advertisingBudget;budgetBasis='total';}
  const result=calculateTotal({mode:'custom',advertisingBudget:budget,budgetType:budgetBasis,duration,requestedCreatives:1,creativeMode:'testing'});
  if(planAmount!==undefined && result.total!==planAmount)throw new Error('Plan price differs from calculator; review configuration');
  if(!result.valid)throw new Error('Calculator rejected inputs');
  return {platform,budget,duration,total:result.total,advertisingBudget:result.advertisingBudget,managementFee:result.managementFee,dailyBudget:result.dailyBudget,breakdown:generateBreakdownMessage(result)};
}
module.exports={calculate};
