const {SalesBonus}=require('./models');

const AMOUNT=1000;

function customerKey(invoice){
 const contact=String(invoice.inboxContact||'').trim();
 if(contact)return `contact:${contact}`;
 const phone=String(invoice.customerPhone||'').replace(/\D/g,'');
 return phone?`phone:${phone}`:'';
}

function eligible(invoice){
 return invoice?.status==='paid'&&invoice.generatedByRole==='SS'&&Boolean(String(invoice.generatedByStaff||'').trim())&&Boolean(customerKey(invoice));
}

// Unique invoice and customer indexes make duplicate payment callbacks harmless.
async function credit(invoice){
 if(!eligible(invoice))return {credited:false,reason:'not_eligible'};
 const customer=customerKey(invoice);
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
 const rows=await SalesBonus.aggregate([
  {$match:{staff:String(staff),paidAt:{$gte:from,$lt:to}}},
  {$group:{_id:null,amount:{$sum:'$amount'},count:{$sum:1}}},
 ]);
 return {amount:rows[0]?.amount||0,count:rows[0]?.count||0};
}

module.exports={AMOUNT,customerKey,eligible,credit,summary};
