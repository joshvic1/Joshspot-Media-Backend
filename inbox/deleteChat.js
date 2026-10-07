const crypto=require('node:crypto');
const {Contact,Conversation,Message,Media,Notification,WebhookJob,DeletionGuard}=require('./models');
const {Log,Usage,Record}=require('./ai/models');
const live=require('./live');
const digest=phone=>crypto.createHmac('sha256',process.env.JWT_SECRET).update(`inbox-delete:${phone}`).digest('hex');
const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
async function wasDeleted(phone,timestamp){
 const guard=await DeletionGuard.findById(digest(phone)).lean();
 return Boolean(guard && guard.expiresAt>new Date() && (!Number.isFinite(Number(timestamp)) || Number(timestamp)*1000<=guard.cutoff.getTime()));
}
const webhookFilter=phone=>({$or:[{'payload.entry.changes.value.messages.from':phone},{'payload.entry.changes.value.contacts.wa_id':phone},{'payload.entry.changes.value.statuses.recipient_id':phone}]});
function redactPayload(payload,phone){
 const copy=structuredClone(payload);
 for(const entry of copy.entry || [])for(const change of entry.changes || []){
  const value=change.value;if(!value)continue;
  for(const [field,key] of [['messages','from'],['contacts','wa_id'],['statuses','recipient_id']])if(Array.isArray(value[field]))value[field]=value[field].filter(item=>String(item[key])!==phone);
 }
 return copy;
}
async function deleteChat(id){
 const first=await Conversation.findById(id);
 if(!first)return {deleted:true}; // Safe retry after a lost success response.
 const contact=await Contact.findById(first.contact);if(!contact)fail(409,'Contact unavailable. Please refresh before deleting.');
 await Contact.updateOne({_id:contact._id},{$set:{deleting:true}});
 await Conversation.updateMany({contact:contact._id},{$set:{deleting:true,'ai.active':false,'ai.pending':false,'ai.handoffPending':null},$inc:{'ai.version':1}});
 const conversations=await Conversation.find({contact:contact._id}).distinct('_id');
 const scope={conversation:{$in:conversations}};
 const now=new Date();
 // An external send/upload already in flight cannot be recalled. Wait for it to
 // finish rather than report a successful purge while a worker can recreate data.
 const busy=await Message.exists({...scope,status:'sending',attemptedAt:{$gt:new Date(Date.now()-120000)}})
  || await require('./ai/v2/shadow').Job.exists({...scope,status:'running',leaseUntil:{$gt:now}})
  || await Media.exists({...scope,state:'copying',leaseUntil:{$gt:now}})
  || await Conversation.exists({_id:{$in:conversations},'ai.leaseUntil':{$gt:now}})
  || await WebhookJob.exists({...webhookFilter(contact.phone),state:'processing',leaseUntil:{$gt:now}});
 if(busy)fail(409,'A message or media transfer is finishing. Automatic replies are paused. Please try Delete chat again in a moment.');
 // Only a keyed digest and cutoff survive briefly; no phone, name or content.
 await DeletionGuard.updateOne({_id:digest(contact.phone)},{$max:{cutoff:now},$set:{expiresAt:new Date(Date.now()+8*86400000)}},{upsert:true});
 for(const asset of await Media.find(scope).select('key').lean())if(asset.key)await require('./mediaStorage').remove(asset.key);
 // Preserve unrelated customers in batched webhook envelopes and their job key.
 for await(const job of WebhookJob.find(webhookFilter(contact.phone)).cursor()){
  await WebhookJob.updateOne({_id:job._id},{$set:{payload:redactPayload(job.payload,contact.phone)}});
 }
 // Promoted response drafts are copies of a message and must not retain it.
 const promoted=await Log.find({action:'promote_for_review','after.source':{$in:await Message.find(scope).distinct('_id')}}).lean();
 const recordIds=promoted.map(log=>log.after?.record).filter(Boolean);
 if(recordIds.length){await Record.deleteMany({_id:{$in:recordIds}});await Log.deleteMany({$or:[{_id:{$in:promoted.map(log=>log._id)}},{'before._id':{$in:recordIds}}]});}
 await require('./ai/models').Followup.deleteMany(scope);
 await require('./ai/v2/shadow').Job.deleteMany(scope);
 await require('./ai/v2/shadow').Memory.deleteMany({key:{$in:conversations.map(String)}});
 await require('./shortcuts').Action.deleteMany(scope);
 await Notification.deleteMany(scope);
 await Log.deleteMany(scope);
 for(const conversation of conversations)await Usage.deleteMany({key:{$regex:`^(?:shadow:)?${conversation}:`}});
 await Media.deleteMany(scope);
 await Message.deleteMany(scope);
 await Conversation.deleteMany({_id:{$in:conversations}});
 await Contact.deleteOne({_id:contact._id});
 live.notify();return {deleted:true};
}
async function scrubDeleted(payload){
 const copy=structuredClone(payload);
 for(const entry of copy.entry || [])for(const change of entry.changes || []){
  const value=change.value;if(!value)continue;
  for(const [field,key]of [['messages','from'],['statuses','recipient_id']])if(Array.isArray(value[field])){
   const kept=[];for(const item of value[field])if(!item[key] || !await wasDeleted(String(item[key]),item.timestamp))kept.push(item);value[field]=kept;
  }
  if(Array.isArray(value.contacts)){
   const kept=[];for(const item of value.contacts)if(value.messages?.some(m=>m.from===item.wa_id) || !await wasDeleted(String(item.wa_id),0))kept.push(item);value.contacts=kept;
  }
 }
 return copy;
}
module.exports={deleteChat,wasDeleted,redactPayload,scrubDeleted};
