const Invoice=require('../../models/Invoice');
const {Conversation}=require('../models');
const {Log,Record}=require('./models');
// Reconcile authoritative paid records, including webhook/poll updates that
// arrive when the customer does not send another message. No payment inference.
let cursor=null;
async function reconcile(configRow){
  const config=configRow.data;if(!config.structuredSales||!config.enabled||config.mode==='OFF')return;
  const page=await Conversation.find({'ai.phoneId':process.env.WHATSAPP_PHONE_NUMBER_ID,'ai.state.invoiceId':{$type:'string'},'ai.state.paymentStatus':{$ne:'paid'},...(cursor?{_id:{$gt:cursor}}:{})}).select('ai.state.invoiceId').sort({_id:1}).limit(50).lean();
  cursor=page.length===50?page.at(-1)._id:null;
  const ids=page.map(c=>c.ai.state.invoiceId).filter(id=>require('mongoose').isValidObjectId(id));
  const invoices=await Invoice.find({_id:{$in:ids},status:'paid',inboxAIHandledAt:null,deletedAt:null}).lean();
  for(const invoice of invoices){
    const c=await Conversation.findOne({_id:invoice.inboxConversation,'ai.phoneId':process.env.WHATSAPP_PHONE_NUMBER_ID,'ai.state.invoiceId':String(invoice._id),deleting:{$ne:true}}).lean();
    if(!c)continue;
    const state={...c.ai?.state,paymentStatus:'paid',invoiceStatus:'paid',currentSalesStage:'PAID',paymentVerifiedAt:new Date().toISOString(),nextObjective:'COMPLETE'};
    await require('./followups').cancel(c._id,'Payment verified');
    if(config.mode==='LIVE'&&config.autoReply&&c.ai.active!==false&&!c.assignedTo&&c.status!=='resolved'){
      const entry=await Record.findOne({kind:'knowledge',key:'payment_verified',enabled:true,archived:false}).lean();
      await require('./worker').handoff(c,{action:'handoff',handoff:'PAYMENT_VERIFIED',state,priority:true,response:entry?.data.preferredResponse},config,{'ai.version':c.ai.version,'ai.state.invoiceId':String(invoice._id),'ai.active':{$ne:false},assignedTo:null});
      if(!await Conversation.exists({_id:c._id,'ai.state.paymentStatus':'paid'}))continue;
    }else await Conversation.updateOne({_id:c._id,'ai.state.invoiceId':String(invoice._id)},{$set:{'ai.state.paymentStatus':'paid','ai.state.invoiceStatus':'paid','ai.state.currentSalesStage':'PAID','ai.state.paymentVerifiedAt':new Date().toISOString()},$inc:{revision:1}});
    await Log.create({kind:'payment',conversation:c._id,action:'verified',before:{paymentStatus:c.ai?.state?.paymentStatus},after:{invoiceId:String(invoice._id),paymentStatus:'paid'},configRevision:configRow.revision});
    await Invoice.updateOne({_id:invoice._id},{$set:{inboxAIHandledAt:new Date()}});
  }
}
module.exports={reconcile};
