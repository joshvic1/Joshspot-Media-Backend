// Backend catalogue metadata, not customer-phrase/intent matching.
const legacy={
 tiktok_setup_information:['ASK_REQUIREMENTS','ASK_SERVICE_INCLUSIONS','ASK_TECHNICAL_HELP'],
 meta_setup_information:['ASK_REQUIREMENTS','ASK_SERVICE_INCLUSIONS','ASK_TECHNICAL_HELP'],
 setup_vs_management:['ASK_SERVICE_INCLUSIONS'],service_difference:['ASK_SERVICE_INCLUSIONS'],
 ads_management_information:['ASK_SERVICE_INCLUSIONS'],package_inclusions_review:['ASK_SERVICE_INCLUSIONS','ASK_BREAKDOWN'],
 budget_guidance:['ASK_RECOMMENDATION'],recommended_ads_plans:['ASK_RECOMMENDATION'],
 self_managed_ads:['ASK_COURSE_DETAILS','ASK_SERVICE_INCLUSIONS'],
 tiktok_management_access:['ASK_REQUIREMENTS','ASK_TECHNICAL_HELP'],
 meta_management_access:['ASK_REQUIREMENTS','ASK_TECHNICAL_HELP']
};
function metadata(r){
 if(r.data.v4Topics?.length)return {topics:r.data.v4Topics,platforms:r.data.v4Platforms||[],services:r.data.v4Services||[],excludedServices:r.data.v4ExcludedServices||[],mandatory:!!r.data.v4Mandatory};
 const topics=legacy[r.key]||(r.title==='Expected Views / Engagement'?['ASK_EXPECTED_RESULTS']:[]);
 const platforms=r.key.startsWith('tiktok_')?['TIKTOK']:r.key.startsWith('meta_')?['META']:[];
 const services=r.key.includes('setup_information')?['ACCOUNT_SETUP']:r.key.includes('management')||r.key==='package_inclusions_review'?['ADS_MANAGEMENT']:[];
 return {topics,platforms,services,excludedServices:[],mandatory:false};
}
const platform=p=>['FACEBOOK','INSTAGRAM'].includes(p)?'META':p;
function retrieve(records,need){
 const words=new Set(need.query.toLowerCase().split(/\W+/).filter(w=>w.length>2));
 return records.filter(r=>r.kind==='knowledge'&&r.enabled!==false&&!r.archived).map(r=>({r,m:metadata(r)})).filter(({m})=>m.topics.includes(need.topic)&&(!m.platforms.length||m.platforms.includes(platform(need.platform)))&&(!m.services.length||m.services.includes(need.service))&&!m.excludedServices.includes(need.service)).map(({r,m})=>{
  const text=[r.title,r.data.purpose,r.data.facts,r.data.preferredResponse,r.data.answer].filter(Boolean).join(' ');
  return {r,m,score:(m.mandatory?10000:0)+(r.priority||0)+[...words].filter(w=>text.toLowerCase().includes(w)).length};
 }).sort((a,b)=>b.score-a.score||a.r.key.localeCompare(b.r.key)).slice(0,3).map(({r,m})=>({source:r.key,revision:r.revision,topic:need.topic,title:r.title,facts:r.data.facts||'',explanation:r.data.preferredResponse||r.data.answer||'',scope:r.data.whenToUse||'',exclusions:r.data.whenNotToUse||'',mandatory:m.mandatory})).filter(r=>(r.explanation+r.facts).trim()&&!r.explanation.includes('{{')&&!/\d[\d,]*\s*(?:NGN|naira)|[₦$€£]\s*\d/i.test(r.explanation+r.facts));
}
module.exports={retrieve,metadata,platform};
