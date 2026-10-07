const {randomUUID}=require('node:crypto');
// Server-owned, actor-scoped sessions. Client state can never supply a production
// conversation ID, quote or invoice. Restarts expire tests instead of attaching
// them to a customer's conversation. No database writes/financial ports here.
const sessions=new Map();
async function test({actor,body,config,records,reserveModelCall,api}){
 const now=Date.now();for(const [id,s]of sessions)if(s.expiresAt<now&&!s.busy)sessions.delete(id);
 let session=body.v4SessionId?sessions.get(body.v4SessionId):null;
 if(body.v4SessionId&&(!session||session.actor!==String(actor)))throw Object.assign(new Error('Test session expired. Reset the conversation.'),{status:409});
 if(!session){if(sessions.size>=40)throw Object.assign(new Error('Too many test sessions; try later.'),{status:429});session={id:randomUUID(),actor:String(actor),state:{},history:[],expiresAt:now+3600000};sessions.set(session.id,session);}
 if(session.busy)throw Object.assign(new Error('A test turn is already running.'),{status:409});session.busy=true;
 try{
  if(session.handedOff)throw Object.assign(new Error('Test conversation handed to a human. Reset to start a new AI conversation.'),{status:409});
  const inbound={_id:randomUUID(),direction:'inbound',type:body.type||'text',status:'received',text:body.text,createdAt:new Date().toISOString()};
  const ports={assertCurrent:async()=>{},persist:async state=>{session.state=state;},invoiceStatus:async()=>({status:body.verifiedPayment===true?'paid':'NONE',simulation:true})};
  const result=await require('./index').decide({config:{...config,mode:'DRAFT'},records,messages:[inbound],history:session.history.slice(-80),state:session.state,ports,simulation:true,reserveModelCall,api});
  session.history.push(inbound,{_id:randomUUID(),direction:'outbound',type:'text',status:'sent',text:result.response,createdAt:new Date().toISOString()});session.history=session.history.slice(-160);session.expiresAt=Date.now()+3600000;
  if(result.action==='handoff')session.handedOff=true;
  return {...result,v4SessionId:session.id,simulation:true,state:{quote:session.state.currentQuote||null},debug:{...result.debug,historyMode:'simulated delivered messages'}};
 }finally{session.busy=false;}
}
module.exports={test};
