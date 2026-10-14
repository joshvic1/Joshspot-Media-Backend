// Disposable Mongo only; no .env, Meta calls or real payroll changes.
const {test,before,after}=require('node:test'),assert=require('node:assert/strict');
const mongoose=require('mongoose'),express=require('express');const {MongoMemoryServer}=require('mongodb-memory-server');
const {Config,Sample,Month}=require('./models');const {routes,defaults}=require('./routes');const Staff=require('../../models/Staff');const {Conversation,Message,Contact}=require('../models');
let mongo,server,url,staff,other;
before(async()=>{mongo=await MongoMemoryServer.create();await mongoose.connect(mongo.getUri());await Promise.all([Config,Sample,Month,Staff,Conversation,Message,Contact].map(m=>m.init()));staff=await Staff.create({name:'First',email:'first@test.invalid',password:'test',role:'CSS'});other=await Staff.create({name:'Second',email:'second@test.invalid',password:'test',role:'CSS'});const app=express();app.use(express.json());app.use((req,res,next)=>{req.actor=req.headers['x-role']==='admin'?{id:'admin',admin:true}:{id:String(staff._id),admin:false};next()});require('../staffRoutes')(app,fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next),async()=>{});routes(app,fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next),async()=>{});app.use((e,req,res,next)=>res.status(e.status||500).json({message:e.message}));server=app.listen(0);url=`http://127.0.0.1:${server.address().port}`;});
after(async()=>{await new Promise(r=>server.close(r));await mongoose.disconnect();await mongo.stop()});
async function request(path,body,admin=false,method){const r=await fetch(url+path,{method:method||(body?'POST':'GET'),headers:{'content-type':'application/json','x-role':admin?'admin':'staff'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};}
test('earnings permissions, cap, audited adjustment and finalization lock',async()=>{
 assert.equal((await request('/earnings?staff='+other._id)).status,403);
 assert.equal((await request('/earnings/config',{...defaults,enabled:true},false,'PUT')).status,403);
 await Config.create({_id:'main',...defaults,enabled:true,startsAt:new Date('2026-09-01')});
 await Sample.create({key:'test-1',staff:String(staff._id),startedAt:new Date('2026-09-02T08:00:00+01:00'),endedAt:new Date('2026-09-02T08:25:00+01:00'),status:'answered'});
 const own=await request('/earnings?from=2026-09-01&to=2026-09-30');assert.equal(own.data.deduction,2000);assert.deepEqual(own.data.people,[]);
 assert.equal((await request('/earnings/month',{staff:String(staff._id),month:'2026-09',action:'adjust',amount:100000,reason:'Owner review'},true)).status,200);
 const capped=await request('/earnings?from=2026-09-01&to=2026-09-30');assert.equal(capped.data.deduction,100000);
 const finalized=await request('/earnings/month',{staff:String(staff._id),month:'2026-09',action:'finalize'},true);assert.equal(finalized.status,200,JSON.stringify(finalized.data));
 assert.equal((await request('/earnings/month',{staff:String(staff._id),month:'2026-09',action:'adjust',amount:-1000,reason:'Late change'},true)).status,409);
 await Sample.updateOne({key:'test-1'},{$set:{endedAt:new Date('2026-09-02T08:01:00+01:00')}});
 const locked=await request('/earnings?from=2026-09-01&to=2026-09-30');assert.equal(locked.data.days[0].deduction,2000);assert.equal(locked.data.deduction,100000);
});
test('pending records prevent finalization and config changes preserve existing month rules',async()=>{
 await Sample.create({key:'pending',staff:String(other._id),startedAt:new Date('2026-09-03T08:00:00+01:00'),status:'pending'});
 assert.equal((await request('/earnings/month',{staff:String(other._id),month:'2026-09',action:'finalize'},true)).status,409);
 const pending=await Sample.findOne({key:'pending'});assert.equal((await request('/earnings/exclude',{id:String(pending._id),reason:'System outage review'})).status,403);assert.equal((await request('/earnings/exclude',{id:String(pending._id),reason:'System outage review'},true)).status,200);
 const reviewed=await request('/earnings?staff='+other._id+'&from=2026-09-01&to=2026-09-30',null,true);assert.equal(reviewed.data.pending,0);assert.equal(reviewed.data.excluded,1);
 const result=await request('/earnings/config',{...defaults,enabled:true,blockAmount:2000},true,'PUT');assert.equal(result.status,200);
 const old=await Month.findOne({staff:String(staff._id),month:'2026-09'}).lean();assert.equal(old.rule.blockAmount,1000);
});
test('reconciliation is idempotent and ownership is captured with assignment',async()=>{
 const contact=await Contact.create({name:'Synthetic',phone:'+2348000000000'});let c=await Conversation.create({contact:contact._id,assignedTo:staff._id});
 const inbound=await Message.create({conversation:c._id,direction:'inbound',type:'text',text:'Synthetic question',status:'received'});
 await Conversation.updateOne({_id:c._id},{$set:{assignedTo:other._id}});c=await Conversation.findById(c._id).lean();assert.equal(c.earningsOwnership[0].from,String(staff._id));
 const cfg=await Config.findById('main').lean(),worker=require('./worker');await worker.reconcile(c,cfg);await worker.reconcile(c,cfg);
 await Sample.create({key:'legacy-transfer',conversation:c._id,inbound:inbound._id,staff:String(staff._id),startedAt:new Date(),status:'transferred'});await worker.reconcile(c,cfg);assert.equal((await Sample.findOne({key:'legacy-transfer'})).status,'superseded');
 const rows=await Sample.find({inbound:inbound._id,key:{$ne:'legacy-transfer'}}).lean();assert.equal(rows.length,2);assert.equal(rows.find(r=>r.staff===String(other._id)).status,'pending');assert.equal(rows.find(r=>r.staff===String(staff._id)).status,'transferred');
 assert.equal((await Conversation.findById(c._id)).earningsDirty,false);
});
test('late replies are unique, paginated and hide names after reassignment',async()=>{
 const a=await Contact.create({name:'Visible Client',phone:'+2348000000001'}),b=await Contact.create({name:'Private Client',phone:'+2348000000002'});
 const ca=await Conversation.create({contact:a._id,assignedTo:staff._id}),cb=await Conversation.create({contact:b._id,assignedTo:other._id});
 const start=new Date('2026-10-01T08:00:00+01:00'),end=new Date('2026-10-01T08:20:00+01:00');
 for(let i=0;i<25;i++){const c=i===24?cb:ca;const reply=await Message.create({conversation:c._id,direction:'outbound',type:'text',author:String(staff._id),status:'sent'});await Sample.create({key:`late-${i}`,staff:String(staff._id),conversation:c._id,reply:reply._id,startedAt:start,endedAt:end,status:'answered'});if(i===0)await Sample.create({key:'duplicate-reply',staff:String(staff._id),conversation:c._id,reply:reply._id,startedAt:start,endedAt:end,status:'answered'});}
 await Sample.create({key:'not-late',staff:String(staff._id),conversation:ca._id,reply:new mongoose.Types.ObjectId(),startedAt:start,endedAt:new Date(+start+15*60000),status:'answered'});
 const result=await request('/earnings?from=2026-10-01&to=2026-10-01&latePage=0');assert.equal(result.status,200);assert.equal(result.data.lateCount,25);assert.equal(result.data.lateResponses.items.length,24);assert.equal(result.data.lateResponses.next,1);
 const secondPage=await request('/earnings?from=2026-10-01&to=2026-10-01&latePage=1');assert.equal(secondPage.data.lateResponses.items.length,1);assert.equal(secondPage.data.lateResponses.next,null);
 const items=[...result.data.lateResponses.items,...secondPage.data.lateResponses.items];assert.equal(items.filter(x=>x.name==='Visible Client').length,24);assert.equal(items.filter(x=>!x.available).length,1);assert.ok(!JSON.stringify(items).includes('Private Client'));assert.ok(items.filter(x=>x.available).every(x=>x.message&&x.conversation));
 assert.equal((await request('/earnings?from=2026-10-01&to=2026-10-01&latePage=-1')).status,400);
});


test('report counts transferred intervals in summary and daily averages',async()=>{
 const startedAt=new Date('2026-10-05T08:00:00+01:00');
 await Sample.create([{key:'transfer-average',staff:String(other._id),startedAt,endedAt:new Date(+startedAt+25*60000),status:'transferred'},{key:'answered-average',staff:String(other._id),startedAt,endedAt:new Date(+startedAt+15*60000),status:'answered'}]);
 const result=await request('/earnings?staff='+other._id+'&from=2026-10-05&to=2026-10-05',null,true);
 assert.equal(result.status,200);assert.equal(result.data.transferred,1);assert.equal(result.data.answered,1);assert.equal(result.data.pending,0);assert.equal(result.data.averageMs,20*60000);assert.equal(result.data.days[0].averageMs,20*60000);assert.equal(result.data.excluded,0);
 assert.equal(result.data.deduction,1000); // Existing month keeps its original 1,000-naira rule.
});


test('offline deductions respect monthly cap and staff access',async()=>{
 const {Availability}=require('./models');const who=String(other._id);
 await Availability.create({_id:who+':2026-08-03',staff:who,day:'2026-08-03',intervals:[{start:new Date('2026-08-03T08:00:00+01:00'),end:new Date('2026-08-03T11:00:00+01:00')}]});
 const result=await require('./routes').report(who,'2026-08-01','2026-08-31',await Config.findById('main').lean());
 assert.equal(result.days[0].offlineMs,180*60000);assert.equal(result.days[0].offlineDeduction,24000);assert.equal(result.deduction,24000);
 assert.equal((await request('/availability',null,true)).status,403);
 const current=await request('/availability');assert.equal(current.status,200);assert.equal(current.data.allowanceMinutes,60);assert.equal(current.data.blockAmount,1000);
});


test('availability transitions use server time and reject stale devices',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-12T09:00:00+01:00')});
 try{
  const initial=(await request('/availability')).data;assert.equal(initial.offline,false);
  const body={day:initial.day,revision:initial.revision,offline:true};
  const attempts=await Promise.all([request('/availability',body,false,'PUT'),request('/availability',body,false,'PUT')]);
  assert.deepEqual(attempts.map(x=>x.status).sort(),[200,409]);
  t.mock.timers.setTime(new Date('2026-10-12T10:05:00+01:00').getTime());
  const live=(await request('/availability')).data;assert.equal(live.offlineMs,65*60000);assert.equal(live.offlineDeduction,1000);
  const stop=await request('/availability',{day:live.day,revision:live.revision,offline:false},false,'PUT');assert.equal(stop.status,200);assert.equal(stop.data.offline,false);
  t.mock.timers.setTime(new Date('2026-10-12T11:00:00+01:00').getTime());assert.equal((await request('/availability')).data.offlineMs,65*60000);
  t.mock.timers.setTime(new Date('2026-10-13T09:00:00+01:00').getTime());const tomorrow=(await request('/availability')).data;assert.equal(tomorrow.offline,false);assert.equal(tomorrow.offlineMs,0);
 }finally{t.mock.timers.reset()}
});

test('filtered report subtracts only the owners breaks, including breaks after its end date',async()=>{
 const {Availability}=require('./models');const who=String(staff._id);
 await Sample.create({key:'cross-date-offline',staff:who,reply:new mongoose.Types.ObjectId(),startedAt:new Date('2026-10-06T19:50:00+01:00'),endedAt:new Date('2026-10-07T08:25:00+01:00'),status:'answered'});
 await Availability.create({_id:who+':2026-10-07',staff:who,day:'2026-10-07',intervals:[{start:new Date('2026-10-07T08:00:00+01:00'),end:new Date('2026-10-07T08:20:00+01:00')}]});
 const result=await request('/earnings?from=2026-10-06&to=2026-10-06');
 assert.equal(result.data.averageMs,15*60000);assert.equal(result.data.samples[0].workingMinutes,15);assert.equal(result.data.lateCount,0);assert.equal(result.data.deduction,0);assert.equal(result.data.days.length,1);
 await Sample.create({key:'different-owner-break',staff:String(other._id),startedAt:new Date('2026-10-06T19:50:00+01:00'),endedAt:new Date('2026-10-07T08:25:00+01:00'),status:'transferred'});
 const otherResult=await request('/earnings?staff='+other._id+'&from=2026-10-06&to=2026-10-06',null,true);assert.equal(otherResult.data.averageMs,35*60000);
});


test('admin reset and persistent pause are audited, scoped and preserve offline charges',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-10-14T09:10:00+01:00')});
 try{
  const who=String(staff._id),body={staff:who,action:'pause',reason:'Approved support break'};
  await require('./models').Availability.deleteMany({staff:who,day:'2026-10-14'});
  // Isolate this fixed-date example from earlier reconciliation tests using today's date.
  await Sample.deleteMany({staff:who,startedAt:{$gte:new Date('2026-10-14T00:00:00+01:00'),$lt:new Date('2026-10-15T00:00:00+01:00')}});
  assert.equal((await request('/earnings/control',body)).status,403);
  assert.equal((await request('/earnings/control',body,true)).status,200);
  assert.equal((await request('/earnings/control',body,true)).status,200);
  const {Control,Availability}=require('./models');assert.equal(await Control.countDocuments({staff:who,active:true}),1);
  await Sample.create({key:'admin-pause-example',staff:who,startedAt:new Date('2026-10-14T09:00:00+01:00'),status:'pending'});
  t.mock.timers.setTime(new Date('2026-10-14T09:30:00+01:00').getTime());
  let data=(await request('/earnings?from=2026-10-14&to=2026-10-14')).data;assert.equal(data.timerPaused,true);assert.equal(data.averageMs,10*60000);
  assert.equal((await request('/earnings/control',{...body,action:'resume'},true)).status,200);
  t.mock.timers.setTime(new Date('2026-10-14T10:00:00+01:00').getTime());
  data=(await request('/earnings?from=2026-10-14&to=2026-10-14')).data;assert.equal(data.timerPaused,false);assert.equal(data.averageMs,40*60000);
  await Availability.create({_id:who+':2026-10-14',staff:who,day:'2026-10-14',intervals:[{start:new Date('2026-10-14T08:00:00+01:00'),end:new Date('2026-10-14T09:20:00+01:00')}]});
  data=(await request('/earnings?from=2026-10-14&to=2026-10-14')).data;assert.equal(data.averageMs,30*60000);
  assert.equal((await request('/earnings/control',{...body,action:'reset',from:'2026-10-14',to:'2026-10-14'},true)).status,200);
  data=(await request('/earnings?from=2026-10-14&to=2026-10-14')).data;assert.equal(data.averageMs,0);assert.equal(data.pending,1);assert.equal(data.days[0].offlineDeduction,4000);assert.equal(data.deduction,4000);
  assert.equal(await Sample.countDocuments({key:'admin-pause-example'}),1);
  t.mock.timers.setTime(new Date('2026-10-14T10:20:00+01:00').getTime());await Sample.create({key:'after-reset',staff:who,startedAt:new Date('2026-10-14T10:10:00+01:00'),endedAt:new Date('2026-10-14T10:20:00+01:00'),status:'answered'});
  data=(await request('/earnings?from=2026-10-14&to=2026-10-14')).data;assert.equal(data.averageMs,15*60000);assert.equal(data.answered,1);assert.equal(data.pending,1);
  assert.equal((await request('/earnings/control',{...body,action:'reset',from:'2026-09-01',to:'2026-09-30'},true)).status,409);
 }finally{t.mock.timers.reset()}
});


test('staff creation is admin-only, hashes passwords and rejects duplicate email and roles',async()=>{
 const body={name:'New Support',email:'NEW@EXAMPLE.TEST',password:'Synthetic-test-123',role:'CSS'};
 assert.equal((await request('/staff-management',body)).status,403);
 const created=await request('/staff-management',body,true);assert.equal(created.status,201);assert.equal(created.data.password,undefined);
 const stored=await Staff.findOne({email:'new@example.test'});assert.ok(await require('bcryptjs').compare(body.password,stored.password));
 assert.equal((await request('/staff-management',body,true)).status,409);
 assert.equal((await request('/staff-management',{...body,email:'bad@example.test',role:'ADMIN'},true)).status,400);
 assert.equal((await request('/staff-management')).status,403);
 const list=await request('/staff-management',null,true);assert.equal(list.status,200);assert.ok(list.data.items.every(x=>!x.password));
});

test('staff editing validates permissions, preserves passwords and updates authenticated permissions',async()=>{
 const body={name:'Edited staff',email:staff.email,role:'CSS',permissions:{invoice:false,'setup.edit':false}};
 assert.equal((await request('/staff-management/'+staff._id,body,false,'PUT')).status,403);
 const saved=await request('/staff-management/'+staff._id,body,true,'PUT');assert.equal(saved.status,200);assert.equal(saved.data.password,undefined);assert.equal(saved.data.permissions.invoice,false);
 assert.equal((await Staff.findById(staff._id)).password,'test');
 assert.equal((await request('/staff-management/'+staff._id,{...body,permissions:{invented:true}},true,'PUT')).status,400);
 assert.equal((await request('/staff-management/'+staff._id,{...body,email:other.email},true,'PUT')).status,409);
 const jwt=require('jsonwebtoken'),auth=require('../../middleware/staffAuth');
 const req={headers:{authorization:jwt.sign({staffId:String(staff._id),role:'SS'},process.env.JWT_SECRET||'joshspotsecret')}};
 let passed=false;await auth(req,{status(){throw Error('unexpected auth error')}},()=>{passed=true});assert.equal(passed,true);assert.equal(req.staff.role,'CSS');assert.equal(req.staff.permissions.invoice,false);
});

test('reconciliation loads automation metadata and rebuilds handoff waits',async()=>{
 const contact=await Contact.create({name:'Handoff fixture',phone:'+2348000000099'});
 const c=await Conversation.create({contact:contact._id,assignedTo:staff._id,earningsOwnership:[{at:new Date('2026-10-12T10:12:00+01:00'),from:'',to:String(staff._id)}]});
 await Message.create({conversation:c._id,direction:'inbound',type:'text',status:'received',createdAt:new Date('2026-10-12T10:10:00+01:00')});
 await Message.create({conversation:c._id,direction:'outbound',type:'text',status:'sent',author:'ai',automation:{handoff:true},createdAt:new Date('2026-10-12T10:11:00+01:00')});
 await Message.create({conversation:c._id,direction:'outbound',type:'text',status:'sent',author:'admin',clientKey:'course-link:timing-fixture',createdAt:new Date('2026-10-12T10:15:00+01:00')});
 await Message.create({conversation:c._id,direction:'outbound',type:'text',status:'sent',author:String(staff._id),createdAt:new Date('2026-10-12T10:30:00+01:00')});
 await require('./worker').reconcile(await Conversation.findById(c._id).lean(),{...defaults,startsAt:new Date('2026-10-01')});
 const rows=await Sample.find({conversation:c._id,status:'answered'}).lean();assert.equal(rows.length,1);assert.equal(+rows[0].endedAt-rows[0].startedAt,20*60000);assert.equal((await Conversation.findById(c._id)).earningsVersion,4);
});

test('resolved samples reconcile once and later human replies update rather than duplicate them',async()=>{
 const contact=await Contact.create({name:'Resolved fixture',phone:'2348000000099'});
 const at=x=>new Date(`2026-10-12T${x}:00+01:00`);
 let c=await Conversation.create({contact:contact._id,assignedTo:other._id,earningsResolutions:[{at:at('15:10'),by:String(other._id),status:'resolved'}]});
 const q=await Message.create({conversation:c._id,direction:'inbound',type:'text',status:'received',text:'Okay',createdAt:at('15:00')});
 const cfg={...defaults,startsAt:at('00:00')},worker=require('./worker');
 await worker.reconcile(c.toObject(),cfg);await worker.reconcile(c.toObject(),cfg);
 let samples=await Sample.find({conversation:c._id});assert.equal(samples.length,1);assert.equal(+samples[0].endedAt,+at('15:10'));
 await Message.create({conversation:c._id,direction:'outbound',type:'text',status:'sent',text:'Reminder',author:'admin',automation:{followup:new mongoose.Types.ObjectId()},createdAt:at('17:00')});
 await worker.reconcile(c.toObject(),cfg);assert.equal(+(await Sample.findOne({conversation:c._id})).endedAt,+at('15:10'));
 await Message.create({conversation:c._id,direction:'outbound',type:'text',status:'sent',text:'Details',author:String(other._id),createdAt:at('18:00')});
 await worker.reconcile(c.toObject(),cfg);samples=await Sample.find({conversation:c._id});assert.equal(samples.length,1);assert.equal(+samples[0].endedAt,+at('18:00'));assert.equal(String(samples[0].inbound),String(q._id));
});
