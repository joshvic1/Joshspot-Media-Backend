const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const mongoose=require('mongoose');
const changes={
 tiktok_setup:{requirements:'Provide your email address. The team will guide you through the approved account-access process. Do not send passwords or verification codes in this chat.'},
 meta_setup:{requirements:'The team will guide you through the appropriate Meta business or advertising-account access process. Do not send your personal Facebook password or verification codes.'},
 ads_management:{requirements:'Confirm your advertising platform, budget and campaign duration. The team will guide you through the approved advertising-account access process. Do not send passwords or verification codes.'},
 ads_management_details:{preferredResponse:'What is your daily advertising budget, and how many days would you like to run the ads for?'},
 ads_budget:{preferredResponse:'What is your daily advertising budget?'},
 custom_budget_review:{answer:'We can calculate a custom management quote using your daily advertising budget and campaign duration. Tell us whichever of those details you have not already supplied.',handoffAfterReply:false,handoffReason:'',forceHandoff:false},
 package_inclusions_review:{answer:'The recommended management package total already includes advertising spend and the management fee. Account setup is separate unless it has explicitly been included in your quote. Use the selected plan and calculator for the exact breakdown.',handoffAfterReply:false,handoffReason:'',forceHandoff:false},
 tiktok_setup_information:{answer:'TikTok account setup covers setting up your advertising account and guidance on accessing it and running your own ads. Advertising spend is separate. Use the current Service price when quoting setup.'},
 meta_setup_information:{answer:'Meta account setup covers Facebook and Instagram advertising-account setup and guidance. Advertising spend is separate. Use the current Service price when quoting setup.'},
 self_managed_ads:{answer:'Customers can choose video training to learn to run ads, or account setup with guidance. If they explicitly choose setup, continue that service. If they want the video course, use the course service. Do not assume these are the same product.'},
 budget_guidance:{answer:'When the customer requests recommendations or does not know their budget, present the configured management plans and ask which they prefer. Retain any budget or duration already supplied.'},
};
function patch(row){
 const data={...row.data,...changes[row.key]};
 if(row.title==='Expected Views / Engagement'){
  data.preferredResponse="We can't predict the exact views or engagement you'll get. Good content gives your campaign a better opportunity to perform well, but results are not guaranteed.";
 }
 if(data.schemaVersion===1||data.preferredResponse!==undefined)data.answer=[data.preferredResponse,data.facts].filter(Boolean).join('\n');
 return data;
}
async function main(){
 require('dotenv').config({path:path.join(__dirname,'../.env'),quiet:true});
 await mongoose.connect(process.env.MONGO_URI,{autoIndex:false,autoCreate:false});
 const db=mongoose.connection.db,records=db.collection('inboxairecords');
 const rows=await records.find({$or:[{key:{$in:Object.keys(changes)}},{title:'Expected Views / Engagement'}]}).toArray();
 const updates=rows.map(row=>({row,data:patch(row)})).filter(x=>JSON.stringify(x.data)!==JSON.stringify(x.row.data));
 console.log(JSON.stringify({mode:process.argv.includes('--apply')?'apply':'preview',records:updates.map(x=>x.row.key)}));
 if(!process.argv.includes('--apply')||!updates.length)return;
 const backup=path.join(os.tmpdir(),`joshspot-knowledge-backup-${Date.now()}.json`);fs.writeFileSync(backup,JSON.stringify(rows,null,2));
 const session=await mongoose.startSession();
 try{await session.withTransaction(async()=>{
  for(const {row,data} of updates){
   const result=await records.updateOne({_id:row._id,revision:row.revision??{$exists:false}},{$set:{data,changedBy:'admin-approved-knowledge-reconciliation',updatedAt:new Date()},$inc:{revision:1}},{session});
   if(result.matchedCount!==1)throw Error('Record changed concurrently');
  }
  await db.collection('inboxaiconfigs').updateOne({key:'main'},{$inc:{revision:1},$set:{updatedAt:new Date()}},{session});
  await db.collection('inboxailogs').insertOne({kind:'configuration',actor:'admin-approved',action:'reconcile_business_knowledge',before:updates.map(x=>({key:x.row.key,data:x.row.data})),after:updates.map(x=>({key:x.row.key,data:x.data})),createdAt:new Date(),updatedAt:new Date()},{session});
 });}finally{await session.endSession()}
 for(const {row,data} of updates){const saved=await records.findOne({_id:row._id});if(JSON.stringify(saved.data)!==JSON.stringify(data))throw Error('Verification failed');}
 console.log(JSON.stringify({verified:updates.length,backup}));
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>mongoose.disconnect());
module.exports={changes,patch};
