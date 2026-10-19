// Staff DMs deliberately never use InboxConversation/InboxMessage, Meta or earnings records.
const {Thread,StaffMessage}=require('./staffChatModels');
const Staff=require('../models/Staff');
const {Notification}=require('./models');
const identity=require('./adminIdentity');
const mongoose=require('mongoose');
const live=require('./live');
const zero=new mongoose.Types.ObjectId('000000000000000000000000');
const normalize=id=>String(id)===identity.ID?'admin':String(id);
const notificationRecipient=id=>id==='admin'?identity.ID:id;
async function peer(id){return id==='admin'?{_id:'admin',name:'Administrator',role:'ADMIN'}:await Staff.findOne({_id:id,role:{$in:['SS','CSS']}}).select('name role').lean();}
async function present(rows,actor){
 const ids=[...new Set(rows.flatMap(r=>r.participants).filter(id=>id!=='admin'))];
 const people=await Staff.find({_id:{$in:ids}}).select('name role').lean();
 const names=new Map(people.map(p=>[String(p._id),p]));names.set('admin',{name:'Administrator',role:'ADMIN'});
 const counts=rows.length?await StaffMessage.aggregate([{$match:{recipient:actor.id,$or:rows.map(r=>({thread:r._id,_id:{$gt:r.reads?.[actor.id]||zero}}))}},{$group:{_id:'$thread',count:{$sum:1}}}]):[];
 return rows.map(r=>{const other=r.participants.find(id=>id!==actor.id);const person=names.get(other);const unreadCount=counts.find(c=>String(c._id)===String(r._id))?.count||0;return {_id:`staff:${r._id}`,threadId:String(r._id),channel:'staff',contact:{name:person?.name||'Former staff member'},peer:{id:other,name:person?.name||'Former staff member',role:person?.role||'',available:Boolean(person)},lastMessageAt:r.lastMessageAt,lastMessageId:r.lastMessageId,lastInboundId:r.received?.[actor.id],preview:r.preview||'Start a private staff chat',unread:unreadCount>0,unreadCount,status:'open',labels:[],participants:r.participants};});
}
async function list(actor,query){
 if(!['inbox','mine','unread'].includes(String(query.view||'inbox'))||query.status||query.label||query.source||query.customerStatus||(query.agent&&query.agent!==actor.id))return [];
 const filter={participants:actor.id};
 if(query.q){const escaped=String(query.q).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const staff=await Staff.find({name:{$regex:escaped,$options:'i'}}).select('_id').limit(500).lean();const ids=staff.map(p=>String(p._id));if(/administrator/i.test(query.q)||'administrator'.includes(String(query.q).toLowerCase()))ids.push('admin');filter.$or=[{participants:{$in:ids.filter(id=>id!==actor.id)}},{preview:{$regex:escaped,$options:'i'}}];}
 if(query.view==='unread')filter.$expr={$gt:[`$received.${actor.id}`,{$ifNull:[`$reads.${actor.id}`,zero]}]};
 if(query.before){const c=JSON.parse(Buffer.from(String(query.before),'base64url').toString());const boundary={$or:[{lastMessageAt:{$lt:new Date(c.date)}},{lastMessageAt:new Date(c.date),_id:{$lt:c.id}}]};filter.$and=[boundary];}
 return present(await Thread.find(filter).sort({lastMessageAt:-1,_id:-1}).limit(21).lean(),actor);
}
async function counts(actor){return {total:await Thread.countDocuments({participants:actor.id}),unread:await Thread.countDocuments({participants:actor.id,$expr:{$gt:[`$received.${actor.id}`,{$ifNull:[`$reads.${actor.id}`,zero]}]}})};}
async function deliver(message){
 const thread=await Thread.findById(message.thread).lean();if(!thread||!thread.participants.includes(message.recipient))return;
 await Thread.updateOne({_id:thread._id},{$max:{[`received.${message.recipient}`]:message._id}});
 await Thread.updateOne({_id:thread._id,$or:[{lastMessageId:null},{lastMessageId:{$lt:message._id}}]},{$set:{lastMessageId:message._id,lastMessageAt:message.createdAt,preview:message.text.slice(0,160)}});
 const read=thread.reads?.[message.recipient];
 await Notification.updateOne({recipient:notificationRecipient(message.recipient),message:message._id},{$setOnInsert:{conversation:thread._id,kind:'staff_message',authorName:message.senderName,...(read&&String(read)>=String(message._id)?{readAt:new Date()}: {})}},{upsert:true});
 await require('./push').record(`staff-message:${message._id}`,'staff_messages',thread._id,message.recipient,message._id);
 await StaffMessage.updateOne({_id:message._id},{$set:{notificationPending:false}});live.notify();
}
async function deliverPending(){for(const m of await StaffMessage.find({notificationPending:true}).sort({_id:1}).limit(25).lean())await deliver(m);}
function routes(router,wrap,fail,id,rateLimit){
 async function accessible(req){const t=await Thread.findOne({_id:id(req.params.threadId),participants:req.actor.id}).lean();if(!t)fail(404,'Staff chat not found.');return t;}
 router.post('/staff-chats',wrap(async(req,res)=>{
  await rateLimit(req);const target=normalize(req.body.recipient);if(target!=='admin')id(target);
  if(target===req.actor.id)fail(400,'Choose another teammate.');if(!await peer(target))fail(400,'This teammate is no longer available.');
  const participants=[req.actor.id,target].sort(),pair=participants.join(':');let t;
  try{t=await Thread.findOneAndUpdate({pair},{$setOnInsert:{participants}},{upsert:true,returnDocument:'after'}).lean();}catch(e){if(e.code!==11000)throw e;t=await Thread.findOne({pair}).lean();}
  live.notify();res.json((await present([t],req.actor))[0]);
 }));
 router.get('/staff-chats/:threadId',wrap(async(req,res)=>res.json((await present([await accessible(req)],req.actor))[0])));
 router.get('/staff-chats/:threadId/messages',wrap(async(req,res)=>{
  const t=await accessible(req);const filter={thread:t._id};let rows;
  if(req.query.around){const target=await StaffMessage.findOne({_id:id(req.query.around),thread:t._id}).lean();if(!target)fail(404,'Message not found.');rows=[...(await StaffMessage.find({...filter,_id:{$lte:target._id}}).sort({_id:-1}).limit(30).lean()).reverse(),...await StaffMessage.find({...filter,_id:{$gt:target._id}}).sort({_id:1}).limit(30).lean()];}
  else{if(req.query.before)filter._id={$lt:id(req.query.before)};if(req.query.after)filter._id={$gt:id(req.query.after)};rows=await StaffMessage.find(filter).sort({_id:req.query.after?1:-1}).limit(51).lean();if(!req.query.after)rows.reverse();}
  res.json({items:rows,more:rows.length>=50});
 }));
 router.post('/staff-chats/:threadId/messages',wrap(async(req,res)=>{
  await rateLimit(req,60);const t=await accessible(req);const recipient=t.participants.find(p=>p!==req.actor.id);if(!await peer(recipient))fail(400,'This teammate is no longer available.');
  if(typeof req.body.text!=='string'||!req.body.text.trim()||req.body.text.length>10000)fail(400,'Write a message of up to 10,000 characters.');
  if(!/^[a-zA-Z0-9-]{16,80}$/.test(req.body.clientId||''))fail(400,'A unique message key is required.');
  const key=`${t._id}:${req.actor.id}:${req.body.clientId}`;let m;
  try{m=await StaffMessage.findOneAndUpdate({clientKey:key},{$setOnInsert:{thread:t._id,sender:req.actor.id,senderName:req.actor.name,recipient,text:req.body.text.trim()}},{upsert:true,returnDocument:'after'}).lean();}catch(e){if(e.code!==11000)throw e;m=await StaffMessage.findOne({clientKey:key}).lean();}
  await deliver(m);res.status(201).json(m);
 }));
 router.post('/staff-chats/:threadId/read',wrap(async(req,res)=>{
  const t=await accessible(req);const m=await StaffMessage.findOne({_id:id(req.body.messageId),thread:t._id,recipient:req.actor.id}).lean();
  if(m){await Thread.updateOne({_id:t._id},{$max:{[`reads.${req.actor.id}`]:m._id}});await Notification.updateMany({recipient:notificationRecipient(req.actor.id),conversation:t._id,kind:'staff_message',message:{$lte:m._id},readAt:null},{$set:{readAt:new Date()}});live.notify();}res.json({ok:true});
 }));
 router.put('/staff-chats/:threadId/messages/:messageId/reaction',wrap(async(req,res)=>{
  await rateLimit(req,60);const t=await accessible(req);const emoji=req.body.emoji;if(!['','👍','❤️','😂','🙏','✅','🎉'].includes(emoji))fail(400,'Choose a supported reaction.');
  const change=emoji?{$set:{[`reactions.${req.actor.id}`]:emoji}}:{$unset:{[`reactions.${req.actor.id}`]:1}};
  const m=await StaffMessage.findOneAndUpdate({_id:id(req.params.messageId),thread:t._id},change,{returnDocument:'after'}).lean();if(!m)fail(404,'Message not found.');live.notify();res.json(m);
 }));
}
module.exports={routes,list,counts,deliverPending,Thread,StaffMessage};
