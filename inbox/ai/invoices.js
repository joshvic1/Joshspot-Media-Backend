const {randomUUID}=require('node:crypto');
const Invoice=require('../../models/Invoice');
const invoiceService=require('../../controllers/invoiceController');
const {render,money}=require('./engine');
async function generate({conversation,contact,result,config,assertCurrent=async()=>{}}) {
  if(!config.invoicesEnabled || !Number.isInteger(result.amount) || result.amount<100 || result.amount>100000000) throw new Error('Invoice action not authorized');
  if(!process.env.PAYSTACK_SECRET || !/^https:\/\//.test(process.env.CLIENT_URL || '')) throw new Error('Configure Paystack and a public HTTPS CLIENT_URL');
  const v2=result.state.core?.version===2;
  const v4=result.engineVersion==='v4',v3=result.engineVersion==='v3'||v4;
  if(v3){if(process.env[v4?'AI_V4_LIVE_APPROVED':'AI_V3_LIVE_APPROVED']!=='1'||config.mode!=='LIVE'||result.quote?.total!==result.amount||!result.quote?.fingerprint)throw new Error('V3 invoice authorization missing');await assertCurrent();}
  if(v2){const current=require('./v2/consent').effective(result.state.core);if(!current.ready||!current.payment||current.blocked)throw new Error('Current purchase consent was revoked');await assertCurrent();}
  if(v2&&(!result.state.customerWantsToProceed||!result.state.paymentDetailsRequested||result.state.quotedAmount!==result.amount))throw new Error('V2 purchase consent or quote missing');
  const fingerprint=v2?require('node:crypto').createHash('sha256').update(JSON.stringify(result.state.core.quote?.items||[])).digest('hex').slice(0,24):'';
  const key=`inbox:${conversation._id}:${result.serviceKey}:${result.amount}${config.structuredSales?`:${result.state.selectedPlatform}:${result.state.duration||0}:${result.state.budget||0}:${result.state.recommendedPlan||''}`:''}${v2?`:v2:${fingerprint}`:''}${v3?`:${v4?'v4':'v3'}:${result.quote.fingerprint}`:''}`;
  if(config.structuredSales&&(!result.state.customerWantsToProceed||!result.state.paymentDetailsRequested||result.state.quotedAmount!==result.amount))throw new Error('Purchase intent or quote is missing');
  let invoice=config.structuredSales&&result.state.invoiceId?await Invoice.findOne({_id:result.state.invoiceId,inboxConversation:conversation._id,amount:result.amount,deletedAt:null}):null;
  invoice=invoice||await Invoice.findOne({automationKey:key});
  if(config.structuredSales&&invoice&&(invoice.status==='expired'||invoice.expiresAt<new Date())){
    if(invoice.automationGenerating&&!invoice.accountNumber)throw new Error('Previous payment account creation needs review');
    invoice=await invoiceService.refreshInvoiceStatus(invoice,true);
    if(invoice.status!=='expired')throw new Error('Previous invoice is not confirmed expired');
    // Preserve the expired financial record. Releasing only its unique automation
    // key allows one replacement under concurrent retries.
    await Invoice.updateOne({_id:invoice._id,status:'expired',automationKey:key},{$set:{automationKey:`${key}:expired:${invoice._id}`}});
    invoice=await Invoice.findOne({automationKey:key});
  }
  if(!invoice) {
    if(v2||v3)await assertCurrent();
    try { invoice=await Invoice.create({automationKey:key,...(v3?{aiQuoteFingerprint:result.quote.fingerprint}:{}),token:randomUUID(),amount:result.amount,customerName:contact.name,customerPhone:contact.phone,customerEmail:contact.email,note:`${result.serviceKey} · Joshspot Inbox`,inboxConversation:conversation._id,inboxContact:contact._id,expiresAt:new Date(Date.now()+8*3600000)}); }
    catch(error){if(error.code!==11000)throw error;invoice=await Invoice.findOne({automationKey:key});}
  }
  if(invoice.status==='paid' || invoice.status==='expired' || invoice.expiresAt<new Date()) throw new Error('Existing invoice requires human review');
  // A lost Paystack response must never cause a second charge/account automatically.
  if(invoice.reference && !invoice.accountNumber) throw new Error('Payment account state is uncertain; human review required');
  if(!invoice.accountNumber){
    if(v2||v3)await assertCurrent();
    const claimed=await Invoice.findOneAndUpdate({_id:invoice._id,reference:{$exists:false},automationGenerating:{$ne:true}},{$set:{automationGenerating:true}},{returnDocument:'after'});
    if(!claimed)throw new Error('Payment account generation already claimed; human review required');
    if(v3)await assertCurrent();
    invoice=await invoiceService.generateInvoiceTransfer(claimed);
  }
  if(!invoice.accountNumber || !invoice.bankName || !invoice.accountName) throw new Error('Payment account unavailable');
  const url=`${process.env.CLIENT_URL.replace(/\/$/,'')}/pay-invoice/${invoice.token}`;
  if(v2)return {invoiceId:String(invoice._id),invoiceAmount:invoice.amount,invoiceStatus:'prepared',paymentStatus:invoice.status,currentSalesStage:'INVOICE_PREPARED',paymentDetailsRequested:false,paymentReference:invoice.reference,response:trustedPaymentText(invoice,url)};
  return {invoiceId:String(invoice._id),invoiceAmount:invoice.amount,invoiceStatus:'sent',paymentStatus:invoice.status,currentSalesStage:'PAYMENT_PENDING',paymentDetailsRequested:false,paymentDetailsSentAt:new Date().toISOString(),paymentReference:invoice.reference,response:render(config.paymentTemplate,{customer_name:contact.name || 'there',service:result.serviceKey,platform:result.state.selectedPlatform,amount:money(invoice.amount),invoice_number:invoice.token,invoice_url:url,bank_name:invoice.bankName,account_number:invoice.accountNumber,account_name:invoice.accountName,payment_account:invoice.accountNumber,agent_name:config.displayName})};
}
// V2 financial/destination text is built solely from the persisted payment result.
// Legacy editable templates remain available to V1, not as V2 financial authority.
function trustedPaymentText(invoice,url){return `Pay ${money(invoice.amount)} to the account below and send your receipt afterward.\n\nAccount number: ${invoice.accountNumber}\nBank: ${invoice.bankName}\nAccount name: ${invoice.accountName}\n\nOr pay through your invoice link below:\n${url}`;}
module.exports={generate,trustedPaymentText};
