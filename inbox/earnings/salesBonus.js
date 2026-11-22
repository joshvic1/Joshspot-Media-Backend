const {SalesBonus}=require('./models');
const Invoice=require('../../models/Invoice');

const AMOUNT=1000;
const MINIMUM_INVOICE_AMOUNT=20000;

function customerKey(invoice){
 const contact=String(invoice.inboxContact||'').trim();
 if(contact)return `contact:${contact}`;
 const phone=String(invoice.customerPhone||'').replace(/\D/g,'');
 return phone?`phone:${phone}`:'';
}

function isCoursePayment(invoice){
 return ['ads-course','whatsapp-course'].includes(String(invoice?.product||''))||String(invoice?.note||'').startsWith('Course purchase - WhatsApp:');
}

function eligible(invoice){
 return invoice?.status==='paid'&&invoice.generatedByRole==='SS'&&Number(invoice.amount)>=MINIMUM_INVOICE_AMOUNT&&!isCoursePayment(invoice)&&Boolean(String(invoice.generatedByStaff||'').trim())&&Boolean(customerKey(invoice));
}

// The first bonus release pre-dated the minimum-order rule. Remove only
// historical rows that are now explicitly ineligible, and clear the marker on
// their source invoice. This lets a later qualifying order for that same
// customer earn the single allowed bonus.
async function removeIneligible(existing){
 const rows=Array.isArray(existing)?existing:[existing];
 const invalid=rows.filter(row=>row&&(!row.invoice||!eligible(row.invoice)));
 if(!invalid.length)return 0;
 const ids=invalid.map(row=>row._id),invoiceIds=invalid.map(row=>row.invoice?._id||row.invoice).filter(Boolean);
 await SalesBonus.deleteMany({_id:{$in:ids}});
 if(invoiceIds.length)await Invoice.updateMany({_id:{$in:invoiceIds}},{$unset:{salesBonusAwardedAt:1}});
 return invalid.length;
}

// Unique invoice and customer indexes make duplicate payment callbacks harmless.
async function credit(invoice){
 if(!eligible(invoice))return {credited:false,reason:'not_eligible'};
 const customer=customerKey(invoice);
 const prior=await SalesBonus.findOne({customerKey:customer}).populate('invoice');
 if(prior){
  await removeIneligible(prior);
  if(await SalesBonus.exists({_id:prior._id}))return {credited:false,reason:'already_credited'};
 }
 try{
  const row=await SalesBonus.create({
   invoice:invoice._id,customerKey:customer,staff:String(invoice.generatedByStaff),
   amount:AMOUNT,paidAt:invoice.paidAt||new Date(),paymentProvider:invoice.paymentProvider||'',
   customerName:String(invoice.customerName||'').slice(0,150),
  });
  await invoice.constructor.updateOne({_id:invoice._id,salesBonusAwardedAt:{$exists:false}},{$set:{salesBonusAwardedAt:row.paidAt}}).catch(()=>{});
  return {credited:true,row};
 }catch(error){
  if(error?.code===11000)return {credited:false,reason:'already_credited'};
  throw error;
 }
}

async function summary(staff,from,to){
 const existing=await SalesBonus.find({staff:String(staff),paidAt:{$gte:from,$lt:to}}).populate('invoice');
 await removeIneligible(existing);
 const rows=await SalesBonus.aggregate([
  {$match:{staff:String(staff),paidAt:{$gte:from,$lt:to}}},
  {$group:{_id:null,amount:{$sum:'$amount'},count:{$sum:1}}},
 ]);
 return {amount:rows[0]?.amount||0,count:rows[0]?.count||0};
}

module.exports={AMOUNT,MINIMUM_INVOICE_AMOUNT,customerKey,isCoursePayment,eligible,credit,summary,removeIneligible};
