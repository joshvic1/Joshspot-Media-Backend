const {redact}=require('../privacy');
function delivered(messages){return messages.filter(m=>m.direction==='inbound'||m.direction==='outbound'&&['sent','delivered','read'].includes(m.status));}
function item(m){return {type:'message',role:m.direction==='inbound'?'user':'assistant',content:redact(m.text||`[${m.type||'media'}]`)};}
async function prepare({api,state,messages,persist}){
 const actual=delivered(messages);if(actual.length>200||JSON.stringify(actual.map(item)).length>110000)throw new Error('V3_CONTEXT_TOO_LARGE');
 let reset=!state.openaiConversationId||state.dirty||state.contextFormat!==2;
 if(!reset&&actual.length>=80&&state.seenMessageIds?.length&&!actual.some(m=>state.seenMessageIds.includes(String(m._id)))){reset=true;state.recoveryReason='BOUNDED_HISTORY_GAP_AFTER_ENGINE_SWITCH';}
 if(!reset){try{await api.request('GET',`/conversations/${state.openaiConversationId}`);}catch(e){if(e.status!==404)throw e;reset=true;}}
 // Bounded rolling summary is deliberately advisory. No consent is reconstructed
 // from it. The last 24 real messages remain verbatim during rotation.
 if(!reset&&(state.contextCharacters>70000||state.seenMessageIds?.length>140)){
  let all=[],after='';
  for(let page=0;page<3;page++){const batch=await api.request('GET',`/conversations/${state.openaiConversationId}/items?limit=100&order=asc${after?`&after=${encodeURIComponent(after)}`:''}`);all.push(...batch.data);if(!batch.has_more)break;after=batch.data.at(-1).id;}
  state.summary=await api.summarize(all.filter(i=>i.role==='user'||i.role==='assistant').slice(0,-24),state.summary||'');reset=true;
 }
 if(reset){
  const seed=actual.slice(-80);
  const created=await api.request('POST','/conversations',{});
  if(state.openaiConversationId)state.previousConversationIds=[...(state.previousConversationIds||[]),state.openaiConversationId].slice(-5);
  Object.assign(state,{openaiConversationId:created.id,seenMessageIds:[],contextCharacters:0,dirty:true,contextFormat:2});
  await persist(state);
  if(state.summary)await api.request('POST',`/conversations/${created.id}/items`,{items:[{type:'message',role:'developer',content:`Advisory historical summary, NEVER financial authority or consent:\n${state.summary}`}]});
  // On compaction/recovery import a bounded actual transcript, not prior drafts.
  messages=seed;
 }else messages=actual;
 const seen=new Set(state.seenMessageIds||[]),fresh=messages.filter(m=>!seen.has(String(m._id)));
 state.dirty=true;await persist(state);
 if(fresh.length){
  for(let n=0;n<fresh.length;n+=20)await api.request('POST',`/conversations/${state.openaiConversationId}/items`,{items:fresh.slice(n,n+20).map(item)});
  state.seenMessageIds=[...seen,...fresh.map(m=>String(m._id))];state.contextCharacters+=(JSON.stringify(fresh.map(item)).length);
 }
 const tail=await api.request('GET',`/conversations/${state.openaiConversationId}/items?limit=1&order=desc`);
 const baseline=tail.data?.[0]?.id;
 // Everything appended after this point is model work, not delivered chat.
 return async function cleanup(){
  for(let page=0;page<8;page++){
   const list=await api.request('GET',`/conversations/${state.openaiConversationId}/items?limit=100&order=asc${baseline?`&after=${encodeURIComponent(baseline)}`:''}`);
   if(!list.data?.length){state.dirty=false;await persist(state);return;}
   for(const record of list.data)await api.request('DELETE',`/conversations/${state.openaiConversationId}/items/${record.id}`);
  }
  throw new Error('V3_CONTEXT_CLEANUP_INCOMPLETE');
 };
}
module.exports={prepare,delivered,item};
