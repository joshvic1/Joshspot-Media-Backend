const {test}=require('node:test');const assert=require('node:assert/strict');
const {measure,view}=require('./availability');const {defaults}=require('./routes');
const at=s=>new Date(`2026-10-${s}+01:00`);
test('offline allowance accumulates all breaks and charges completed five-minute blocks',()=>{
 for(const [minutes,amount] of [[60,0],[64,0],[65,1000],[69,1000],[70,2000]]){
  const record={day:'2026-10-12',intervals:[{start:at('12T08:00:00'),end:at('12T08:30:00')},{start:at('12T09:00:00'),end:new Date(+at('12T09:00:00')+(minutes-30)*60000)}]};
  const result=measure(record,defaults,at('12T20:00:00'));assert.equal(result.offlineMs,minutes*60000);assert.equal(result.offlineDeduction,amount);
 }
});
test('open break stops at closing and never counts Sunday',()=>{
 const record={day:'2026-10-10',offline:true,intervals:[{start:at('10T19:30:00')}]};
 assert.equal(measure(record,defaults,at('12T10:00:00')).offlineMs,30*60000);
 assert.equal(view(record,defaults,at('10T20:01:00')).offline,false);
 assert.equal(measure({day:'2026-10-11',intervals:[{start:at('11T08:00:00')}]},defaults,at('11T19:00:00')).offlineMs,0);
});
