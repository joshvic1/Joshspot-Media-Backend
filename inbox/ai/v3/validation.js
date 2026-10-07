// Deliberately small financial/safety backstop, not a language interpreter.
// It catches literal financial corruption; it is NOT a proof of semantic
// groundedness. Real-model validation remains a release requirement.
function validate(response,{trace=[],quote=null,records=[],invoice=null}){
 if(/\{\{[^}]+\}\}/.test(response))return 'UNRESOLVED_TEMPLATE';
 const amounts=new Set();
 const keys=new Set(['price','amount','total','advertisingBudget','managementFee','serviceFee','setupFee','setupServiceFee','dailyBudget','dailyBudgetPerCreative','creativeFee','scriptSupportFee']);
 function collect(value){if(Array.isArray(value))return value.forEach(collect);if(value&&typeof value==='object')for(const [k,v]of Object.entries(value)){if(keys.has(k)&&Number.isFinite(v))amounts.add(Math.round(v*100)/100);else if(v&&typeof v==='object')collect(v);}}
 collect(quote);collect(invoice);
 for(const call of trace)if(['get_services','get_service_details','resolve_service','calculate_ads_quote'].includes(call.tool))collect(call.result);else if(call.tool==='get_recommended_ads_plans')collect(call.result.filter?.(r=>r.quotable)||[]);
 const money=/(?:₦|NGN\s*)\s*(\d[\d,]*(?:\.\d+)?)([kKmM])?|\b(\d[\d,]*(?:\.\d+)?)\s*(naira)\b/g;
 for(const match of response.matchAll(money)){const n=Number((match[1]||match[3]).replaceAll(',',''))*(match[2]?.toLowerCase()==='k'?1000:match[2]?.toLowerCase()==='m'?1000000:1);if(!amounts.has(Math.round(n*100)/100))return 'UNTRUSTED_AMOUNT';}
 const urls=new Set(records.filter(r=>r.kind==='service').map(r=>r.data.checkoutUrl).filter(Boolean));if(invoice?.url)urls.add(invoice.url);
 for(const match of response.matchAll(/https?:\/\/[^\s<>]+/g))if(!urls.has(match[0].replace(/[.,!?)]+$/,'')))return 'UNTRUSTED_URL';
 if(!invoice?.accountNumber&&/\b\d{10,}\b/.test(response))return 'UNTRUSTED_ACCOUNT_NUMBER';
 const paid=invoice?.status==='paid'||trace.some(c=>['check_payment_status','get_invoice_status'].includes(c.tool)&&c.result?.status==='paid');
 if(!paid&&/(?:payment|transfer|money)\s+(?:is\s+|has\s+been\s+|was\s+)?(?:confirmed|received|verified|successful)|(?:we(?:'ve| have)?\s+received\s+(?:your\s+)?(?:payment|money))/i.test(response))return 'UNVERIFIED_PAYMENT_CLAIM';
 for(const sentence of response.split(/[.!?\n]/))if(!/\b(?:not|never|cannot|can't|no)\b/i.test(sentence)&&/(?:guarantee|promise|definitely|surely).*(?:sales|customers|views|engagement|revenue|ROI|results|convert)/i.test(sentence))return 'RESULT_GUARANTEE';
 return null;
}
module.exports={validate};
