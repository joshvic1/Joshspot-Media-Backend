const {createHash}=require('node:crypto');
function trustedText(invoice){return require('../invoices').trustedPaymentText(invoice,invoice.url);}
function validatePaymentResponse(response,invoice){
 const trusted=trustedText(invoice);
 // Exact canonical financial block avoids accepting a correct account number
 // alongside a second, substituted destination. Ordinary surrounding prose is
 // allowed; if it introduces extra destinations, discard the whole candidate.
 if(!response.includes(trusted))return {response:trusted,fallback:true};
 const outside=response.replace(trusted,'');
 if(/https?:\/\/|www\.|\b\d{10,}\b|account\s*(?:number|name)\s*:/i.test(outside))return {response:trusted,fallback:true};
 return {response,fallback:false};
}
async function invoiceStatus(conversationId,refresh=false){
 const Invoice=require('../../../models/Invoice');
 let row=await Invoice.findOne({inboxConversation:conversationId,deletedAt:null}).sort({createdAt:-1});
 if(!row)return {status:'NONE'};
 if(refresh)row=await require('../../../controllers/invoiceController').refreshInvoiceStatus(row,true);
 const result={id:String(row._id),amount:row.amount,status:row.status,expiresAt:row.expiresAt,quoteFingerprint:row.aiQuoteFingerprint};
 if(row.status==='pending'&&row.expiresAt>new Date()&&row.accountNumber&&row.bankName&&row.accountName&&/^https:\/\//.test(process.env.CLIENT_URL||''))Object.assign(result,{accountNumber:row.accountNumber,bankName:row.bankName,accountName:row.accountName,url:`${process.env.CLIENT_URL.replace(/\/$/,'')}/pay-invoice/${row.token}`});
 if(result.accountNumber)result.paymentText=trustedText(result);
 return result;
}
async function createInvoice({conversation,quote,config,assertCurrent}){
 if(config.mode!=='LIVE'||!config.autoReply)throw new Error('V3_LIVE_NOT_APPROVED');
 await assertCurrent();
 const existing=await invoiceStatus(conversation._id);
 if(existing.id&&(existing.quoteFingerprint!==quote.fingerprint||existing.status==='paid'||existing.status==='expired'))throw new Error('EXISTING_INVOICE_REQUIRES_REVIEW');
 // Reuse the existing generator/Paystack integration. Only its authority check
 // is supplied by V3; no duplicated account-generation or invoice schema logic.
 const generated=await require('../invoices').generate({conversation,contact:conversation.contact,config:{...config,structuredSales:false},assertCurrent,result:{engineVersion:'v3',quote,amount:quote.total,serviceKey:quote.lines.map(l=>l.serviceKey).join('+'),state:{}}});
 const row=await require('../../../models/Invoice').findOne({_id:generated.invoiceId,inboxConversation:conversation._id,deletedAt:null});
 if(!row||row.amount!==quote.total||!row.accountNumber||row.status==='paid')throw new Error('INVOICE_REQUIRES_REVIEW');
 const invoice={id:String(row._id),amount:row.amount,currency:'NGN',status:row.status,accountNumber:row.accountNumber,accountName:row.accountName,bankName:row.bankName,reference:row.reference,url:`${process.env.CLIENT_URL.replace(/\/$/,'')}/pay-invoice/${row.token}`,quoteFingerprint:quote.fingerprint};
 invoice.paymentText=trustedText(invoice);invoice.paymentDigest=createHash('sha256').update(invoice.paymentText).digest('hex');return invoice;
}
module.exports={trustedText,validatePaymentResponse,invoiceStatus,createInvoice};
