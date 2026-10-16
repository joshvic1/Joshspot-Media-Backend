// Owner-approved explanations; prices and URLs remain service-record facts.
const definitions=[
 {key:'v4_ads_training_details',serviceKey:'ads_video_course',title:'TikTok + Facebook + Instagram training',platforms:['TIKTOK','META','UNKNOWN'],text:'Get the course via the link below. The course shows you how to run TikTok + Facebook + Instagram ads, target the right audience, and use the right advertising strategies to work towards making sales.'},
 {key:'v4_whatsapp_training_details',serviceKey:'whatsapp_status_course',title:'WhatsApp Status adverts training',platforms:['WHATSAPP'],text:'Get the course via the link below. The course shows you how to run WhatsApp Status adverts.'}
];
function approvedRecords(records){
 return definitions.filter(d=>records.some(r=>r.key===d.serviceKey&&r.enabled!==false&&!r.archived)&&!records.some(r=>r.key===d.key)).map(d=>({kind:'knowledge',key:d.key,title:d.title,enabled:true,archived:false,priority:90,revision:1,data:{v4Topics:['ASK_COURSE_DETAILS','ASK_SERVICE_INCLUSIONS'],v4Platforms:d.platforms,v4Services:['COURSE'],facts:d.text+' This is training, not a done-for-you advertising service. Results are not guaranteed.',preferredResponse:d.text,whenToUse:'Customer wants this training or asks what this course covers. Course questions do not cancel an existing service purchase.',whenNotToUse:'Not for unrelated technical questions, payment confirmation, guarantees, or done-for-you campaigns.'}}));
}
function preferredReplies(records,facts){
 return definitions.flatMap(d=>{
  const knowledge=records.find(r=>r.key===d.key&&r.enabled!==false&&!r.archived);
  const price=facts.find(f=>f.source===d.serviceKey&&f.role==='course_price');
  const url=facts.find(f=>f.source===d.serviceKey&&f.role==='url');
  if(!knowledge||!price||!url)return [];
  return [{source:d.serviceKey,knowledge:d.key,text:`${knowledge.data.preferredResponse||knowledge.data.facts}\n\nCourse: \u20a6${Number(price.value).toLocaleString('en-NG')} only.\n\u{1f447}\n${url.value}`}];
 });
}
module.exports={definitions,approvedRecords,preferredReplies};
