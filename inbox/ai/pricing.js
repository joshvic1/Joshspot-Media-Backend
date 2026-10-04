// The calculator module is vendored unchanged from frontend/config because the
// frontend and Railway backend deploy from separate repositories. The parity
// regression test prevents formula drift. No AI-specific financial formula.
async function calculate({platform,budget,duration}) {
  if(!['tiktok','meta'].includes(platform)||!Number.isFinite(budget)||budget<=0||!Number.isInteger(duration)||duration<=0)throw new Error('Invalid calculator inputs');
  const {calculateTotal}=await import('./vendor/adsPricingConfig.mjs');
  const result=calculateTotal({mode:'custom',advertisingBudget:budget,duration,requestedCreatives:1,creativeMode:'testing'});
  if(!result.valid)throw new Error('Calculator rejected inputs');
  return {platform,budget,duration,total:result.total,advertisingBudget:result.advertisingBudget,managementFee:result.managementFee};
}
module.exports={calculate};
