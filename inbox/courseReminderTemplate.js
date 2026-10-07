const policy=require('./policy');
const fail=message=>{throw Object.assign(new Error(message),{safe:true});};
// Dedicated adapter for the approved course reminder, not a general template composer.
module.exports=function courseReminderTemplate(template,invoice){
 if(!template||template.name!=='course'||template.status!=='APPROVED')fail('Sync the approved course reminder template.');
 const components=template.components||[];
 const images=components.filter(c=>c.type==='HEADER'&&c.format==='IMAGE');
 if(images.length>1)fail('Course reminder has multiple image headers.');
 const textTemplate={...template,components:components.filter(c=>!images.includes(c))};
 const fields=policy.templateFields(textTemplate);
 if(!fields||fields.some(f=>!['body.1','body.2'].includes(f.key)))fail('Course reminder contains unsupported variables or components.');
 const values={'body.1':String(invoice.customerName||'there').trim().slice(0,150)||'there','body.2':'TikTok, Facebook and Instagram Ads training'};
 const result=policy.templatePayload(textTemplate,values);
 if(images.length){
  // A durable public course image; Meta's approval sample URLs can expire.
  const link=process.env.COURSE_WHATSAPP_REMINDER_IMAGE_URL||'https://joshspotmedia.com/images/ads-course.jpg';
  let url;try{url=new URL(link);}catch{fail('Course reminder image URL is invalid.');}
  if(url.protocol!=='https:'||url.username||url.password)fail('Course reminder image must use a public HTTPS URL.');
  result.payload.components.unshift({type:'header',parameters:[{type:'image',image:{link}}]});
 }
 return result;
};
