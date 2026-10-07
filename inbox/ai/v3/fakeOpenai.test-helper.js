// In-memory fake of the HTTP surface; never imports an SDK or sends a request.
function fakeOpenai(responses=[]){
 const conversations=new Map(),requests=[];let serial=0,round=0;
 const api={model:'mock-no-network',requests,conversations,
  async request(method,path,body){
   requests.push({method,path,body});const url=new URL('https://local.test'+path),parts=url.pathname.split('/').filter(Boolean);
   if(method==='POST'&&parts.length===1){const id='conv_'+(++serial);conversations.set(id,[]);return {id};}
   const items=conversations.get(parts[1]);if(!items)throw Object.assign(new Error('missing'),{status:404});
   if(parts.length===2)return {id:parts[1]};
   if(method==='DELETE'){const n=items.findIndex(i=>i.id===parts[3]);if(n>=0)items.splice(n,1);return {deleted:true};}
   if(method==='POST'){const added=body.items.map(i=>({...i,id:'item_'+(++serial)}));items.push(...added);return {data:added};}
   let list=[...items];if(url.searchParams.get('after'))list=list.slice(list.findIndex(i=>i.id===url.searchParams.get('after'))+1);
   if(url.searchParams.get('order')==='desc')list.reverse();const limit=Number(url.searchParams.get('limit')||100);return {data:list.slice(0,limit),has_more:list.length>limit};
  },
  async response(body){requests.push({response:body});const items=conversations.get(body.conversation);if(items)items.push(...(body.input||[]).map(i=>({...i,id:'item_'+(++serial)})));
   // Legacy orchestration fixtures get an explicit synthetic social plan. This
   // is NOT language interpretation; semantic contract tests supply their own.
   const planned=body.tool_choice?.name==='plan_turn';
   let result;
   if(planned&&!responses[round]?.output?.some(o=>o.name==='plan_turn')){
    const meta=JSON.parse(body.input.find(i=>i.role==='developer').content);const latest=meta.evidenceMessages.at(-1);
    result={output:[{type:'function_call',name:'plan_turn',call_id:'plan_mock',arguments:JSON.stringify({requests:[{id:'r',kind:'social',question:'Synthetic fixture',evidence:{messageId:latest.id,quote:latest.text},knowledgeKeys:[],serviceKeys:[],plans:false}],purchaseChange:'keep',purchase:[],quoteChange:'keep',payment:'none',paymentEvidence:null})}]};
   }else{const supplied=responses[round++];result=typeof supplied==='function'?await supplied(body):supplied||{output:[{type:'message',content:[{type:'output_text',text:'What would you like help with?'}]}]};}
   if(result.output?.some(o=>o.type==='message')){const text=result.output.flatMap(o=>o.content||[]).map(c=>c.text||'').join('');result={output:[{type:'function_call',name:'finish_response',call_id:'finish_mock',arguments:JSON.stringify({text,sources:[],questions:[],coverage:[{requestId:'r',status:'answered',sources:[],reason:''}]})}]};}
   if(items)items.push(...(result.output||[]).map(i=>({...i,id:'item_'+(++serial)})));return result;
  },
  authorizePayment:async()=>({decision:'NEEDS_CONFIRMATION'}),summarize:async()=> 'Advisory summary of earlier delivered messages.',
 };
 return api;
}
module.exports={fakeOpenai};
