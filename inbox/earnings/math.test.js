const {test}=require('node:test');const assert=require('node:assert/strict');
const {workingMs,deduction,replay,summarize}=require('./math');const {defaults}=require('./routes');
const at=s=>new Date(`2026-10-${s}+01:00`);
test('working hours exclude nights and respect non-working days',()=>{
 assert.equal(workingMs(at('12T19:50:00'),at('13T08:10:00'),defaults),20*60000);
 assert.equal(workingMs(at('10T22:00:00'),at('11T07:00:00'),defaults),0);
 assert.equal(workingMs(at('11T08:00:00'),at('11T20:00:00'),{...defaults,days:[1,2,3,4,5]}),0);
});
test('completed five-minute blocks match owner examples exactly',()=>{
 for(const [mins,amount]of [[15,0],[19.99,0],[20,1000],[21,1000],[25,2000]])assert.equal(deduction(mins*60000,defaults),amount);
});
test('separate conversation waits contribute to averages; pending waits remain provisional',()=>{
 const rows=[{startedAt:at('10T08:00:00'),endedAt:at('10T08:25:00'),status:'answered'},{startedAt:at('10T08:10:00'),status:'pending'}];
 const [day]=summarize(rows,defaults,at('10T08:35:00'));assert.equal(day.averageMs,25*60000);assert.equal(day.deduction,2000);assert.equal(day.pending,1);assert.equal(day.provisional,true);
});
test('ownership transfer starts new clock and failed sends/notes do not answer',()=>{
 const c={assignedTo:'B',earningsOwnership:[{at:at('10T08:10:00'),from:'A',to:'B'}]};const msgs=[{_id:'1',direction:'inbound',createdAt:at('10T08:00:00')},{_id:'2',direction:'outbound',author:'B',status:'failed',createdAt:at('10T08:11:00')},{_id:'3',direction:'internal',author:'B',status:'internal',createdAt:at('10T08:12:00')},{_id:'4',direction:'outbound',author:'B',status:'sent',createdAt:at('10T08:20:00')}];
 const rows=replay(c,msgs,at('10T00:00:00'));assert.equal(rows[0].status,'transferred');assert.equal(rows[1].staff,'B');assert.equal(rows[1].status,'answered');assert.equal(+rows[1].endedAt-rows[1].startedAt,10*60000);
});
test('AI handoff adopts the customer timestamp and AI acknowledgment cannot end the wait',()=>{
 const rows=replay({assignedTo:'A',earningsOwnership:[{at:at('10T09:00:00'),from:'',to:'A'}]},[{_id:'1',direction:'inbound',createdAt:at('10T08:00:00')},{_id:'2',direction:'outbound',author:'ai',status:'sent',createdAt:at('10T09:05:00')}],at('10T00:00:00'));
 assert.equal(rows.length,1);assert.equal(rows[0].status,'pending');assert.equal(+rows[0].startedAt,+at('10T08:00:00'));
});


test('unanswered transfer time counts for each owner, stops on transfer and excludes overnight',()=>{
 const rows=replay({assignedTo:'B',earningsOwnership:[{at:at('13T08:15:00'),from:'A',to:'B'}]},[
 {_id:'wait',direction:'inbound',createdAt:at('12T19:50:00')},
 {_id:'reply',direction:'outbound',author:'B',status:'sent',createdAt:at('13T08:30:00')}
 ],at('12T00:00:00'));
 const [a]=summarize(rows.filter(r=>r.staff==='A'),defaults,at('14T12:00:00'));
 const [b]=summarize(rows.filter(r=>r.staff==='B'),defaults,at('14T12:00:00'));
 assert.equal(a.averageMs,25*60000);assert.equal(a.transferred,1);assert.equal(a.answered,0);assert.equal(a.pending,0);assert.equal(a.excluded,0);assert.equal(a.deduction,2000);
 assert.equal(b.averageMs,15*60000);assert.equal(b.deduction,0);
 const [mixed]=summarize([...rows.filter(r=>r.staff==='A'),{startedAt:at('12T09:00:00'),endedAt:at('12T09:15:00'),status:'answered'}],defaults,at('14T12:00:00'));
 assert.equal(mixed.averageMs,20*60000);assert.equal(mixed.deduction,1000);
});
test('answered waits do not restart or double count on later reassignment',()=>{
 const rows=replay({assignedTo:'B',earningsOwnership:[{at:at('10T15:15:00'),from:'A',to:'B'}]},[
 {_id:'wait',direction:'inbound',createdAt:at('10T15:00:00')},
 {_id:'reply',direction:'outbound',author:'A',status:'sent',createdAt:at('10T15:10:00')}
 ],at('10T00:00:00'));
 assert.equal(rows.length,1);assert.equal(rows[0].status,'answered');
});

test('Sunday and overnight never accumulate time, even with legacy seven-day rules',()=>{
 const legacy={...defaults,days:[0,1,2,3,4,5,6]};
 assert.equal(workingMs(at('11T08:00:00'),at('11T20:00:00'),legacy),0);
 assert.equal(workingMs(at('10T20:01:00'),at('12T08:05:00'),legacy),5*60000);
 assert.equal(workingMs(at('10T19:50:00'),at('12T08:05:00'),legacy),15*60000);
 assert.equal(workingMs(at('12T20:01:00'),at('12T23:30:00'),defaults),0);
});

test('offline pauses answered, pending and transferred waits without double subtraction',()=>{
 const {offlineIntervals,responseMs}=require('./math');const start=at('12T17:00:00'),end=at('12T17:35:00');
 const breaks=offlineIntervals([{day:'2026-10-12',intervals:[{start:at('12T17:10:00'),end:at('12T17:30:00')},{start:at('12T17:15:00'),end:at('12T17:20:00')}]}],end);
 assert.equal(responseMs(start,end,defaults,breaks),15*60000);
 for(const status of ['answered','pending','transferred']){const [day]=summarize([{startedAt:start,endedAt:status==='pending'?null:end,status}],defaults,end,breaks);assert.equal(day.averageMs,15*60000);assert.equal(day.deduction,0);}
 const open=offlineIntervals([{day:'2026-10-12',intervals:[{start:at('12T17:10:00')}]}],end);
 assert.equal(responseMs(start,end,defaults,open),10*60000);
 assert.equal(responseMs(at('12T17:15:00'),at('12T17:25:00'),defaults,breaks),0);
});

test('consecutive customer messages count once from the latest message',()=>{
 const messages=[0,5,10].map((minute,i)=>({_id:String(i),direction:'inbound',createdAt:new Date(+at('12T10:00:00')+minute*60000)}));
 messages.push({_id:'reply',direction:'outbound',author:'A',status:'sent',createdAt:at('12T10:20:00')});
 const rows=replay({assignedTo:'A'},messages,at('12T00:00:00'));
 const [day]=summarize(rows,defaults,at('13T12:00:00'));assert.equal(day.answered,1);assert.equal(day.averageMs,10*60000);assert.equal(rows.filter(r=>r.status==='superseded').length,2);
 messages.push({_id:'new',direction:'inbound',createdAt:at('12T10:25:00')});
 const [next]=summarize(replay({assignedTo:'A'},messages,at('12T00:00:00')),defaults,at('12T10:35:00'));assert.equal(next.answered,1);assert.equal(next.pending,1);assert.equal(next.averageMs,10*60000);
});

test('no staff timer before handoff; latest inbound survives handoff acknowledgment and course automation',()=>{
 const start=at('12T00:00:00'),messages=[
 {_id:'ai',direction:'outbound',author:'ai',status:'sent',createdAt:at('12T10:00:00')},
 {_id:'first',direction:'inbound',createdAt:at('12T10:08:00')},
 {_id:'latest',direction:'inbound',createdAt:at('12T10:10:00')},
 {_id:'ack',direction:'outbound',author:'ai',automation:{handoff:true},status:'sent',createdAt:at('12T10:11:00')}];
 assert.equal(replay({assignedTo:null},messages,start).length,0);
 const c={assignedTo:'A',earningsOwnership:[{at:at('12T10:12:00'),from:'',to:'A'}]};
 messages.push({_id:'course',direction:'outbound',author:'admin',clientKey:'course-link:example',status:'sent',createdAt:at('12T10:15:00')});
 messages.push({_id:'reminder',direction:'outbound',author:'admin',courseReminder:{invoice:'test'},status:'sent',createdAt:at('12T10:16:00')});
 messages.push({_id:'reply',direction:'outbound',author:'A',status:'sent',createdAt:at('12T10:30:00')});
 const rows=replay(c,messages,start);assert.equal(rows.length,1);assert.equal(rows[0].status,'answered');assert.equal(+rows[0].startedAt,+at('12T10:10:00'));
 assert.equal(summarize(rows,defaults,at('12T11:00:00'))[0].averageMs,20*60000);
});
test('normal AI answer before handoff leaves no unanswered period to charge',()=>{
 const rows=replay({assignedTo:'A',earningsOwnership:[{at:at('12T10:12:00'),from:'',to:'A'}]},[
 {_id:'q',direction:'inbound',createdAt:at('12T10:00:00')},
 {_id:'a',direction:'outbound',author:'ai',status:'sent',createdAt:at('12T10:01:00')}
 ],at('12T00:00:00'));assert.equal(rows.length,0);
});

test('resolution counts the full wait and a later staff reply extends the same sample once',()=>{
 const c={assignedTo:'A',earningsResolutions:[{at:at('12T15:10:00'),by:'A',status:'resolved'}]};
 const messages=[{_id:'q',direction:'inbound',createdAt:at('12T15:00:00')}];
 let rows=replay(c,messages,at('12T00:00:00'));
 assert.equal(rows.length,1);assert.equal(summarize(rows,defaults,at('13T12:00:00'))[0].averageMs,10*60000);
 messages.push({_id:'reply',direction:'outbound',author:'A',status:'sent',createdAt:at('12T16:00:00')});
 rows=replay(c,messages,at('12T00:00:00'));assert.equal(rows.length,1);assert.equal(rows[0].reply,'reply');
 assert.equal(summarize(rows,defaults)[0].averageMs,60*60000);
 c.earningsResolutions[0].at=at('12T16:00:00');
 assert.equal(summarize(replay(c,messages.slice(0,1),at('12T00:00:00')),defaults)[0].averageMs,60*60000);
});
test('new inbound after resolving preserves the old sample and starts a fresh wait',()=>{
 const c={assignedTo:'A',earningsResolutions:[{at:at('12T15:10:00'),by:'A',status:'resolved'}]};
 const rows=replay(c,[{_id:'q',direction:'inbound',createdAt:at('12T15:00:00')},{_id:'new',direction:'inbound',createdAt:at('12T17:00:00')},{_id:'reply',direction:'outbound',author:'A',status:'sent',createdAt:at('12T17:20:00')}],at('12T00:00:00'));
 assert.equal(rows.length,2);assert.equal(+rows[0].endedAt,+at('12T15:10:00'));assert.equal(+rows[1].startedAt,+at('12T17:00:00'));
 assert.equal(summarize(rows,defaults)[0].averageMs,15*60000);
});
test('notes, failed replies and automated reminders cannot extend a resolved wait',()=>{
 const c={assignedTo:'A',earningsResolutions:[{at:at('12T15:10:00'),by:'A',status:'resolved'}]};
 const messages=[{_id:'q',direction:'inbound',createdAt:at('12T15:00:00')},
 {direction:'internal',author:'A',createdAt:at('12T16:00:00')},
 {direction:'outbound',author:'A',status:'failed',createdAt:at('12T16:30:00')},
 ...[{author:'admin',automation:{followup:'invoice'}},{author:'admin',courseReminder:{invoice:'course'}},{author:'ai'},{author:'admin',clientKey:'course-link:example'}].map(m=>({...m,direction:'outbound',status:'sent',createdAt:at('13T13:00:00')}))];
 const rows=replay(c,messages,at('12T00:00:00'));assert.equal(rows.length,1);assert.equal(summarize(rows,defaults,at('14T12:00:00'))[0].averageMs,10*60000);
});
test('transfer after resolution cannot erase earlier time when staff later reply',()=>{
 const c={assignedTo:'B',earningsOwnership:[{at:at('12T15:30:00'),from:'A',to:'B'}],earningsResolutions:[{at:at('12T15:10:00'),by:'A',status:'resolved'}]};
 const messages=[{_id:'q',direction:'inbound',createdAt:at('12T15:00:00')}];
 assert.equal(summarize(replay(c,messages,at('12T00:00:00')),defaults)[0].averageMs,10*60000);
 messages.push({_id:'reply',direction:'outbound',author:'B',status:'sent',createdAt:at('12T16:00:00')});
 const rows=replay(c,messages,at('12T00:00:00'));assert.equal(rows.length,2);
 for(const staff of ['A','B'])assert.equal(summarize(rows.filter(r=>r.staff===staff),defaults)[0].averageMs,30*60000);
});

test('a different human replying after resolution cannot erase the recorded handling time',()=>{
 const c={assignedTo:'A',earningsResolutions:[{at:at('12T15:10:00'),by:'A',status:'resolved'}]};
 const rows=replay(c,[{_id:'q',direction:'inbound',createdAt:at('12T15:00:00')},{_id:'admin-reply',direction:'outbound',author:'admin',status:'sent',createdAt:at('12T16:00:00')}],at('12T00:00:00'));
 assert.equal(rows.length,1);assert.equal(summarize(rows,defaults)[0].averageMs,60*60000);
});
