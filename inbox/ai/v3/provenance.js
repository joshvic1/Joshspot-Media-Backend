// Formatting is not financial authority. Numeric/URL output is rendered from
// typed, fetched sources; free prose cannot introduce its own numeric literals.
const moneyKeys=new Set(['price','amount','total','advertisingBudget','managementFee','serviceFee','setupFee','setupServiceFee','dailyBudget','dailyBudgetPerCreative','creativeFee','scriptSupportFee']);
const countKeys=new Set(['duration','creativeCount']);
const labels={price:'price',amount:'amount',total:'total',advertisingBudget:'advertising budget',managementFee:'management fee',serviceFee:'service fee',setupFee:'setup fee',setupServiceFee:'setup fee',dailyBudget:'daily ad spend',dailyBudgetPerCreative:'daily ad spend per creative',creativeFee:'creative fee',scriptSupportFee:'script support fee',duration:'days',creativeCount:'creatives'};
const numericWords=/\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|half|quarter|gratis|free|complimentary)\b/i;
function unsafeProse(text){
 const s=text.normalize('NFKC');
 if(/[\p{N}\p{Sc}]/u.test(s)||numericWords.test(s))return 'UNSOURCED_NUMERIC_CLAIM';
 if(/https?:|www\.|\b[a-z0-9-]+\.(?:com|net|org|ng|io)\b/i.test(s))return 'UNTRUSTED_URL';
 if(/[{}]|```|\b(?:messageId|sentAt|call_id|function_call|sourceId|tool_call|api_key)\b|\b[a-z]+_[a-z_]+\b/i.test(s))return 'INTERNAL_OUTPUT_ENVELOPE';
 return null;
}
function ledger(trace,quote,invoice){
 const sources={},values={};
 function add(id,kind,data){
  if(!data||data.ok===false)return;
  sources[id]={kind,data};let n=0;
  function walk(v,path,label){
   if(Array.isArray(v)){v.forEach((x,i)=>{if(x?.quotable!==false)walk(x,`${path}.${i}`,x?.title||label);});return;}
   if(!v||typeof v!=='object')return;
   for(const [k,x]of Object.entries(v)){
    const key=`${path}.${k}`;
    if(Number.isFinite(x)&&(moneyKeys.has(k)||countKeys.has(k))&&!(k==='price'&&x===0)){
     const token=`${id}_${n++}`;const display=moneyKeys.has(k)?`₦${x.toLocaleString('en-NG',{maximumFractionDigits:2})}`:String(x);
     values[token]={source:id,path:key,value:x,label:`${label||kind} ${labels[k]}`,text:`${label||kind} ${labels[k]}: ${display}`};
    }else if(['checkoutUrl','url'].includes(k)&&typeof x==='string'&&/^https:\/\//.test(x))values[`${id}_${n++}`]={source:id,path:key,value:x,label:'Approved link',text:x};
    else if(k==='paymentText'&&kind==='invoice')values[`${id}_${n++}`]={source:id,path:key,label:'Trusted payment instructions',text:x};
    else if(x&&typeof x==='object')walk(x,key,x.title||label);
   }
  }
  // Knowledge prose is not a price source. Values come from typed commercial data.
  if(kind!=='knowledge')walk(data,'',data.title||kind);
 }
 add('quote','quote',quote);add('invoice','invoice',invoice);
 trace.forEach((t,i)=>{if(['get_services','get_service_details','resolve_service','get_recommended_ads_plans','calculate_ads_quote','get_business_knowledge','get_invoice_status','check_payment_status','create_invoice'].includes(t.tool))add(`s${i}`,t.tool==='get_business_knowledge'?'knowledge':t.tool.includes('invoice')||t.tool.includes('payment')?'invoice':t.tool,t.result);});
 return {sources,values};
}
function render(final,book,plan){
 const fail=code=>{throw Object.assign(new Error(code),{code});};
 if(final.sources.some(id=>!book.sources[id]))fail('UNKNOWN_PROVENANCE_SOURCE');
 const seen=new Set();
 for(const c of final.coverage){
  const req=plan.requests.find(r=>r.id===c.requestId);if(!req||seen.has(c.requestId))fail('INVALID_REQUEST_COVERAGE');seen.add(c.requestId);
  if(c.sources.some(id=>!book.sources[id]))fail('UNKNOWN_PROVENANCE_SOURCE');
  if(c.status==='answered'&&['business','price','recommendation'].includes(req.kind)&&!c.sources.length)fail('BUSINESS_SOURCE_REQUIRED');
  if(c.status==='answered'&&req.kind==='business'&&req.retrievedSources?.length&&!c.sources.some(id=>req.retrievedSources.includes(id)))fail('REQUEST_SOURCE_MISMATCH');
  if(c.status!=='answered'&&!c.reason.trim())fail('MISSING_DEFERRAL_REASON');
 }
 if(seen.size!==plan.requests.length)fail('REQUEST_NOT_COVERED');
 const used=[];
 const prose=final.text.replace(/\{\{value:([\w]+)\}\}/g,(_,id)=>{const v=book.values[id];if(!v||!final.sources.includes(v.source))fail('UNTRUSTED_VALUE_REFERENCE');used.push({id,...v});return '';});
 const rejected=unsafeProse(prose);if(rejected)fail(rejected);
 const text=final.text.replace(/\{\{value:([\w]+)\}\}/g,(_,id)=>book.values[id].text);
 if(!text.trim())fail('EMPTY_REPLY');
 return {text,provenance:used,coverage:final.coverage};
}
module.exports={ledger,render,unsafeProse};
