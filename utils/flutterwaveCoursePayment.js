const axios = require('axios');
const crypto = require('node:crypto');
const Invoice = require('../models/Invoice');
const BASE = 'https://api.flutterwave.com/v3';
const headers = () => {
  if (!process.env.FLUTTERWAVE_SECRET_KEY) throw Object.assign(new Error('Course payments are not configured.'), {status:503});
  return {Authorization:`Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}`};
};
const safeEqual = (a,b) => typeof a==='string' && typeof b==='string' && a.length>0 && Buffer.byteLength(a)===Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
function matches(invoice,t) {return t?.status==='successful' && t.tx_ref===invoice.reference && t.currency==='NGN' && Number(t.amount)===invoice.amount;}
async function deliver(invoice){await require('./tiktokEvents').queueTikTokPurchase(invoice);await require('./deliverCourseEmail').queueCourseEmail(invoice);}
async function refresh(invoice,strict=false){
  if(invoice.status==='paid'){await deliver(invoice);return invoice;}
  if(!invoice.reference)return invoice;
  if(!strict && invoice.paymentCheckedAt && Date.now()-new Date(invoice.paymentCheckedAt)<15000)return invoice;
  try {
    const {data}=await axios.get(`${BASE}/transactions/verify_by_reference`,{headers:headers(),params:{tx_ref:invoice.reference},timeout:12000});
    const t=data.data;
    const update={paymentCheckedAt:new Date(),providerStatus:t?.status||'pending'};
    if(matches(invoice,t)){Object.assign(update,{status:'paid',paidAt:new Date(),flutterwaveTransactionId:String(t.id)});}
    else if(t?.status==='successful'){throw new Error('Payment verification details do not match this course invoice.');}
    else if(t?.status==='failed')update.status='failed';
    else if(invoice.expiresAt && new Date(invoice.expiresAt)<new Date())update.status='expired';
    const saved=await Invoice.findOneAndUpdate({_id:invoice._id,status:{$ne:'paid'}},{$set:update},{returnDocument:'after'});
    invoice=saved||await Invoice.findById(invoice._id);
    if(invoice.status==='paid')await deliver(invoice);
  }catch(error){
    const missing=error.response?.status===400 && /not found|no transaction/i.test(error.response?.data?.message||'');
    if(missing && strict)throw error;
    if(missing){await Invoice.updateOne({_id:invoice._id,status:{$ne:'paid'}},{$set:{paymentCheckedAt:new Date(),...(invoice.expiresAt&&new Date(invoice.expiresAt)<new Date()?{status:'expired'}:{})}});invoice=await Invoice.findById(invoice._id);}
    else if(strict)throw error;
  }
  return invoice;
}
async function generate(invoice){
  headers();
  if(invoice.accountNumber||invoice.status==='paid')return refresh(invoice);
  const reference=invoice.reference||`course-${crypto.randomUUID()}`;
  // Never retry an ambiguous POST automatically: it could create a second account.
  const claimed=await Invoice.findOneAndUpdate({_id:invoice._id,paymentProvider:'flutterwave',reference:{$exists:false},status:{$nin:['paid','expired']}},{$set:{reference,automationGenerating:true}},{returnDocument:'after'});
  if(!claimed)throw Object.assign(new Error('Payment account generation is processing or needs review.'),{status:409});
  try{
    const parts=(invoice.customerName||'Customer').trim().split(/\s+/);
    const firstName=parts.shift()||'Customer';
    const {data}=await axios.post(`${BASE}/virtual-account-numbers`,{email:invoice.customerEmail||`invoice-${invoice.token}@joshspotmedia.com`,amount:invoice.amount,currency:'NGN',tx_ref:reference,is_permanent:false,phonenumber:invoice.customerPhone,firstname:firstName,lastname:parts.join(' ')||'Customer',narration:`Joshspot Media Course - ${firstName}`,bank_code:process.env.FLUTTERWAVE_BANK_CODE||'090567'},{headers:headers(),timeout:15000});
    const a=data.data;
    const expiryText=String(a?.expiry_date||'').replace(' ','T');
    const expiry=new Date(expiryText+(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(expiryText)?'':'Z'));
    if(data.status!=='success'||!a?.account_number||!a.bank_name||!Number.isFinite(expiry.getTime())||expiry<=new Date()||!Number.isFinite(Number(a.amount))||Number(a.amount)<invoice.amount)throw new Error('Incomplete payment account response.');
    const accountName=a.account_name || (/^Please make a bank transfer to\s+/i.test(a.note||'') ? a.note.replace(/^Please make a bank transfer to\s+/i,'') : '');
    if(!accountName)throw new Error('Missing beneficiary name.');
    const saved=await Invoice.findOneAndUpdate({_id:invoice._id},{$set:{accountNumber:a.account_number,bankName:a.bank_name,accountName,transferAmount:Number(a.amount),expiresAt:expiry,flutterwaveOrderRef:a.order_ref,automationGenerating:false},$unset:{paymentError:1}},{returnDocument:'after'});
    await Invoice.updateOne({_id:invoice._id,status:{$ne:'paid'}},{$set:{status:'pending'}});
    return await Invoice.findById(saved._id);
  }catch(error){await Invoice.updateOne({_id:invoice._id},{$set:{paymentError:'ACCOUNT_GENERATION_REQUIRES_REVIEW'}});throw error;}
}
async function webhook(req,res){
  if(!safeEqual(req.headers['verif-hash'],process.env.FLUTTERWAVE_WEBHOOK_SECRET))return res.sendStatus(401);
  if(req.body?.event!=='charge.completed')return res.sendStatus(200);
  if(typeof req.body.data?.tx_ref!=='string'||!req.body.data.tx_ref)return res.sendStatus(400);
  try{
    const invoice=await Invoice.findOne({paymentProvider:'flutterwave',reference:req.body.data?.tx_ref});
    if(!invoice)return res.sendStatus(200);
    await refresh(invoice,true);return res.sendStatus(200);
  }catch{return res.sendStatus(500);}
}
module.exports={generate,refresh,webhook,matches,safeEqual};
