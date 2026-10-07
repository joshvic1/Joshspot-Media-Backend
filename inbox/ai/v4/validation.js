// A financial boundary, not customer intent classification. Ordinary numeric
// dates/durations/counts are unrestricted; currency claims require role+value.
const rolePatterns=[['setup_fee',/setup(?:\s+(?:service|account))?\s*(?:fee|price|cost)?|account\s+setup/i],['management_fee',/management\s*(?:service\s*)?(?:fee|charge|cost)|service\s+fee|our\s+fee/i],['course_price',/course|training/i],['advertising_budget',/advertising\s*(?:spend|budget|money)|ad(?:s)?\s*(?:spend|budget|money)/i],['total',/total|altogether|all.in|package|combined/i]];
const money=/((?:₦|NGN|naira)\s*)?(\d[\d,]*(?:\.\d+)?)(\s*[kKmM])?(\s*(?:naira|NGN))?/g;
const units={zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90};
function normalizeWords(text){const words=[...Object.keys(units),'hundred','thousand','million'];const pattern=new RegExp(`\\b(?:${words.join('|')})(?:(?:[ -]+(?:and[ -]+)?)(?:${words.join('|')}))*\\b`,'gi');return text.replace(pattern,s=>{let sum=0,n=0;for(const w of s.toLowerCase().split(/[ -]+/)){if(w==='and')continue;if(w==='hundred')n=(n||1)*100;else if(w==='thousand'||w==='million'){sum+=(n||1)*(w==='thousand'?1000:1000000);n=0;}else n+=units[w];}return String(sum+n);});}
function claims(text){
 text=normalizeWords(text.normalize('NFKC'));
 const found=[];for(const m of text.matchAll(money)){
  const at=m.index,end=at+m[0].length,start=Math.max(text.lastIndexOf('\n',at),text.lastIndexOf(';',at),text.lastIndexOf('.',at))+1;const clause=text.slice(start,Math.min(...[text.indexOf('\n',end),text.indexOf(';',end),text.indexOf('.',end),text.length].filter(n=>n>=end)));
  const roles=rolePatterns.flatMap(([role,r])=>[...clause.matchAll(new RegExp(r.source,'gi'))].map(x=>({role,distance:x.index<=at-start?Math.abs(at-start-(x.index+x[0].length)):Math.abs(x.index-(end-start))+8})));
  const role=roles.sort((a,b)=>a.distance-b.distance)[0]?.role;
  if(!m[1]&&!m[3]&&!m[4]&&(!role||/\b(?:days?|weeks?|videos?|creatives?)\b/i.test(text.slice(end,end+12))))continue;
  // Bare counts in a sentence with money are not another financial claim.
  if(!m[1]&&!m[3]&&!m[4]&&Number(m[2].replace(/,/g,''))<100)continue;
  found.push({amount:Number(m[2].replace(/,/g,''))*(m[3]?.trim().toLowerCase()==='k'?1000:m[3]?.trim().toLowerCase()==='m'?1000000:1),role,clause});
 }return found;
}
function validate(output,pack,max=1500){
 const errors=[],text=output.message||'';
 if(!text.trim()||text.length>max)errors.push('RESPONSE_LENGTH');
 const ids=new Set(pack.requests.map(r=>r.id));
 if(output.covered_request_ids.some(id=>!ids.has(id))||pack.requests.some(r=>!output.covered_request_ids.includes(r.id)))errors.push('REQUEST_COVERAGE');
 if(output.questions_asked.some(q=>!pack.allowedQuestions.includes(q.field)))errors.push('QUESTION_NOT_ALLOWED');
 if(/[{}]|```|\b(?:Answer Pack|current_requests|covered_request_ids|plan_turn|calculate_ads_quote|messageId)\b/i.test(text)||[...ids].some(id=>id.length>3&&text.includes(id)))errors.push('INTERNAL_OUTPUT');
 const invoice=pack.actions.invoice||pack.actions.payment;
 const urls=[...text.matchAll(/https?:\/\/[^\s<>]+|www\.[^\s<>]+/gi)].map(m=>m[0].replace(/[.,)]$/,''));
 const allowed=[...pack.facts.filter(f=>f.role==='url').map(f=>f.value),invoice?.url].filter(Boolean);
 if(urls.some(u=>!allowed.includes(u)))errors.push('UNSUPPORTED_URL');
 const paymentBlock=invoice?.paymentText;
 const sendingPayment=!!pack.actions.invoice||pack.requests.some(r=>r.type==='ASK_PAYMENT_DETAILS');
 if(sendingPayment&&invoice?.accountNumber&&(!paymentBlock||!text.includes(paymentBlock)))errors.push('PAYMENT_DETAILS_MISMATCH');
 const prose=paymentBlock?text.replace(paymentBlock,''):text;
 if(/\b\d{10,}\b|account\s*(?:number|name)\s*:/i.test(prose))errors.push('UNTRUSTED_ACCOUNT_DETAILS');
 for(const clause of prose.split(/[.!?\n]|\bbut\b/i)){
  const negative=/\b(?:cannot|can't|not|no|never|hasn't|haven't|isn't|don't|do not)\b/i.test(clause);
  if(!pack.verifiedPayment&&!negative&&/\b(?:payment|transfer|money|funds)\b/i.test(clause)&&/\b(?:confirmed|received|verified|successful|successfully|credited|settled)\b/i.test(clause))errors.push('FALSE_PAID_CLAIM');
  if(!negative&&/\binvoice\b/i.test(clause)&&/\b(?:created|generated|sent)\b/i.test(clause)&&!pack.actions.invoice?.id&&!pack.actions.payment?.id&&!/\b(?:test|simulated|simulation|would)\b/i.test(clause))errors.push('FALSE_INVOICE_CLAIM');
  if(!negative&&/\b(?:guarantee(?:d)?|promise|definitely|surely)\b/i.test(clause)&&/\b(?:sales|views|customers|results|revenue|engagement|ROI)\b/i.test(clause))errors.push('GUARANTEED_RESULTS');
  if(!negative&&/\b(?:free|complimentary|gratis|discount(?:ed)?)\b/i.test(clause)&&!pack.facts.some(f=>f.role==='discount'||f.type==='MONEY'&&f.value===0))errors.push('UNSUPPORTED_DISCOUNT');
 }
 if((pack.actions.handoff?.accepted||pack.actions.handoff?.pending)&&(output.questions_asked.length||/[?]/.test(text)||claims(text).length))errors.push('HANDOFF_ACKNOWLEDGEMENT_ONLY');
 for(const c of claims(prose)){
  const values=pack.facts.filter(f=>f.type==='MONEY'&&f.value===c.amount&&(!c.role||f.role===c.role));
  const customer=pack.customerFacts.some(f=>f.budget?.amount===c.amount&&['advertising_budget',undefined].includes(c.role));
  if(!values.length&&!customer)errors.push('UNSUPPORTED_MONEY_ROLE');
  if(!c.role&&!customer&&new Set(values.map(f=>f.role)).size>1)errors.push('AMBIGUOUS_MONEY_ROLE');
 }
 return [...new Set(errors)];
}
module.exports={validate,claims};
