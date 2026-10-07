// Read-only snapshot audit. No dotenv, database, OpenAI or production writes.
const fs=require('node:fs'),path=require('node:path');
const {catalogue,knowledge}=require('../inbox/ai/v3/catalogue');
async function audit(snapshot){
 const book=catalogue(snapshot.records),groups=new Map();
 for(const r of book.rows.filter(r=>r.kind==='knowledge')){const k=knowledge(r),text=(k.preferredResponse||k.facts).trim().toLowerCase();if(text)groups.set(text,[...(groups.get(text)||[]),r.key]);}
 const entries=book.rows.filter(r=>r.kind==='knowledge');
 return {source:'Prior read-only snapshot; not a fresh production query',configRevision:snapshot.config.revision,catalogueRevision:book.revision,knowledgeCount:entries.length,
  exactDuplicates:[...groups].filter(([,keys])=>keys.length>1).map(([,keys])=>({keys})),
  placeholders:entries.filter(r=>/\{\{/.test(r.data.preferredResponse||r.data.answer||'')).map(r=>({key:r.key,issue:'Legacy placeholders require trusted tools; do not output literally.'})),
  strict:entries.filter(r=>r.data.responseMode==='STRICT').map(r=>({key:r.key,wording:r.data.preferredResponse})),
  ignoredLegacyHandoffFlags:entries.filter(r=>r.data.handoffAfterReply||r.data.forceHandoff).map(r=>({key:r.key,reason:r.data.handoffReason})),
  plans:await require('../inbox/ai/v3/pricing').plans(book.rows),
  notes:['No records were edited. Semantic conflicts still require owner review.','V3 does not load response/workflow/tone records or execute legacy knowledge state updates.','Newer/higher-priority knowledge does not override service prices or verified payment.'],
 };
}
if(require.main===module){const [input,output]=process.argv.slice(2);if(!input||!output)throw new Error('Usage: node scripts/auditV3Knowledge.cjs SNAPSHOT NEW_OUTPUT');if(fs.existsSync(output))throw new Error('Refusing to overwrite an existing audit');audit(JSON.parse(fs.readFileSync(input,'utf8').replace(/^\uFEFF/,''))).then(result=>{fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2),{flag:'wx'});console.log(`Read-only audit saved: ${output}`);});}
module.exports={audit};
