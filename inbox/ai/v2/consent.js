const blocked=new Set(['DEFERRED','DECLINED']);
function effective(core){
  const scopes=core.items?.length?core.items.map(i=>i.id):['purchase'];
  const decisions=scopes.map(scope=>{
    let ready=false,payment=false,status='INTERESTED';
    for(const e of core.decisions||[]){
      if(e.path!==core.purchasePath||(!blocked.has(e.type)&&e.selectionVersion!==core.selectionVersion)||!(e.scope==='purchase'||e.scope===scope))continue;
      if(blocked.has(e.type)){ready=false;payment=false;status=e.type;}
      else if(e.type==='RESUMED'||e.type==='READY_TO_PROCEED'){ready=true;payment=false;status=e.type;}
      else if(e.type==='PAYMENT_REQUESTED'){ready=true;payment=true;status=e.type;}
    }
    return {scope,status,ready,payment};
  });
  return {ready:decisions.every(d=>d.ready),payment:decisions.every(d=>d.payment),blocked:decisions.some(d=>blocked.has(d.status)),decisions};
}
function record(core,proposals,context,evidenced){
  core.decisions||=[];
  const valid=proposals.filter(e=>e.explicit!==false&&(e.confidence??1)>=.85&&(e.confidence??1)<=1&&evidenced(e.evidence,context)&&['INTERESTED','READY_TO_PROCEED','PAYMENT_REQUESTED','DEFERRED','DECLINED','RESUMED'].includes(e.type)&&(!e.scope||e.scope==='purchase'||core.items.some(i=>i.id===e.scope)));
  valid.sort((a,b)=>context.messages.findIndex(m=>m.id===a.evidence.messageId)-context.messages.findIndex(m=>m.id===b.evidence.messageId)||context.messages.find(m=>m.id===a.evidence.messageId).text.indexOf(a.evidence.text)-context.messages.find(m=>m.id===b.evidence.messageId).text.indexOf(b.evidence.text)||Number(blocked.has(a.type))-Number(blocked.has(b.type)));
  for(const e of valid){const id=`${e.evidence.messageId}:${e.scope||'purchase'}:${e.type}:${e.evidence.text}`;if(core.decisions.some(x=>x.id===id))continue;core.decisions.push({...e,id,scope:e.scope||'purchase',path:core.purchasePath,selectionVersion:core.selectionVersion,at:context.now,order:core.decisions.length});}
  // Decisions are never inferred from informational turns or historical yes slots.
  const result=effective(core);core.readiness=result.blocked?'deferred':result.ready?'ready':'undecided';return result;
}
module.exports={effective,record};
