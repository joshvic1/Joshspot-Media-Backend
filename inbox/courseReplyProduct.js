const {Message}=require('./models');
const Invoice=require('../models/Invoice');
module.exports=async function({item,conversation}){
 const payload=item.button?.payload||item.interactive?.button_reply?.id;
 if(payload==='course_reminder:whatsapp-course:0')return 'whatsapp-course';
 if(payload==='course_reminder:0')return 'ads-course';
 const query={conversation,direction:'outbound',status:{$in:['sent','delivered','read']},'courseReminder.invoice':{$exists:true}};
 if(item.context?.id)query.providerId=item.context.id;
 const reminder=await Message.findOne(query).sort({_id:-1}).lean();
 if(reminder){const invoice=await Invoice.findById(reminder.courseReminder.invoice).select('product').lean();if(invoice?.product==='whatsapp-course')return 'whatsapp-course';}
 return 'ads-course';
};
