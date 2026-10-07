const {Template,Contact}=require('../models');
module.exports=async function manualReminderTemplate(conversation){
 const template=await Template.findOne({name:'payment_reminder',language:'en',status:'APPROVED'}).lean();
 if(!template)throw new Error('Sync the approved English payment_reminder template.');
 const contact=conversation.contact?.name?conversation.contact:await Contact.findById(conversation.contact);
 const name=String(contact?.name||'there').trim().slice(0,120)||'there';
 const components=[];const preview=[];
 for(const c of template.components||[]){
  if(!['HEADER','BODY','FOOTER'].includes(c.type)||(c.type==='HEADER'&&c.format!=='TEXT'))throw new Error('Payment reminder template components changed; review required.');
  const variables=[...String(c.text||'').matchAll(/\{\{([^}]+)\}\}/g)].map(m=>m[1]);
  if(variables.some(v=>v!=='customer_name'))throw new Error('Payment reminder has an unconfigured variable.');
  if(variables.length)components.push({type:c.type.toLowerCase(),parameters:[{type:'text',parameter_name:'customer_name',text:name}]});
  preview.push(String(c.text||'').replace(/\{\{customer_name\}\}/g,name));
 }
 return {payload:{name:template.name,language:{code:template.language},components},preview:preview.filter(Boolean).join('\n')};
};
