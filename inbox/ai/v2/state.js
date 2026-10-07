const {fields}=require('./contracts'),consent=require('./consent');
const clone=v=>JSON.parse(JSON.stringify(v));
const identity=items=>JSON.stringify(items.map(({id,type,platform})=>({id,type,platform})).sort((a,b)=>a.id.localeCompare(b.id)));
function initial(old={}){
 const s=old.core?.version===2?clone(old.core):{version:2,facts:{},superseded:[],items:[],topic:'advertising',purchasePath:'advertising',answeredQuestions:[],revision:0,legacy:{selectedPlatform:old.selectedPlatform,serviceType:old.serviceType,budget:old.budget,duration:old.duration,invoiceId:old.invoiceId}};
 s.selectionVersion??=0;s.decisions||=[];s.prepared||={};s.delivered||={};s.legacy||={};
 if(s.schemaVersion!==3){
  // Old affirmative slots are not permission. Preserve an old negative hold.
  if(s.readiness==='deferred'||old.salesPaused===true)s.decisions.push({id:'legacy-hold',type:'DEFERRED',scope:'purchase',path:s.purchasePath,selectionVersion:s.selectionVersion,source:'legacy_safety_hold',order:s.decisions.length});
  if(new Set(s.items.map(x=>x.platform)).size>1&&new Set(s.items.map(x=>x.type)).size>1&&!s.items.every(x=>x.evidence)){s.legacy.items=clone(s.items);s.items=[];s.relationshipsUnresolved=true;}
 }
 s.schemaVersion=3;return s;
}
function evidenced(e,c){return Boolean(e?.text?.trim()&&c.messages.some(m=>m.id===e.messageId&&m.text.includes(e.text)));}
const valueOf=(s,f,item='global')=>s.facts[`${item}:${f}`]?.status==='CONFIRMED'?s.facts[`${item}:${f}`].value:undefined;
const effectiveValue=(s,f,item)=>valueOf(s,f,item)??valueOf(s,f);
function merge(old,i,c,records){
 const s=initial(old),accepted=[],rejected=[],changed=new Set(),before=identity(s.items),change=i.purchaseChange||{action:'none'};
 const switching=change.action!=='none'&&change.path!=='unchanged'&&change.path!==s.purchasePath&&evidenced(change.evidence,c);
 if(switching){s.savedPurchases||={};s.savedPurchases[s.purchasePath]={facts:clone(s.facts),items:clone(s.items),purchaseBudget:s.purchaseBudget,relationshipsUnresolved:s.relationshipsUnresolved};const saved=s.savedPurchases[change.path];s.facts=clone(saved?.facts||{});s.items=clone(saved?.items||[]);s.purchaseBudget=saved?.purchaseBudget;s.relationshipsUnresolved=!!saved?.relationshipsUnresolved;s.purchasePath=change.path;s.selectionVersion++;delete s.quote;}
 // Explicit relationships arrive before item-scoped facts. Never a many-to-many product.
 for(const op of i.items||[]){
  if(!evidenced(op.evidence,c)||!op.explicit||op.confidence<.85||op.confidence>1||!['tiktok','meta','none'].includes(op.platform)||!['account_setup','ads_management','course'].includes(op.serviceType)){rejected.push({item:op,reason:'Invalid item evidence'});continue;}
  const id=op.serviceType==='course'?'course':`${op.platform}:${op.serviceType}`;
  if(op.platform==='none'&&op.serviceType!=='course'){rejected.push({item:op,reason:'Platform unresolved'});continue;}
  if(op.replaces&&op.replaces!==id){s.items=s.items.filter(x=>x.id!==op.replaces);changed.add(op.replaces);}
  if(op.action==='remove'){s.items=s.items.filter(x=>x.id!==id);changed.add(id);}
  else if(!s.items.some(x=>x.id===id)){s.items.push({id,type:op.serviceType,platform:op.platform==='none'?null:op.platform,evidence:op.evidence,status:'SELECTED'});changed.add(id);}
 }
 const events=[...(i.decisions||[])];
 for(const f of i.facts||[]){
  const reject=reason=>rejected.push({field:f.field,value:f.value,reason});
  const historic=!old.core&&!['proceed','paymentRequested'].includes(f.field)&&c.history.some(m=>m.direction==='inbound'&&m.id===f.evidence.messageId&&f.evidence.text&&m.text.includes(f.evidence.text));
  if(!Object.hasOwn(fields,f.field)||!(evidenced(f.evidence,c)||historic)||!(f.confidence>=0&&f.confidence<=1)){reject('Invalid field or evidence');continue;}
  if(f.itemId&&!s.items.some(x=>x.id===f.itemId)){reject('Unknown item');continue;}
  let value=f.value;if(['platforms','services'].includes(f.field))value=[...new Set(value.split(',').map(x=>x.trim()))];if(['budget','duration'].includes(f.field))value=Number(value);
  if(fields[f.field].length&&(Array.isArray(value)?!value.length||value.some(v=>!fields[f.field].includes(v)):!fields[f.field].includes(value))){reject('Unsupported value');continue;}
  if(f.field==='budget'&&(!(value>0)||value>100000000)||f.field==='duration'&&(!Number.isInteger(value)||value<1||value>365)){reject('Out of range');continue;}
  if(f.field==='plan'&&!records.some(r=>r.kind==='plan'&&r.key===value&&r.enabled!==false)){reject('Unknown plan');continue;}
  if(i.negotiation?.value&&['budget','plan'].includes(f.field)){reject('Counteroffer is not selected budget');continue;}
  const key=`${f.itemId||'global'}:${f.field}`,prior=s.facts[key],status=f.explicit&&f.confidence>=.85?'CONFIRMED':'TENTATIVE';
  if(prior?.status==='CONFIRMED'&&(status!=='CONFIRMED'||JSON.stringify(prior.value)!==JSON.stringify(value)&&!f.correction)){reject('Replacement requires explicit correction');continue;}
  if(prior&&JSON.stringify(prior.value)!==JSON.stringify(value))s.superseded.push({...prior,field:f.field,status:'SUPERSEDED',supersededAt:c.now});
  s.facts[key]={value,status,explicit:f.explicit,confidence:f.confidence,evidence:f.evidence,at:c.now,itemId:f.itemId||null};accepted.push({field:f.field,value,status,evidence:f.evidence,itemId:f.itemId||null});
  if(status==='CONFIRMED'&&['budget','duration','budgetBasis','plan','platforms','services'].includes(f.field)&&JSON.stringify(prior?.value)!==JSON.stringify(value))changed.add(f.itemId||'global');
  if(status==='CONFIRMED'&&['proceed','paymentRequested'].includes(f.field))events.push({type:value==='no'?'DECLINED':f.field==='paymentRequested'?'PAYMENT_REQUESTED':'READY_TO_PROCEED',scope:f.itemId||'purchase',evidence:f.evidence});
 }
 // Compatibility adapter accepts only an unambiguous single axis. New model
 // contracts supply explicit items, including corrections/removals.
 if(!(i.items||[]).length&&(!s.relationshipsUnresolved||accepted.some(f=>!f.itemId&&['platforms','services'].includes(f.field)))&&(!s.items.length||accepted.some(f=>!f.itemId&&['platforms','services'].includes(f.field)))){const p=valueOf(s,'platforms')||[],t=valueOf(s,'services')||[];
  if(p.length&&t.length&&(p.length===1||t.length===1)){
   const desired=p.length===1?t.map(type=>({id:`${p[0]}:${type}`,type,platform:p[0]})):p.map(platform=>({id:`${platform}:${t[0]}`,type:t[0],platform}));
   s.items=desired.map(x=>({...s.items.find(y=>y.id===x.id),...x}));s.relationshipsUnresolved=false;
  }else if(p.length>1&&t.length>1)s.relationshipsUnresolved=true;
 }
 if((i.items||[]).length&&before!==identity(s.items)){s.relationshipsUnresolved=false;for(const [field,value]of [['platforms',[...new Set(s.items.map(x=>x.platform).filter(Boolean))]],['services',[...new Set(s.items.map(x=>x.type))]]])s.facts[`global:${field}`]={value,status:'CONFIRMED',evidence:{derivedFrom:s.items.map(x=>x.evidence)},at:c.now};}
 for(const f of accepted.filter(x=>['budget','duration','budgetBasis'].includes(x.field))){const key=`${f.itemId||'global'}:plan`;if(!accepted.some(x=>x.field==='plan'&&x.itemId===f.itemId))delete s.facts[key];}
 for(const b of i.budgets||[]){
  if(!evidenced(b.evidence,c)||!b.explicit||b.confidence<.85||b.confidence>1||!(b.amount>0&&b.amount<=100000000))continue;
  const target=b.itemId?s.items.find(x=>x.id===b.itemId):null;if(b.itemId&&!target)continue;
  if(b.kind==='COUNTEROFFER'){s.counteroffer={...b,at:c.now};continue;}
  const prior=target?.budget||s.purchaseBudget;
  if(!prior||prior.kind!==b.kind||prior.amount!==b.amount){changed.add(b.itemId||'global');if(target)delete s.facts[`${target.id}:plan`];else delete s.facts['global:plan'];}
  if(target)target.budget={...b,at:c.now};else s.purchaseBudget={...b,at:c.now};
 }
 s.selectionChanged=switching||before!==identity(s.items)||changed.size>0;
 if(s.selectionChanged){s.selectionVersion++;delete s.quote;for(const item of s.items)if(changed.has('global')||changed.has(item.id))delete item.quote;}
 if(i.topic&&i.topic!=='unchanged')s.topic=i.topic;
 if(i.deferral?.value&&evidenced(i.deferral.evidence,c))events.push({type:'DEFERRED',scope:'purchase',evidence:i.deferral.evidence});
 consent.record(s,events,c,evidenced);
 const q=c.pendingQuestion,answered=accepted.find(f=>f.status==='CONFIRMED'&&q?.fields?.includes(f.field)&&(!q.itemId||q.itemId===f.itemId));
 const selectedAnswer=q?.fields?.some(f=>['services','platforms'].includes(f))?s.items.find(item=>(!q.itemId||q.itemId===item.id)&&evidenced(item.evidence,c)):null;
 const budgetAnswer=q?.fields?.some(f=>['budget','budgetBasis'].includes(f))?[s.purchaseBudget,...s.items.filter(item=>!q.itemId||q.itemId===item.id).map(item=>item.budget)].find(b=>b&&evidenced(b.evidence,c)):null;
 const requestAnswer=(i.requests||[]).find(r=>r.type==='answer_previous_question'&&r.questionId===q?.id&&evidenced(r.evidence,c));
 if(q&&(answered||selectedAnswer||budgetAnswer||(i.recommendations||[]).some(r=>evidenced(r.evidence,c))&&q.fields?.some(f=>['budget','duration'].includes(f))||requestAnswer||events.some(e=>['DEFERRED','DECLINED'].includes(e.type))&&q.fields?.some(f=>['proceed','paymentRequested'].includes(f))))s.answeredQuestions.push({...q,id:q.id,outboundMessageId:q.id,active:false,status:'ANSWERED',evidence:answered?.evidence||selectedAnswer?.evidence||budgetAnswer?.evidence||requestAnswer?.evidence||events.at(-1)?.evidence||(i.recommendations||[])[0]?.evidence,at:c.now});
 s.recommendationRequested=(i.recommendations||[]).length>0||s.recommendationRequested;
 s.revision++;s.updatedAt=c.now;return {state:s,accepted,rejected};
}
function projection(s,old={}){
 const platforms=[...new Set(s.items.map(i=>i.platform).filter(Boolean))],services=[...new Set(s.items.map(i=>i.type))],item=s.items.length===1?s.items[0]:null,e=consent.effective(s);
 const next={...old,core:s,selectedPlatforms:platforms.length?platforms:valueOf(s,'platforms')||[],selectedPlatform:platforms.length===1?platforms[0]:!platforms.length&&valueOf(s,'platforms')?.length===1?valueOf(s,'platforms')[0]:undefined,serviceType:services.length===1?services[0]:services.includes('ads_management')?'ads_management':valueOf(s,'services')?.[0],includeSetup:services.includes('account_setup')&&services.includes('ads_management'),serviceChoiceConfirmed:services.length>0||!!valueOf(s,'services')?.length,budget:item?effectiveValue(s,'budget',item.id):s.items.length>1?undefined:valueOf(s,'budget'),budgetBasis:item?effectiveValue(s,'budgetBasis',item.id):valueOf(s,'budgetBasis'),duration:item?effectiveValue(s,'duration',item.id):undefined,recommendedPlan:item?effectiveValue(s,'plan',item.id):undefined,customerWantsToProceed:e.ready,paymentDetailsRequested:e.payment,salesPaused:e.blocked||s.purchasePath==='course',purchasePath:s.purchasePath,quotedAmount:s.quote?.amount,currentSalesStage:s.delivered.stage||'DISCOVERY'};
 const management=s.items.filter(x=>x.type==='ads_management'),relevant=management.length===1?management[0]:item;
 const typed=relevant?.budget||(management.length<=1?s.purchaseBudget:null);
 if(typed){next.budgetKind=typed.kind;next.budget=['DAILY_AD_SPEND','TOTAL_AD_SPEND'].includes(typed.kind)?typed.amount:undefined;next.budgetBasis=typed.kind==='DAILY_AD_SPEND'?'daily':typed.kind==='TOTAL_AD_SPEND'?'total':undefined;next.allInCap=typed.kind==='ALL_IN_CAP'?typed.amount:undefined;}
 else {delete next.budgetKind;delete next.allInCap;}
 next.duration=relevant?effectiveValue(s,'duration',relevant.id):undefined;next.recommendedPlan=relevant?effectiveValue(s,'plan',relevant.id):undefined;
 next.purchaseItems=clone(s.items);
 if(s.delivered.selectionVersion!==s.selectionVersion)next.currentSalesStage='DISCOVERY';
 if(!s.quote)delete next.quoteSource;
 if(s.selectionChanged&&next.invoiceId&&next.paymentStatus!=='paid'){next.previousInvoiceId=next.invoiceId;for(const k of ['invoiceId','invoiceStatus','invoiceAmount','paymentDetailsSentAt','quoteSource'])delete next[k];}
 if(next.invoiceId&&['sent','pending','prepared'].includes(next.invoiceStatus))next.currentSalesStage=s.delivered.invoiceId===next.invoiceId?'PAYMENT_PENDING':'INVOICE_PREPARED';
 if(next.paymentStatus==='paid')next.currentSalesStage='PAID';return next;
}
function adminCorrection(old,changes,actor){const now=new Date().toISOString(),id=`admin:${actor}:${now}`,text='Administrator corrected sales details.',map={selectedPlatform:'platforms',serviceType:'services',budget:'budget',duration:'duration'};return projection(merge(old,{facts:Object.entries(changes).map(([k,v])=>({field:map[k],value:String(v),itemId:'',explicit:true,confidence:1,correction:true,evidence:{messageId:id,text}})),purchaseChange:{action:'none'},topic:'unchanged'}, {messages:[{id,text}],history:[],now},[]).state,old);}
module.exports={initial,merge,projection,valueOf,effectiveValue,evidenced,adminCorrection};
