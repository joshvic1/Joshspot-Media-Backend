const {workingMs,dayKey,dayStart,DAY}=require('./math');
const {Availability}=require('./models');
const FREE=60*60000,BLOCK=5*60000,AMOUNT=1000;
function measure(record,rule,now=new Date()){
 const end=new Date(Math.min(+now,+dayStart(record.day)+DAY));
 const offlineMs=(record.intervals||[]).reduce((sum,x)=>sum+workingMs(x.start,x.end||end,rule),0);
 return {offlineMs,offlineDeduction:Math.floor(Math.max(0,offlineMs-FREE)/BLOCK)*AMOUNT,remainingMs:Math.max(0,FREE-offlineMs)};
}
async function current(staff){const day=dayKey(new Date()),key=`${staff}:${day}`;try{return await Availability.findOneAndUpdate({_id:key},{$setOnInsert:{staff,day,offline:false,revision:0,intervals:[]}},{upsert:true,returnDocument:'after'}).lean()}catch(e){if(e.code!==11000)throw e;return Availability.findById(key).lean()}}
function view(record,rule,now=new Date()){
 const start=+dayStart(record.day),time=+now;
 const working=workingMs(now,new Date(time+1),rule)>0;
 return {day:record.day,revision:record.revision,offline:working&&record.offline,working,...measure(record,rule,now),allowanceMinutes:60,blockMinutes:5,blockAmount:AMOUNT,shiftEnd:new Date(start+rule.endHour*3600000)};
}
module.exports={measure,current,view};
