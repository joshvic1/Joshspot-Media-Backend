// Standard text-token estimates, verified 2026-10-06 against official model pages.
// Unknown models return null (never a misleading zero). No tools carry API fees.
const rates={
 'gpt-4.1':{input:2,cached:.5,output:8},
 'gpt-4.1-mini':{input:.4,cached:.1,output:1.6},
};
function estimate(model,usage){const key=Object.keys(rates).find(k=>model===k||model===`${k}-2025-04-14`),r=rates[key];if(!r)return null;const cached=Math.min(usage.input_tokens||0,usage.cached_input_tokens||0);return Number((((usage.input_tokens||0)-cached)*r.input+cached*r.cached+(usage.output_tokens||0)*r.output).toFixed(6))/1000000;}
module.exports={estimate};
