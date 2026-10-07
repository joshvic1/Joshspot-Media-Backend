function reconcile(core,context){
 for(const message of context.sentEffects||[]){const effect=message.effect;if(effect.selectionVersion!==core.selectionVersion||!effect.stage)continue;
  core.delivered||={};if(core.delivered.at&&new Date(core.delivered.at)>new Date(message.sentAt))continue;
  core.delivered={...core.delivered,...Object.fromEntries(Object.entries(effect).filter(([,v])=>v!=null)),at:message.sentAt,outboundMessageId:message.id};
 }
}
async function record(message){
 if(!message.automation?.delivery?.stage)return;
 const {Conversation}=require('../../models'),e=message.automation.delivery;
 if(message.status==='failed'){
  await Conversation.updateOne({_id:message.conversation,'ai.state.core.delivered.outboundMessageId':String(message._id),'ai.state.paymentStatus':{$ne:'paid'}},{$unset:{'ai.state.core.delivered':1,...(e.invoiceId?{'ai.state.paymentDetailsSentAt':1}:{})},$set:{'ai.state.currentSalesStage':e.invoiceId?'INVOICE_PREPARED':'DISCOVERY',...(e.invoiceId?{'ai.state.invoiceStatus':'prepared'}:{})}});return;
 }
 if(!['sent','delivered','read'].includes(message.status))return;
 const at=new Date(message.sentAt||message.createdAt).toISOString();
 const set=Object.fromEntries(Object.entries({...e,at,outboundMessageId:String(message._id)}).filter(([,v])=>v!=null).map(([k,v])=>[`ai.state.core.delivered.${k}`,v]));
 if(e.stage)set['ai.state.currentSalesStage']=e.stage;
 if(e.invoiceId){set['ai.state.invoiceStatus']='sent';set['ai.state.paymentDetailsSentAt']=at;}
 await Conversation.updateOne({_id:message.conversation,'ai.state.core.version':2,'ai.state.core.selectionVersion':e.selectionVersion,'ai.state.paymentStatus':{$ne:'paid'},$or:[{'ai.state.core.delivered.at':{$exists:false}},{'ai.state.core.delivered.at':{$lte:at}}]},{$set:set});
}
module.exports={reconcile,record};
