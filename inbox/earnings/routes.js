const {Config,Sample,Month,Availability,Control}=require('./models');
const {DAY,dayKey,dayStart,summarize,workingMs,offlineIntervals,responseMs,mergeIntervals}=require('./math');
const Staff=require('../../models/Staff');
const fail=(status,message)=>{throw Object.assign(new Error(message),{status})};
const defaults={enabled:false,graceMinutes:15,blockMinutes:5,blockAmount:1000,monthlyCap:100000,startHour:8,endHour:20,days:[1,2,3,4,5,6]};
async function config(){const cfg=await Config.findById('main').lean()||defaults;return {...cfg,days:cfg.days.filter(d=>d!==0)};}
const ruleOf=c=>Object.fromEntries(Object.keys(defaults).filter(k=>k!=='enabled').map(k=>[k,c[k]]));
async function monthly(staff,month,cfg){
 const key=`${staff}:${month}`,existing=await Month.findOne({key}).lean();if(existing)return existing.finalizedAt?existing:{...existing,rule:{...existing.rule,days:existing.rule.days.filter(d=>d!==0)}};
 try{return (await Month.create({key,staff,month,rule:ruleOf(cfg)})).toObject()}catch(e){if(e.code!==11000)throw e;return Month.findOne({key}).lean()}
}
async function report(staff,from,to,cfg,{actor,latePage}={}){
 const start=dayStart(from),end=new Date(+dayStart(to)+DAY);
 const rows=await Sample.find({staff,startedAt:{$gte:start,$lt:end}}).sort({startedAt:-1}).limit(20001).lean();
 if(rows.length>20000)fail(400,'Choose a shorter date range (over 20,000 messages).');
 const now=new Date();
 const availabilityEnd=rows.reduce((last,row)=>{const end=dayKey(row.endedAt||now);return end>last?end:last},to);
 const availability=await Availability.find({staff,day:{$gte:from,$lte:availabilityEnd}}).lean();
 const controls=await Control.find({staff,$or:[{kind:'reset',from:{$lt:end},to:{$gte:start}},{kind:'pause',from:{$lt:new Date(+dayStart(availabilityEnd)+DAY)},$or:[{to:null},{to:{$gte:start}}]}]}).lean();
 for(const row of rows){
  const resets=controls.filter(c=>c.kind==='reset'&&+row.startedAt>=+c.from&&+row.startedAt<+c.to&&+row.startedAt<=+c.at).sort((a,b)=>+b.at-+a.at);
  const reset=resets[0];if(!reset||row.exclusion?.reason)continue;
  if(row.endedAt&&+row.endedAt<=+reset.at)row.exclusion={reason:`Admin reset: ${reset.reason}`,at:reset.at,by:reset.by};
  else row.timingStartedAt=new Date(Math.max(+row.startedAt,+reset.at));
 }

 const breaks=mergeIntervals([...offlineIntervals(availability,now),...controls.filter(c=>c.kind==='pause').map(c=>[+c.from,Math.min(+new Date(c.to||now),+now)])]);
 const grouped={};for(const row of rows){const month=dayKey(row.startedAt).slice(0,7);(grouped[month]||=[]).push(row);}
 // Include empty months so adjustments and finalized statements are still visible.
 let cursor=from.slice(0,7);while(cursor<=to.slice(0,7)){grouped[cursor]||=[];const d=new Date(`${cursor}-01T00:00:00Z`);d.setUTCMonth(d.getUTCMonth()+1);cursor=d.toISOString().slice(0,7);}
 const days=[],months=[];
 for(const [month,samples] of Object.entries(grouped)){
  const ledger=await monthly(staff,month,cfg);const daily=ledger.finalizedAt?(ledger.snapshot?.days||[]).filter(d=>d.day>=from&&d.day<=to):summarize(samples,ledger.rule,now,breaks);
  if(!ledger.finalizedAt)for(const record of availability.filter(r=>r.day.startsWith(month)&&r.day>=from&&r.day<=to)){
   let day=daily.find(d=>d.day===record.day);
   if(!day){day={day:record.day,answered:0,pending:0,transferred:0,excluded:0,totalMs:0,averageMs:0,withinGrace:0,deduction:0};daily.push(day);}
   const measured=require('./availability').measure(record,ledger.rule);
   day.responseDeduction=day.deduction;day.offlineMs=measured.offlineMs;day.offlineDeduction=measured.offlineDeduction;day.deduction+=measured.offlineDeduction;
   if(record.day===dayKey(new Date()))day.provisional=true;
  }
  days.push(...daily);
  const wholeMonth=from<=`${month}-01`&&to>=(month===dayKey(new Date()).slice(0,7)?dayKey(new Date()):new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).toISOString().slice(0,10));
  const raw=daily.reduce((sum,d)=>sum+d.deduction,0),adjustment=(ledger.adjustments||[]).reduce((s,a)=>s+a.amount,0);
  months.push({month,rule:ledger.rule,adjustments:ledger.adjustments||[],finalizedAt:ledger.finalizedAt,finalTotal:ledger.finalTotal,estimate:Math.min(ledger.rule.monthlyCap,Math.max(0,raw+(wholeMonth?adjustment:0))),wholeMonth});
 }
 // Count actual late replies once, even when a reply answers several inbound messages.
 const lateByReply=new Map();
 for(const row of rows){if(row.status!=='answered'||row.exclusion?.reason||(!row.reply&&!row.resolvedAt))continue;
  const rule=months.find(m=>m.month===dayKey(row.startedAt).slice(0,7)).rule;
  if(responseMs(row.timingStartedAt||row.startedAt,row.endedAt,rule,breaks)>rule.graceMinutes*60000)lateByReply.set(String(row.reply||row.inbound),row);
 }
 const lateRows=[...lateByReply.values()].sort((a,b)=>+new Date(b.endedAt)-+new Date(a.endedAt)||String(b.reply).localeCompare(String(a.reply)));
 let lateResponses;
 if(latePage!==undefined){
  const pageRows=lateRows.slice(latePage*24,(latePage+1)*24);
  const {Conversation,Message}=require('../models');
  const chats=await Conversation.find({_id:{$in:pageRows.map(r=>r.conversation)},deleting:{$ne:true},...(actor?.admin?{}:{assignedTo:actor?.id||null})}).populate('contact','name deleting').select('_id contact').lean();
  const replies=await Message.find({_id:{$in:pageRows.map(r=>r.reply||r.inbound)},conversation:{$in:chats.map(c=>c._id)}}).select('_id conversation').lean();
  lateResponses={items:pageRows.map((r,i)=>{const chat=chats.find(c=>String(c._id)===String(r.conversation)&&!c.contact?.deleting);const available=chat&&replies.some(m=>String(m._id)===String(r.reply||r.inbound)&&String(m.conversation)===String(chat._id));return {number:latePage*24+i+1,name:available?(chat.contact?.name||'Unnamed contact'):'Chat unavailable',...(available?{conversation:String(chat._id),message:String(r.reply||r.inbound)}:{}),available:Boolean(available)};}),next:(latePage+1)*24<lateRows.length?latePage+1:null};
 }
 const answered=days.reduce((s,d)=>s+d.answered,0),pending=days.reduce((s,d)=>s+d.pending,0),transferred=days.reduce((s,d)=>s+(d.transferred||0),0),count=answered+pending+transferred;
 return {timerPaused:Boolean(await Control.exists({staff,kind:'pause',active:true})),controlHistory:controls.map(c=>({kind:c.kind,from:c.from,to:c.to,at:c.at,reason:c.reason,active:c.active,resumedAt:c.resumedAt})),lateCount:lateRows.length,...(lateResponses?{lateResponses}:{}),days:days.sort((a,b)=>b.day.localeCompare(a.day)),months,answered,pending,transferred,averageMs:days.reduce((s,d)=>s+d.totalMs,0)/(count||1),withinGrace:days.reduce((s,d)=>s+d.withinGrace,0),excluded:days.reduce((s,d)=>s+d.excluded,0),deduction:months.reduce((s,m)=>s+(m.finalizedAt&&m.wholeMonth?m.finalTotal:m.estimate),0),samples:rows.slice(0,100).map(r=>({id:r._id,inbound:r.inbound,reply:r.reply,conversation:r.conversation,startedAt:r.startedAt,endedAt:r.endedAt,status:r.exclusion?.reason?'excluded_by_admin':r.status,exclusion:r.exclusion,workingMinutes:responseMs(r.timingStartedAt||r.startedAt,r.endedAt||now,months.find(m=>m.month===dayKey(r.startedAt).slice(0,7)).rule,breaks)/60000})),sampleCount:rows.length};
}
function routes(router,wrap,rateLimit){
 router.post('/earnings/control',wrap(async(req,res)=>{
  if(!req.actor.admin)fail(403,'Administrator access required.');await rateLimit(req);
  const {staff,action,reason}=req.body;
  if(!require('mongoose').isValidObjectId(staff)||!await Staff.exists({_id:staff,...require('../staffPermissions').messagingQuery}))fail(400,'Choose a staff member.');
  if(typeof reason!=='string'||reason.trim().length<5||reason.length>500)fail(400,'Enter a reason of 5–500 characters.');
  const now=new Date();
  if(action==='pause'){
   try{await Control.findOneAndUpdate({staff,active:true},{$setOnInsert:{staff,kind:'pause',active:true,from:now,at:now,by:req.actor.id,reason:reason.trim()}},{upsert:true});}catch(e){if(e.code!==11000)throw e;}
  }else if(action==='resume'){
   await Control.updateOne({staff,kind:'pause',active:true},{$set:{active:false,to:now,resumedAt:now,resumedBy:req.actor.id,resumeReason:reason.trim()}});
  }else if(action==='reset'){
   const {from,to}=req.body;
   if(!/^\d{4}-\d{2}-\d{2}$/.test(from||'')||!/^\d{4}-\d{2}-\d{2}$/.test(to||'')||!Number.isFinite(+dayStart(from))||!Number.isFinite(+dayStart(to))||from>to||to>dayKey(now)||(+dayStart(to)-dayStart(from))/DAY>366)fail(400,'Choose a valid past date range of at most one year.');
   if(await Month.exists({staff,month:{$gte:from.slice(0,7),$lte:to.slice(0,7)},finalizedAt:{$ne:null}}))fail(409,'A selected month is finalized. Use an audited adjustment in an open month instead.');
   await Control.create({staff,kind:'reset',from:dayStart(from),to:new Date(+dayStart(to)+DAY),at:now,by:req.actor.id,reason:reason.trim()});
   await Month.updateMany({staff,month:{$gte:from.slice(0,7),$lte:to.slice(0,7)},finalizedAt:null},{$set:{updatedAt:now}});
  }else fail(400,'Unknown timer action.');
  res.json({ok:true});
 }));

 router.get('/availability',wrap(async(req,res)=>{
  if(req.actor.admin||!await Staff.exists({_id:req.actor.id,...require('../staffPermissions').messagingQuery}))fail(403,'Staff availability is for support staff.');
  const cfg=await config(),record=await require('./availability').current(req.actor.id);
  const rule=cfg.startsAt?(await monthly(req.actor.id,record.day.slice(0,7),cfg)).rule:cfg;
  res.json({...require('./availability').view(record,rule),enabled:Boolean(cfg.enabled&&cfg.startsAt)});
 }));
 router.put('/availability',wrap(async(req,res)=>{
  if(req.actor.admin||!await Staff.exists({_id:req.actor.id,...require('../staffPermissions').messagingQuery}))fail(403,'Staff availability is for support staff.');
  await rateLimit(req);
  const cfg=await config();if(!cfg.enabled||!cfg.startsAt)fail(409,'Earnings tracking has not been activated.');
  const record=await require('./availability').current(req.actor.id),ledger=await monthly(req.actor.id,record.day.slice(0,7),cfg),now=new Date();
  if(ledger.finalizedAt)fail(409,'This month is finalized.');
  if(typeof req.body.offline!=='boolean'||!Number.isInteger(req.body.revision))fail(400,'Choose online or offline.');
  if(req.body.day!==record.day||req.body.revision!==record.revision)fail(409,'Availability changed. Refresh and try again.');
  if(!require('./availability').view(record,ledger.rule,now).working)fail(409,'Availability breaks are available during working hours, Monday to Saturday.');
  if(record.offline===req.body.offline)return res.json({...require('./availability').view(record,ledger.rule,now),enabled:true});
  const intervals=record.intervals.map(x=>({...x}));
  if(req.body.offline){if(intervals.length>=100)fail(429,'Too many status changes today. Please contact your administrator.');intervals.push({start:now});}
  else if(intervals.length)intervals[intervals.length-1].end=now;
  const changed=await Availability.findOneAndUpdate({_id:record._id,revision:record.revision},{$set:{offline:req.body.offline,intervals},$inc:{revision:1}},{returnDocument:'after'}).lean();
  if(!changed)fail(409,'Availability changed on another device. Refresh and try again.');
  res.json({...require('./availability').view(changed,ledger.rule,now),enabled:true});
 }));

 router.get('/earnings',wrap(async(req,res)=>{
  const cfg=await config();const people=req.actor.admin?await Staff.find({...require('../staffPermissions').messagingQuery}).select('_id name role').lean():[];
  const staff=req.actor.admin?(req.query.self==='1'?'':String(req.query.staff||people[0]?._id||'')):req.actor.id;
  if(req.query.staff&&!req.actor.admin&&req.query.staff!==req.actor.id)fail(403,'You can only view your own earnings.');
  if(req.actor.admin&&staff&&!people.some(p=>String(p._id)===staff))fail(404,'Staff not found.');
  const today=dayKey(new Date()),from=req.query.from||`${today.slice(0,7)}-01`,to=req.query.to||today;
  if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to)||!Number.isFinite(+dayStart(from))||!Number.isFinite(+dayStart(to))||from>to||(+dayStart(to)-dayStart(from))/DAY>366||to>today)fail(400,'Choose a valid date range of at most one year, ending today or earlier.');
  if(req.query.latePage!==undefined&&(!/^\d+$/.test(req.query.latePage)||Number(req.query.latePage)>1000))fail(400,'Invalid late-response page.');
  const {Conversation}=require('../models');const outstanding=await Conversation.countDocuments({$or:[{earningsDirty:true},{earningsVersion:{$ne:4}}],deleting:{$ne:true},...(req.actor.admin?{}:{assignedTo:staff})});
  const data=staff&&cfg.startsAt?await report(staff,from,to,cfg,{actor:req.actor,latePage:req.query.latePage===undefined?undefined:Number(req.query.latePage)}):{days:[],months:[],samples:[],answered:0,pending:0,averageMs:0,deduction:0};
  res.json({...data,staff,people,config:cfg,from,to,outstanding});
 }));
 router.put('/earnings/config',wrap(async(req,res)=>{
  if(!req.actor.admin)fail(403,'Administrator access required.');await rateLimit(req);
  const b=req.body,next={};for(const [k,min,max]of [['graceMinutes',0,1440],['blockMinutes',1,1440],['blockAmount',0,100000],['monthlyCap',0,100000],['startHour',0,23],['endHour',1,24]]){if(!Number.isInteger(b[k])||b[k]<min||b[k]>max)fail(400,`Invalid ${k}.`);next[k]=b[k];}
  if(next.endHour<=next.startHour||typeof b.enabled!=='boolean'||!Array.isArray(b.days)||!b.days.length||b.days.some(d=>!Number.isInteger(d)||d<0||d>6))fail(400,'Choose valid working hours and days.');
  next.days=[...new Set(b.days)].filter(d=>d!==0);if(!next.days.length)fail(400,'Choose at least one working day from Monday to Saturday.');next.enabled=b.enabled;
  const old=await config();if(old.startsAt&&!b.enabled)fail(400,'Tracking is active. Use audited adjustments to waive deductions; do not silently pause response records.');
  if(b.enabled&&!old.startsAt)next.startsAt=new Date();
  // Freeze this month before updating rules. Revised rules apply to future monthly statements.
  if(old.startsAt)for(const person of await Staff.find({...require('../staffPermissions').messagingQuery}).select('_id'))await monthly(String(person._id),dayKey(new Date()).slice(0,7),old);
  const saved=await Config.findOneAndUpdate({_id:'main'},{$set:next},{upsert:true,returnDocument:'after'}).lean();
  res.json(saved);
 }));
 router.post('/earnings/exclude',wrap(async(req,res)=>{
  if(!req.actor.admin)fail(403,'Administrator access required.');await rateLimit(req);
  if(!require('mongoose').isValidObjectId(req.body.id)||typeof req.body.reason!=='string'||req.body.reason.trim().length<5||req.body.reason.length>500)fail(400,'Choose a record and enter a reason (5–500 characters).');
  const sample=await Sample.findById(req.body.id).lean();if(!sample)fail(404,'Response record not found.');
  const ledger=await monthly(sample.staff,dayKey(sample.startedAt).slice(0,7),await config());if(ledger.finalizedAt)fail(409,'This month is finalized.');
  await Sample.updateOne({_id:sample._id,'exclusion.reason':{$exists:false}},{$set:{exclusion:{reason:req.body.reason.trim(),at:new Date(),by:req.actor.id}}});
  await Month.updateOne({_id:ledger._id,finalizedAt:null},{$set:{updatedAt:new Date()}});
  res.json({ok:true});
 }));
 router.post('/earnings/month',wrap(async(req,res)=>{
  if(!req.actor.admin)fail(403,'Administrator access required.');await rateLimit(req);
  const {staff,month,action}=req.body;if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month||'')||!require('mongoose').isValidObjectId(staff)||!await Staff.exists({_id:staff}))fail(400,'Choose a staff member and month.');
  const cfg=await config();if(!cfg.startsAt)fail(400,'Activate tracking first.');
  const ledger=await monthly(staff,month,cfg);if(ledger.finalizedAt)fail(409,'This month has been finalized and is locked.');
  if(action==='adjust'){
   const {amount,reason}=req.body;if(!Number.isInteger(amount)||Math.abs(amount)>100000||typeof reason!=='string'||reason.trim().length<5||reason.length>500)fail(400,'Enter a whole-naira adjustment and a reason (5–500 characters).');
   const updated=await Month.updateOne({_id:ledger._id,finalizedAt:null},{$push:{adjustments:{amount,reason:reason.trim(),at:new Date(),by:req.actor.id}}});if(!updated.matchedCount)fail(409,'Month has already been finalized.');
  }else if(action==='finalize'){
   if(month>=dayKey(new Date()).slice(0,7))fail(400,'Only a completed month can be finalized.');
   const {Conversation}=require('../models');if(await Conversation.exists({$or:[{earningsDirty:true},{earningsVersion:{$ne:4}}],deleting:{$ne:true}}))fail(409,'Wait for response tracking to finish reconciling before finalizing.');
   const to=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).toISOString().slice(0,10);const data=await report(staff,`${month}-01`,to,cfg);
   if(data.pending)fail(409,'This month still has unanswered messages. Resolve or review them before finalizing.');
   const changed=await Month.updateOne({_id:ledger._id,finalizedAt:null,updatedAt:ledger.updatedAt},{$set:{finalizedAt:new Date(),finalizedBy:req.actor.id,finalTotal:data.deduction,snapshot:{days:data.days,answered:data.answered,excluded:data.excluded}}});if(!changed.matchedCount)fail(409,'Statement changed. Refresh and review before finalizing.');
  }else fail(400,'Unknown action.');
  res.json({ok:true});
 }));
}
module.exports={routes,report,defaults,monthly};
