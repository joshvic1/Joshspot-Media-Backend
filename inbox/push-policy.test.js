const test=require('node:test');
const assert=require('node:assert/strict');
const push=require('./push');
test('supported alert types record events but unknown types do not',async t=>{
 const writes=[];t.mock.method(push.Event,'updateOne',async(...args)=>writes.push(args));
 for(const kind of ['assignments','messages','followups','new_chats','mentions','staff_messages'])await push.record(kind,kind,'conversation','staff');
 assert.equal(writes.length,6);await push.record('unknown','unknown','conversation','staff');assert.equal(writes.length,6);
});
test('old preferences stay quiet until the user opts in to expanded alerts',async t=>{
 const handlers={};const router={get:(p,h)=>handlers[p]=h,post:(p,h)=>handlers[p]=h,put:(p,h)=>handlers[p]=h,delete:()=>{}};
 push.routes(router,h=>h,async()=>{});
 t.mock.method(push.Subscription,'findOne',()=>({lean:async()=>({preferences:{assignments:true,messages:true,mentions:true,followups:true}})}));
 let result;const res={json:data=>result=data};
 await handlers['/push/preferences']({body:{endpoint:'https://fcm.googleapis.com/test'},actor:{id:'staff'}},res);
 assert.deepEqual(result.preferences,{assignments:false,messages:false,mentions:true,followups:false,new_chats:false,staff_messages:true,previews:true});
 const keys=['INBOX_PUSH_PUBLIC_KEY','INBOX_PUSH_PRIVATE_KEY','INBOX_PUSH_SUBJECT'];const before=keys.map(k=>process.env[k]);keys.forEach(k=>process.env[k]='test');
 t.after(()=>keys.forEach((k,i)=>before[i]===undefined?delete process.env[k]:process.env[k]=before[i]));
 let saved;t.mock.method(push.Subscription,'findOneAndUpdate',async(q,u)=>saved=u.$set.preferences);
 await handlers['/push/subscription']({actor:{id:'staff'},body:{subscription:{endpoint:'https://fcm.googleapis.com/test',keys:{p256dh:'a'.repeat(87),auth:'b'.repeat(22)}},preferences:{assignments:true,messages:true,mentions:true,followups:true}}},res);
 assert.deepEqual(saved,{customizationVersion:1,assignments:true,messages:true,mentions:true,followups:true,new_chats:false,staff_messages:true,previews:true});
});

test('new devices default all notification types on except every message',async t=>{
 const handlers={};const router={get:(p,h)=>handlers[p]=h,post:(p,h)=>handlers[p]=h,put:(p,h)=>handlers[p]=h,delete:()=>{}};push.routes(router,h=>h,async()=>{});
 t.mock.method(push.Subscription,'findOne',()=>({lean:async()=>null}));let result;
 await handlers['/push/preferences']({body:{endpoint:'https://fcm.googleapis.com/test'},actor:{id:'staff'}},{json:data=>result=data});
 assert.deepEqual(result.preferences,{assignments:true,messages:false,mentions:true,followups:true,new_chats:true,staff_messages:true,previews:true});
});
