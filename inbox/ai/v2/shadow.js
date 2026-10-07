const mongoose=require('mongoose');
const {randomUUID}=require('node:crypto');
const {clean}=require('./model');
const schema=new mongoose.Schema({key:{type:String,unique:true},conversation:mongoose.Schema.Types.ObjectId,inputId:mongoose.Schema.Types.ObjectId,configRevision:Number,status:String,snapshot:mongoose.Schema.Types.Mixed,baseline:mongoose.Schema.Types.Mixed,leaseUntil:Date,token:String,expiresAt:Date},{timestamps:true});
schema.index({status:1,createdAt:1});schema.index({expiresAt:1},{expireAfterSeconds:0});
const Job=mongoose.model('InboxAIShadowJob',schema);
const memory=new mongoose.Schema({key:{type:String,unique:true},state:mongoose.Schema.Types.Mixed,lastInput:String,leaseUntil:Date,token:String,expiresAt:Date},{timestamps:true});
memory.index({expiresAt:1},{expireAfterSeconds:0});
const Memory=mongoose.model('InboxAIShadowMemory',memory);
async function enqueue(args,conversation,inputId,configRevision,baseline){
  const key=`${conversation}:${inputId}:${configRevision}`;
  await Job.updateOne({key},{$setOnInsert:{conversation,inputId,configRevision,status:'pending',snapshot:clean(args),baseline:clean({action:baseline.action,response:baseline.response,handoff:baseline.handoff}),expiresAt:new Date(Date.now()+7*86400000)}},{upsert:true});
}
let running=false;
async function tick(){
  if(running)return;running=true;const token=randomUUID();let locked=false;
  try{
    try{await Memory.updateOne({key:'worker'},{$setOnInsert:{key:'worker'}},{upsert:true});}catch(e){if(e.code!==11000)throw e;}
    locked=await Memory.findOneAndUpdate({key:'worker',$or:[{leaseUntil:null},{leaseUntil:{$lt:new Date()}}]},{$set:{token,leaseUntil:new Date(Date.now()+90000)}},{returnDocument:'after'});
    if(!locked)return;
    const job=await Job.findOneAndUpdate({$or:[{status:'pending'},{status:'running',leaseUntil:{$lt:new Date()}}]},{$set:{status:'running',token,leaseUntil:new Date(Date.now()+90000)}},{sort:{createdAt:1},returnDocument:'after'}).lean();
    if(!job)return;
    const {Conversation}=require('../../models');
    if(!await Conversation.exists({_id:job.conversation,deleting:{$ne:true}})){await Job.deleteOne({_id:job._id});return;}
    const prev=await Memory.findOne({key:String(job.conversation)}).lean();
    if(prev?.lastInput&&prev.lastInput>=String(job.inputId)){await Job.updateOne({_id:job._id,token},{$set:{status:'skipped'}});return;}
    const args=job.snapshot;
    // Shadow remembers its own validated facts, but references only REAL sent questions.
    if(prev?.state?.core)args.state={...args.state,core:prev.state.core};
    args.reserveModelCall=()=>require('../worker').budget(args.config,`shadow:${job.conversation}`);
    const result=await require('./index').decide(args);
    const {Log,Usage}=require('../models');
    await Log.create({kind:'shadow',conversation:job.conversation,inputIds:[job.inputId],mode:'SHADOW',action:result.action,intent:result.intent,handoff:result.handoff,error:result.error,model:result.model,usage:result.usage,before:clean(args.state),after:clean(result.state),text:args.text,response:result.response,configRevision:job.configRevision,decision:clean({baseline:job.baseline,v2:result.debug,actionChanged:job.baseline.action!==result.action})});
    if(result.usage?.total_tokens)await Usage.updateOne({key:`global:${new Date().toISOString().slice(0,10)}`},{$inc:{tokens:result.usage.total_tokens}});
    await Memory.updateOne({key:String(job.conversation)},{$set:{state:clean(result.state),lastInput:String(job.inputId),expiresAt:new Date(Date.now()+7*86400000)}},{upsert:true});
    await Job.updateOne({_id:job._id,token},{$set:{status:'done'},$unset:{snapshot:1}});
  }catch(error){console.error('V2 shadow deferred:',error.name);}
  finally{if(locked)await Memory.updateOne({key:'worker',token},{$unset:{leaseUntil:1,token:1}});running=false;}
}
module.exports={enqueue,tick,Job,Memory};
