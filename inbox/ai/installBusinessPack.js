const {Config,Record,Log}=require('./models');
const settings=require('./config');
const defaults=require('./defaults');
const pack=require('./businessPack');

async function install(actor='approved-business-pack') {
  await settings.seed(actor);
  const before=await settings.getConfig();
  if(before.businessPackVersion===pack.version)return {installed:false,version:pack.version};
  // Only the explicitly approved content is updated. Prices, models, credentials,
  // rollout mode, invoice enablement and unrelated records are preserved.
  const responses=defaults.records.filter(r=>r.kind==='response' && r.key!=='email');
  for(const item of [...pack.knowledge,...pack.handoffs,...responses]) {
    const data=settings.validateRecord(item);
    await Record.updateOne({kind:item.kind,key:item.key},{$set:{...data,changedBy:actor},$setOnInsert:{createdBy:actor},$inc:{revision:1}},{upsert:true});
  }
  const data={...before.data,instructions:pack.instructions,handoffTeam:'CSS',fallbackResponse:defaults.config.fallbackResponse,paymentTemplate:pack.paymentTemplate};
  const saved=await Config.findOneAndUpdate({key:'main',revision:before.revision},{$set:{data,businessPackVersion:pack.version,changedBy:actor},$inc:{revision:1}},{returnDocument:'after'});
  if(!saved)throw new Error('Configuration changed during installation; rerun to finish.');
  await Log.create({kind:'configuration',actor,action:'install_business_pack',before:before.data,after:data,decision:{version:pack.version,knowledge:pack.knowledge.length}});
  return {installed:true,version:pack.version,knowledge:pack.knowledge.length,handoffs:pack.handoffs.length,mode:data.mode};
}
module.exports={install};
if(require.main===module){
  require('dotenv').config({path:require('node:path').join(__dirname,'../../.env'),quiet:true});
  const mongoose=require('mongoose');
  (async()=>{
    if(!process.env.MONGO_URI)throw new Error('MONGO_URI is required');
    await mongoose.connect(process.env.MONGO_URI,{autoIndex:false,serverSelectionTimeoutMS:15000});
    if(!process.argv.includes('--apply')){
      const current=await settings.getConfig();
      const staff=await require('../../models/Staff').countDocuments({role:'CSS'});
      console.log(JSON.stringify({operation:'preview',installed:current.businessPackVersion===pack.version,knowledge:pack.knowledge.length,handoffs:pack.handoffs.length,cssStaff:staff,mode:current.data.mode}));
    }else console.log(JSON.stringify(await install()));
  })().catch(()=>{console.error('Business pack installation failed; check database access and configuration.');process.exitCode=1;}).finally(()=>mongoose.disconnect());
}
