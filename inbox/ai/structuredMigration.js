const {Config,Record,Log}=require('./models');
const {seeds}=require('./structuredKnowledge');
const version='structured-sales-v1';
async function preview(){
  const records=await Record.find({}).lean();
  return {version,alreadyApplied:Boolean(await Log.exists({action:version})),preservedRecords:records.length,
    newKeys:seeds.filter(s=>!records.some(r=>r.kind===s.kind&&r.key===s.key)).map(s=>s.key),
    needsReview:records.filter(r=>['knowledge','response','workflow'].includes(r.kind)&&!r.data?.schemaVersion).map(r=>({id:r._id,key:r.key,kind:r.kind})),
    rollout:'Existing mode and ownership remain unchanged. Structured engine is opt-in; start in DRAFT.'};
}
async function apply(actor){
  const report=await preview();
  const config=await Config.findOne({key:'main'}).lean();
  if(!config)throw Object.assign(new Error('Initialize the agent first.'),{status:400});
  // Audit metadata is written before inserts. Existing content stays in its
  // original records; never copy a potentially sensitive legacy document into logs.
  if(!report.alreadyApplied)await Log.create({kind:'migration',action:version,actor,before:{configRevision:config.revision,mode:config.data?.mode,recordCount:report.preservedRecords,legacyDocumentPreserved:true},after:report});
  for(const seed of seeds)await Record.updateOne({kind:seed.kind,key:seed.key},{$setOnInsert:{...seed,createdBy:actor,changedBy:actor,revision:0}},{upsert:true});
  // Inactive structured seeds cannot affect the legacy runtime. Do not invalidate
  // its queued messages, or bump revisions on an idempotent rerun.
  if(report.newKeys.length&&config.data?.structuredSales)await Config.updateOne({key:'main'},{$inc:{revision:1}});
  return report;
}
module.exports={preview,apply};
