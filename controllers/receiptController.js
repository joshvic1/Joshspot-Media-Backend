const Invoice = require('../models/Invoice');
const { Resend } = require('resend');
const { createHash } = require('node:crypto');
const receipt = require('../utils/paymentReceipt');
exports.sendReceipt = async (req,res) => {
  if (!/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(400).json({message:'Invalid invoice.'});
  let claimed;
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice || invoice.deletedAt) return res.status(404).json({message:'Invoice not found.'});
    if (invoice.status !== 'paid') return res.status(409).json({message:'Receipts can only be sent for confirmed paid invoices.'});
    const email = String(invoice.customerEmail || req.body?.email || '').trim().toLowerCase();
    const name = String(req.body?.name ?? invoice.customerName ?? '').trim();
    if (!name || name.length > 150) return res.status(400).json({message:'Enter a customer name of up to 150 characters.'});
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({message:'Enter a valid customer email address.'});
    if (!process.env.RESEND_API_KEY) return res.status(503).json({message:'Email delivery is not configured.'});
    const now = new Date();
    claimed = await Invoice.findOneAndUpdate({_id:invoice._id,status:'paid',deletedAt:null,
      $and:[{$or:[{receiptClaimedAt:null},{receiptClaimedAt:{$lt:new Date(Date.now()-120000)}}]},
        {$or:[{receiptSentAt:null},{receiptSentAt:{$lt:new Date(Date.now()-60000)}}]}],
    },{$set:{receiptClaimedAt:now,customerEmail:email,customerName:name}},{new:true});
    if (!claimed) return res.status(429).json({message:'A receipt is being sent or was sent within the last minute. Please wait before retrying.'});
    const {data,error} = await new Resend(process.env.RESEND_API_KEY).emails.send({
      from:process.env.RESEND_FROM_EMAIL || 'Joshspot Media <booking@joshspotmedia.com>',to:email,...receipt(claimed),
    },{idempotencyKey:`receipt/${invoice._id}/${createHash('sha256').update(email).digest('hex').slice(0,20)}/${claimed.receiptSendCount || 0}`});
    if (error) throw Error('Delivery failed');
    await Invoice.updateOne({_id:invoice._id,receiptClaimedAt:now},{$set:{receiptSentAt:new Date(),receiptEmailId:data?.id || ''},$inc:{receiptSendCount:1},$unset:{receiptClaimedAt:1}});
    return res.json({message:`Receipt sent to ${email}.`,email});
  } catch {
    if (claimed) await Invoice.updateOne({_id:claimed._id,receiptClaimedAt:claimed.receiptClaimedAt},{$unset:{receiptClaimedAt:1}}).catch(()=>{});
    return res.status(502).json({message:claimed ? 'Receipt could not be sent. Customer details have been saved; please retry.' : 'Receipt could not be sent. Please retry.'});
  }
};
