const {Config,Sample}=require('./models');
let running=false,last=0;
async function reconcile(c,cfg){
 const {Conversation,Message}=require('../models');
 const messages=await Message.find({conversation:c._id,createdAt:{$gte:cfg.startsAt},direction:{$in:['inbound','outbound']}}).sort({createdAt:1,_id:1}).limit(20001).select('_id createdAt direction status author').lean();
 if(messages.length>20000)throw new Error('Earnings reconciliation limit reached; admin review required');
 const rows=require('./math').replay(c,messages,cfg.startsAt);
 for(const key of new Set(rows.map(r=>`${r.staff}|${require('./math').dayKey(r.startedAt).slice(0,7)}`))){const [staff,month]=key.split('|');await require('./routes').monthly(staff,month,cfg);}
 if(rows.length)await Sample.bulkWrite(rows.map(row=>({updateOne:{filter:{key:row.key},update:{$set:{...row,conversation:c._id}},upsert:true}})));
 // Never acknowledge newer changes that arrived while this snapshot was being reconciled.
 await Conversation.collection.updateOne({_id:c._id,updatedAt:c.updatedAt},{$set:{earningsDirty:false,earningsCheckedAt:new Date()},$unset:{earningsError:1,earningsLease:1}});
}
async function tick(){
 if(running||Date.now()-last<15000)return;running=true;last=Date.now();
 try{const cfg=await Config.findById('main').lean();if(!cfg?.enabled||!cfg.startsAt)return;
 const {Conversation}=require('../models');
 for(let i=0;i<10;i++){
  const c=await Conversation.findOneAndUpdate({earningsDirty:true,deleting:{$ne:true},$or:[{earningsLease:null},{earningsLease:{$lt:new Date()}}]},{$set:{earningsLease:new Date(Date.now()+120000)}},{sort:{earningsCheckedAt:1},returnDocument:'after'}).lean();if(!c)break;
  try{await reconcile(c,cfg)}catch(e){await Conversation.collection.updateOne({_id:c._id},{$set:{earningsError:'Response tracking requires reconciliation. Deductions cannot be finalized.',earningsCheckedAt:new Date()}});}
 }
 }finally{running=false;}
}
module.exports={tick,reconcile};
