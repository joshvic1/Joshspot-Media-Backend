const {randomUUID}=require('node:crypto');
const Invoice=require('../../models/Invoice');
const invoiceService=require('../../controllers/invoiceController');
const {render,money}=require('./engine');
async function generate({conversation,contact,result,config}) {
  if(!config.invoicesEnabled || !Number.isInteger(result.amount) || result.amount<100 || result.amount>100000000) throw new Error('Invoice action not authorized');
  if(!process.env.PAYSTACK_SECRET || !/^https:\/\//.test(process.env.CLIENT_URL || '')) throw new Error('Configure Paystack and a public HTTPS CLIENT_URL');
  const key=`inbox:${conversation._id}:${result.serviceKey}:${result.amount}`;
  let invoice=await Invoice.findOne({automationKey:key});
  if(!invoice) {
    try { invoice=await Invoice.create({automationKey:key,token:randomUUID(),amount:result.amount,customerName:contact.name,customerPhone:contact.phone,customerEmail:contact.email,note:`${result.serviceKey} · Joshspot Inbox`,inboxConversation:conversation._id,inboxContact:contact._id,expiresAt:new Date(Date.now()+8*3600000)}); }
    catch(error){if(error.code!==11000)throw error;invoice=await Invoice.findOne({automationKey:key});}
  }
  if(invoice.status==='paid' || invoice.status==='expired' || invoice.expiresAt<new Date()) throw new Error('Existing invoice requires human review');
  // A lost Paystack response must never cause a second charge/account automatically.
  if(invoice.reference && !invoice.accountNumber) throw new Error('Payment account state is uncertain; human review required');
  if(!invoice.accountNumber){
    const claimed=await Invoice.findOneAndUpdate({_id:invoice._id,reference:{$exists:false},automationGenerating:{$ne:true}},{$set:{automationGenerating:true}},{returnDocument:'after'});
    if(!claimed)throw new Error('Payment account generation already claimed; human review required');
    invoice=await invoiceService.generateInvoiceTransfer(claimed);
  }
  if(!invoice.accountNumber || !invoice.bankName || !invoice.accountName) throw new Error('Payment account unavailable');
  const url=`${process.env.CLIENT_URL.replace(/\/$/,'')}/pay-invoice/${invoice.token}`;
  return {invoiceId:String(invoice._id),invoiceAmount:invoice.amount,paymentStatus:invoice.status,paymentReference:invoice.reference,response:render(config.paymentTemplate,{customer_name:contact.name || 'there',service:result.serviceKey,platform:result.state.selectedPlatform,amount:money(invoice.amount),invoice_number:invoice.token,invoice_url:url,bank_name:invoice.bankName,account_number:invoice.accountNumber,account_name:invoice.accountName,payment_account:invoice.accountNumber,agent_name:config.displayName})};
}
module.exports={generate};
