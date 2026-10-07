const Invoice=require('../models/Invoice');
exports.update=async(req,res)=>{
 if(!/^[a-f\d]{24}$/i.test(req.params.id))return res.status(400).json({message:'Invalid invoice.'});
 const email=String(req.body?.email ?? '').trim().toLowerCase();
 let phone=String(req.body?.phone ?? '').trim();
 if(email&&(email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))return res.status(400).json({message:'Enter a valid email address.'});
 try{if(phone)phone='+'+require('../inbox/policy').phone(phone);}catch{return res.status(400).json({message:'Enter a valid phone number, including country code.'});}
 if(!email&&!phone)return res.status(400).json({message:'Keep at least an email address or phone number.'});
 try{
  const row=await Invoice.findOneAndUpdate({_id:req.params.id,status:'paid',deletedAt:null,
   $and:['receiptClaimedAt','courseEmailClaimedAt'].map(key=>({$or:[{[key]:null},{[key]:{$lt:new Date(Date.now()-120000)}}]}))
  },{$set:{customerEmail:email,customerPhone:phone}},{new:true});
  if(!row)return res.status(409).json({message:'Invoice is unavailable, unpaid, or an email is currently being sent. Refresh and try again.'});
  return res.json({message:'Invoice contact details saved. You can now send to the corrected email.',email:row.customerEmail,phone:row.customerPhone});
 }catch{return res.status(500).json({message:'Unable to update invoice contact details.'});}
};
