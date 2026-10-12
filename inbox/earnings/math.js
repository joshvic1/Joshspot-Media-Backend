// All dates and shifts use Africa/Lagos (UTC+1, no daylight saving).
const DAY=86400000, OFFSET=3600000;
const dayKey=date=>new Date(+new Date(date)+OFFSET).toISOString().slice(0,10);
const dayStart=day=>new Date(`${day}T00:00:00+01:00`);
function workingMs(start,end,rule){
 let total=0,a=+new Date(start),b=+new Date(end);
 if(!Number.isFinite(a)||!Number.isFinite(b)||b<=a)return 0;
 for(let d=+dayStart(dayKey(a));d<b;d+=DAY){
  const weekday=new Date(d+OFFSET).getUTCDay();
  // Sunday is always off, including for older saved working-day rules.
  if(weekday===0||!rule.days.includes(weekday))continue;
  total+=Math.max(0,Math.min(b,d+rule.endHour*3600000)-Math.max(a,d+rule.startHour*3600000));
 }
 return total;
}
// Merge intervals once; binary search skips breaks before each response interval.
function offlineIntervals(records,now=new Date()){
 const intervals=records.flatMap(record=>(record.intervals||[]).map(x=>[+new Date(x.start),Math.min(+new Date(x.end||now),+dayStart(record.day)+DAY,+now)])).filter(([a,b])=>Number.isFinite(a)&&b>a).sort((a,b)=>a[0]-b[0]);
 return mergeIntervals(intervals);
}
function mergeIntervals(intervals){
 intervals=intervals.filter(([a,b])=>Number.isFinite(a)&&b>a).sort((a,b)=>a[0]-b[0]);
 const merged=[];for(const interval of intervals){const last=merged.at(-1);if(last&&interval[0]<=last[1])last[1]=Math.max(last[1],interval[1]);else merged.push([...interval]);}return merged;
}
function responseMs(start,end,rule,breaks=[]){
 const a=+new Date(start),b=+new Date(end);let total=workingMs(start,end,rule),low=0,high=breaks.length;
 while(low<high){const mid=(low+high)>>1;if(breaks[mid][1]<=a)low=mid+1;else high=mid;}
 for(let i=low;i<breaks.length&&breaks[i][0]<b;i++)total-=workingMs(Math.max(a,breaks[i][0]),Math.min(b,breaks[i][1]),rule);
 return Math.max(0,total);
}
function deduction(averageMs,rule){return Math.max(0,Math.floor((averageMs-rule.graceMinutes*60000)/(rule.blockMinutes*60000)))*rule.blockAmount;}
function replay(conversation,messages,startAt){
 const changes=(conversation.earningsOwnership||[]).filter(x=>+new Date(x.at)>=+startAt).sort((a,b)=>+new Date(a.at)-+new Date(b.at));
 let owner=changes.length?String(changes[0].from||''):String(conversation.assignedTo||'');
 const events=[...changes.map(x=>({kind:'owner',at:new Date(x.at),owner:String(x.to||'')})),...messages.map(m=>({kind:'message',at:new Date(m.createdAt),message:m}))].sort((a,b)=>a.at-b.at||(a.kind==='owner'?-1:1));
 let waiting=[],rows=[];
 function close(at,status,reply){for(const row of waiting){row.endedAt=at;row.status=status;row.reply=reply||null;}waiting=[];}
 for(const e of events){
  if(e.kind==='owner'){
   if(owner!==e.owner){
    const previousOwner=owner,pending=waiting.map(r=>({inbound:r.inbound,startedAt:r.startedAt}));
    close(e.at,'transferred');owner=e.owner;
    for(const item of pending){const row={key:`${item.inbound}:${e.at.toISOString()}`,inbound:item.inbound,staff:owner,startedAt:previousOwner?e.at:item.startedAt,status:'pending'};rows.push(row);waiting.push(row);}
   }
   continue;
  }
  const m=e.message;
  if(m.direction==='inbound'){
   // Keep unassigned waiters without charging anyone; assignment adopts the latest inbound time.
   // A new consecutive inbound replaces the previous unanswered start for this owner.
   close(e.at,'superseded');
   const row={key:String(m._id),inbound:m._id,staff:owner,startedAt:e.at,status:'pending'};rows.push(row);waiting.push(row);
  }else if(m.direction==='outbound'&&['sent','delivered','read'].includes(m.status)){
   const automated=m.author==='ai'||Boolean(m.automation)||Boolean(m.courseReminder)||String(m.clientKey||'').startsWith('course-link:');
   // Automated acknowledgments never discharge an assigned human response obligation.
   // A handoff acknowledgment before assignment must also retain the customer wait.
   if(automated&&(owner||m.automation?.handoff))continue;
   // Receipt confirms success; use staff submit time, excluding provider queue delay.
   close(e.at,String(m.author)===owner&&owner?'answered':'covered_by_other',m._id);
  }
 }
 return rows.filter(r=>r.staff);
}
function summarize(rows,rule,now=new Date(),breaks=[]){
 const days={};
 for(const row of rows){const day=dayKey(row.startedAt);const d=days[day]||(days[day]={day,answered:0,pending:0,transferred:0,excluded:0,totalMs:0,maxMs:0,withinGrace:0});
  if(row.exclusion?.reason||!['answered','pending','transferred'].includes(row.status)){d.excluded++;continue;}
  const ms=responseMs(row.timingStartedAt||row.startedAt,row.endedAt||now,rule,breaks);d.totalMs+=ms;d.maxMs=Math.max(d.maxMs,ms);d[row.status]++;
  if(ms<=rule.graceMinutes*60000)d.withinGrace++;
 }
 return Object.values(days).sort((a,b)=>b.day.localeCompare(a.day)).map(d=>({...d,averageMs:d.totalMs/(d.answered+d.pending+d.transferred||1),deduction:deduction(d.totalMs/(d.answered+d.pending+d.transferred||1),rule),provisional:Boolean(d.pending)||d.day===dayKey(now)}));
}
module.exports={mergeIntervals,offlineIntervals,responseMs,DAY,dayKey,dayStart,workingMs,deduction,replay,summarize};
