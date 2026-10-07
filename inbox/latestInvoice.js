const Invoice=require('../models/Invoice');
// Match stable Inbox links and normalized complete phone numbers, never names.
module.exports=async function latestInvoice(conversation){
 const contact=conversation.contact?.phone?conversation.contact:await require('./models').Contact.findById(conversation.contact);
 const matches=[{inboxConversation:conversation._id}];
 if(contact){matches.push({inboxContact:contact._id});if(contact.phone)matches.push({customerPhone:require('./crmPhoneMatch')(contact.phone)});}
 return Invoice.findOne({deletedAt:null,$or:matches}).sort({createdAt:-1,_id:-1});
};
