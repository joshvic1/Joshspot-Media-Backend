const {createHash}=require('node:crypto');
function catalogue(records){
 const rows=records.filter(r=>r.enabled!==false&&!r.archived&&['service','plan','knowledge'].includes(r.kind));
 if(rows.length>500)throw new Error('V3_CATALOGUE_TOO_LARGE');
 const revision=createHash('sha256').update(JSON.stringify(rows.map(r=>[r.kind,r.key,r.revision,r.data]))).digest('hex');
 const index=rows.filter(r=>r.kind==='knowledge').map(r=>({key:r.key,title:r.title,category:r.category,priority:r.priority,purpose:String(r.data.purpose||r.data.semanticTrigger||r.data.question||r.title).slice(0,500)}));
 if(JSON.stringify(index).length>70000)throw new Error('V3_KNOWLEDGE_INDEX_TOO_LARGE');
 return {rows,index,revision};
}
async function load(){return require('../models').Record.find({enabled:true,archived:false,kind:{$in:['service','plan','knowledge']}}).sort({kind:1,key:1}).limit(501).lean();}
// Old STRICT flags frequently describe qualification templates. V3 treats these
// as preferred wording, not another response authority. Exact payment text is
// supplied and validated by the financial tool, never by a legacy KB template.
function knowledge(r){const d=r.data;return {key:r.key,title:r.title,priority:r.priority,revision:r.revision,purpose:d.purpose||d.semanticTrigger||d.question||'',facts:d.facts||'',preferredResponse:d.preferredResponse||d.answer||'',responseMode:'GUIDED',scope:d.whenToUse||'',exclusions:d.whenNotToUse||''};}
module.exports={catalogue,load,knowledge};
