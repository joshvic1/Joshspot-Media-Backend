const mongoose = require('mongoose');
const webpush = require('web-push');
const {Conversation} = require('./models');
const Staff = require('../models/Staff');
const policy = require('./policy');
const kinds = ['assignments','messages','mentions','followups'];
const subscriptionSchema = new mongoose.Schema({endpoint:{type:String,unique:true},actor:String,subscription:mongoose.Schema.Types.Mixed,preferences:mongoose.Schema.Types.Mixed,enabledAt:Date,cursor:mongoose.Schema.Types.ObjectId,leaseUntil:Date,checkedAt:Date},{timestamps:true});
const eventSchema = new mongoose.Schema({key:{type:String,unique:true},kind:String,conversation:mongoose.Schema.Types.ObjectId,recipient:String,message:mongoose.Schema.Types.ObjectId,dueAt:Date,createdAt:{type:Date,default:Date.now}});
eventSchema.index({createdAt:1},{expireAfterSeconds:604800});
const Subscription=mongoose.model('InboxPushSubscription',subscriptionSchema);
const Event=mongoose.model('InboxPushEvent',eventSchema);
const configured=()=>Boolean(process.env.INBOX_PUSH_PUBLIC_KEY&&process.env.INBOX_PUSH_PRIVATE_KEY&&process.env.INBOX_PUSH_SUBJECT);
function validateSubscription(s){
  let u;try{u=new URL(s?.endpoint)}catch{return false}
  const host=u.hostname;
  const allowed=host==='fcm.googleapis.com'||host==='updates.push.services.mozilla.com'||host.endsWith('.notify.windows.com')||host==='web.push.apple.com'||host.endsWith('.push.apple.com');
  return allowed&&u.protocol==='https:'&&!u.port&&!u.username&&!u.password&&s.endpoint.length<2048&&typeof s.keys?.p256dh==='string'&&/^[A-Za-z0-9_-]{87}$/.test(s.keys.p256dh)&&/^[A-Za-z0-9_-]{22}$/.test(s.keys.auth||'');
}
async function record(key,kind,conversation,recipient,message,dueAt){
  try{await Event.updateOne({key},{$setOnInsert:{kind,conversation,recipient:recipient?String(recipient):undefined,message,dueAt}},{upsert:true})}catch(e){if(e.code!==11000)throw e}
}
function routes(router,wrap,rateLimit){
  router.get('/push/config',wrap(async(req,res)=>res.json({configured:configured(),publicKey:configured()?process.env.INBOX_PUSH_PUBLIC_KEY:null})));
  router.post('/push/preferences',wrap(async(req,res)=>{
    await rateLimit(req);
    const endpoint=req.body.endpoint;
    if(typeof endpoint!=='string'||endpoint.length>2048)return res.status(400).json({message:'Invalid browser subscription.'});
    const row=await Subscription.findOne({endpoint,actor:req.actor.id}).lean();
    res.json({preferences:Object.fromEntries(kinds.map(k=>[k,row?.preferences?.[k]===true]))});
  }));
  router.put('/push/subscription',wrap(async(req,res)=>{
    await rateLimit(req);
    if(!configured())return res.status(503).json({message:'Browser notifications have not been configured by the administrator yet.'});
    if(!validateSubscription(req.body.subscription)||!req.body.preferences||kinds.some(k=>typeof req.body.preferences[k]!=='boolean'))return res.status(400).json({message:'Invalid notification settings.'});
    const subscription=req.body.subscription;const preferences=Object.fromEntries(kinds.map(k=>[k,req.body.preferences[k]]));
    // Each browser endpoint belongs to one signed-in account. Reset the cursor on
    // preference changes so enabling an alert never replays older conversations.
    await Subscription.findOneAndUpdate({endpoint:subscription.endpoint},{$set:{actor:req.actor.id,subscription:{endpoint:subscription.endpoint,keys:subscription.keys},preferences,enabledAt:new Date()},$unset:{cursor:1}},{upsert:true});
    res.json({preferences});
  }));
  router.delete('/push/subscription',wrap(async(req,res)=>{
    await rateLimit(req);await Subscription.deleteOne({actor:req.actor.id,endpoint:String(req.body.endpoint||'')});res.json({ok:true});
  }));
}
async function actorFor(id){
 if(id==='admin')return {id,admin:true};
 const staff=await Staff.findById(id).select('role').lean();return staff&&['SS','CSS'].includes(staff.role)?{id,role:staff.role,admin:false}:null;
}
async function eligible(actor,event){
 if(event.recipient&&event.recipient!==actor.id)return false;
 const c=await Conversation.findOne({$and:[policy.visible(actor),{_id:event.conversation,deleting:{$ne:true}}]}).lean();
 if(!c)return false;
 if(event.kind==='assignments'&&String(c.assignedTo)!==actor.id)return false;
 if(event.kind==='followups'&&(c.status!=='follow_up'||+new Date(c.followUpAt)!==+new Date(event.dueAt)))return false;
 return true;
}
const bodies={assignments:'A conversation has been assigned to you.',messages:'A new customer message is available.',mentions:'A teammate mentioned you in an internal note.',followups:'A scheduled follow-up is due.'};
let running=false,lastRun=0;
async function tick(){
 if(running||!configured()||Date.now()-lastRun<15000)return;
 running=true;lastRun=Date.now();
 try{
  if(!await Subscription.exists({$or:kinds.map(k=>({['preferences.'+k]:true}))}))return;
  const due=Conversation.find({status:'follow_up',deleting:{$ne:true},followUpAt:{$lte:new Date(),$gte:new Date(Date.now()-86400000)}}).select('_id assignedTo followUpAt').lean().cursor();
  for await(const c of due)await record(`followup:${c._id}:${+c.followUpAt}`,'followups',c._id,c.assignedTo||'admin',undefined,c.followUpAt);
  const subs=await Subscription.find({$or:[{leaseUntil:null},{leaseUntil:{$lt:new Date()}}]}).sort({checkedAt:1}).limit(20).lean();
  for(const candidate of subs){
   const lease=new Date(Date.now()+60000);
   const sub=await Subscription.findOneAndUpdate({_id:candidate._id,$or:[{leaseUntil:null},{leaseUntil:{$lt:new Date()}}]},{$set:{leaseUntil:lease,checkedAt:new Date()}},{returnDocument:'after'}).lean();
   if(!sub)continue;
   try{
    const actor=await actorFor(sub.actor);
    if(!actor){await Subscription.deleteOne({_id:sub._id});continue}
    const events=await Event.find({createdAt:{$gte:sub.enabledAt},...(sub.cursor?{_id:{$gt:sub.cursor}}:{})}).sort({_id:1}).limit(10).lean();
    for(const event of events){
     const current=await Subscription.findOne({_id:sub._id,enabledAt:sub.enabledAt,leaseUntil:lease}).lean();if(!current)break;
     if(current.preferences?.[event.kind]&&(!event.dueAt||event.dueAt>=sub.enabledAt)&&await eligible(actor,event)){
      try{await webpush.sendNotification(sub.subscription,JSON.stringify({title:'Joshspot Inbox',body:bodies[event.kind],tag:String(event._id),url:`/crm-inbox?conversation=${event.conversation}${event.message?'&message='+event.message:''}`}),{TTL:300,timeout:3000,vapidDetails:{subject:process.env.INBOX_PUSH_SUBJECT,publicKey:process.env.INBOX_PUSH_PUBLIC_KEY,privateKey:process.env.INBOX_PUSH_PRIVATE_KEY}})}
      catch(error){if([404,410].includes(error.statusCode))await Subscription.deleteOne({_id:sub._id});break}
     }
     await Subscription.updateOne({_id:sub._id,enabledAt:sub.enabledAt,leaseUntil:lease},{$set:{cursor:event._id}});
    }
   }finally{await Subscription.updateOne({_id:sub._id,leaseUntil:lease},{$unset:{leaseUntil:1}})}
  }
 }catch{console.error('Inbox push delivery needs attention');}finally{running=false}
}
module.exports={Subscription,Event,validateSubscription,routes,record,tick,eligible};
