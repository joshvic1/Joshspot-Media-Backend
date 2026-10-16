const test=require('node:test');
const assert=require('node:assert/strict');
const push=require('./push');
test('only mentions are recorded; existing nonmention events remain ineligible',async t=>{
 const writes=[];t.mock.method(push.Event,'updateOne',async(...args)=>writes.push(args));
 for(const kind of ['assignments','messages','followups','unknown']){
  await push.record('test',kind,'conversation','staff');
  assert.equal(await push.eligible({id:'staff'},{kind,conversation:'conversation'}),false);
 }
 assert.equal(writes.length,0);
 await push.record('mention','mentions','conversation','staff','note');
 assert.equal(writes.length,1);assert.equal(writes[0][1].$setOnInsert.message,'note');
 assert.equal(writes[0][1].$setOnInsert.recipient,'staff');
});
test('existing device preferences cannot re-enable nonmention notifications',async t=>{
 const handlers={};const router={get:(p,h)=>handlers[p]=h,post:(p,h)=>handlers[p]=h,put:(p,h)=>handlers[p]=h,delete:()=>{}};
 push.routes(router,h=>h,async()=>{});
 t.mock.method(push.Subscription,'findOne',()=>({lean:async()=>({preferences:{assignments:true,messages:true,mentions:true,followups:true}})}));
 let result;const res={json:data=>result=data};
 await handlers['/push/preferences']({body:{endpoint:'https://fcm.googleapis.com/test'},actor:{id:'staff'}},res);
 assert.deepEqual(result.preferences,{assignments:false,messages:false,mentions:true,followups:false,previews:true});
 const keys=['INBOX_PUSH_PUBLIC_KEY','INBOX_PUSH_PRIVATE_KEY','INBOX_PUSH_SUBJECT'];const before=keys.map(k=>process.env[k]);keys.forEach(k=>process.env[k]='test');
 t.after(()=>keys.forEach((k,i)=>before[i]===undefined?delete process.env[k]:process.env[k]=before[i]));
 let saved;t.mock.method(push.Subscription,'findOneAndUpdate',async(q,u)=>saved=u.$set.preferences);
 await handlers['/push/subscription']({actor:{id:'staff'},body:{subscription:{endpoint:'https://fcm.googleapis.com/test',keys:{p256dh:'a'.repeat(87),auth:'b'.repeat(22)}},preferences:{assignments:true,messages:true,mentions:true,followups:true}}},res);
 assert.deepEqual(saved,{assignments:false,messages:false,mentions:true,followups:false,previews:true});
});
