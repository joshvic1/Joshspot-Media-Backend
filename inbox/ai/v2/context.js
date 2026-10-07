const {clean}=require('./model');
const sent=m=>['sent','delivered','read'].includes(m.status);
function build({messages,text,history=[],questionMessages=[],effectMessages=[],state={},now=new Date().toISOString()}){
  const current=(messages?.length?messages:[{_id:'input',text,type:'text'}]).map((m,i)=>({id:String(m._id||m.id||`input-${i}`),text:String(m.text||''),type:m.type||'text'}));
  // Only successfully sent questions can anchor option numbers or yes/no.
  const candidates=[...history,...questionMessages].filter(m=>m.direction==='outbound'&&sent(m)&&m.automation?.question)
    .sort((a,b)=>new Date(b.sentAt||b.createdAt||0)-new Date(a.sentAt||a.createdAt||0));
  const latest=candidates[0];
  const answered=state.core?.answeredQuestions||[];
  const pendingQuestion=latest&&!answered.some(a=>a.id===String(latest._id||latest.id))?{
    ...latest.automation.question,id:String(latest._id||latest.id),text:latest.text,
    sentAt:latest.sentAt||latest.createdAt,deliveryStatus:latest.status,deliveredAt:latest.deliveredAt||null,active:true,
  }:null;
  const sentEffects=[...history,...questionMessages,...effectMessages].filter(m=>m.direction==='outbound'&&sent(m)&&m.automation?.delivery).map(m=>({id:String(m._id||m.id),effect:m.automation.delivery,sentAt:m.sentAt||m.createdAt})).sort((a,b)=>new Date(a.sentAt)-new Date(b.sentAt));
  return clean({messages:current,history:history.filter(m=>m.direction==='inbound'||sent(m)).map(m=>({id:String(m._id||m.id||''),direction:m.direction,text:m.text})),pendingQuestion,sentEffects,now});
}
module.exports={build,sent};
