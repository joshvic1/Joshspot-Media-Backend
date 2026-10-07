const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fakeOpenai}=require('./fakeOpenai.test-helper');
const {decide}=require('./index');
const {config,records}=require('../defaults');
const {prepare}=require('./context');
const inbound=(id,text='Hi')=>({_id:id,direction:'inbound',type:'text',status:'received',text});
const outbound=(id,text,status='sent')=>({_id:id,direction:'outbound',type:'text',status,text});
const final=text=>({output:[{type:'message',content:[{type:'output_text',text}]}]});
const fc=(name,args,id=name)=>({type:'function_call',name,arguments:JSON.stringify(args),call_id:id});
const ports=()=>({assertCurrent:async()=>{},persist:async()=>{},invoiceStatus:async()=>({status:'NONE'})});

test('provider failure produces no invented reply or side effect and cleans tentative output',async()=>{
 const api=fakeOpenai([()=>{throw new Error('PROVIDER_UNAVAILABLE');}]),state={};let effects=0;
 await assert.rejects(decide({config,records,messages:[inbound('failure')],state,ports:{...ports(),createInvoice:async()=>{effects++;}},api}),/PROVIDER_UNAVAILABLE/);
 assert.equal(effects,0);assert.equal(state.dirty,false);
 assert.equal(api.conversations.get(state.openaiConversationId).length,1);
});
test('all calls receive matching outputs, then ONE composed reply; no model work persists as delivered',async()=>{
 const api=fakeOpenai([{output:[fc('get_services',{},'a'),fc('get_business_knowledge',{keys:['setup_vs_management']},'b')]},final('Setup gives you an account to run yourself. Would you prefer us to manage it?')]);
 const state={};const result=await decide({config,records,messages:[inbound('a')],state,ports:ports(),api});
 assert.equal(result.action,'reply');assert.equal(result.debug.tools.length,2);
 const second=api.requests.filter(r=>r.response)[2].response;assert.deepEqual(second.input.filter(i=>i.type==='function_call_output').map(i=>i.call_id),['a','b']);
 assert.equal(state.dirty,false);assert.equal(api.conversations.get(state.openaiConversationId).length,1);
});
test('generated DRAFT is removed; actual later sent wording is synchronized exactly once',async()=>{
 const api=fakeOpenai([final('This is an unsent draft.'),final('Thanks for choosing management.')]),state={};
 await decide({config,records,messages:[inbound('1')],state,ports:ports(),api});const id=state.openaiConversationId;
 await decide({config,records,messages:[inbound('3','Management')],history:[inbound('1'),outbound('2','Setup or management?'),outbound('failed','Wrong question','failed')],state,ports:ports(),api});
 assert.equal(state.openaiConversationId,id);const content=JSON.stringify(api.conversations.get(id));assert.ok(content.includes('Setup or management?'));assert.ok(!content.includes('unsent draft'));assert.ok(!content.includes('Wrong question'));assert.equal(api.conversations.get(id).length,3);
});
test('missing/dirty remote context recovers from bounded actual messages, not old semantic state',async()=>{
 const api=fakeOpenai(),state={openaiConversationId:'missing',core:{selectedPlatform:'WRONG'}};
 const cleanup=await prepare({api,state,messages:[inbound('1'),outbound('2','Actual question'),outbound('3','Unsent','queued')],persist:async()=>{}});await cleanup();
 assert.notEqual(state.openaiConversationId,'missing');const wire=JSON.stringify(api.requests);assert.ok(!wire.includes('WRONG'));assert.ok(!wire.includes('Unsent'));
});
test('compaction rotates with advisory summary and no consent flags',async()=>{
 const api=fakeOpenai(),state={contextCharacters:0};let cleanup=await prepare({api,state,messages:[inbound('1')],persist:async()=>{}});await cleanup();const old=state.openaiConversationId;state.contextCharacters=80000;
 cleanup=await prepare({api,state,messages:[inbound('1'),inbound('2')],persist:async()=>{}});await cleanup();assert.notEqual(state.openaiConversationId,old);assert.ok(state.summary);assert.ok(!('paymentConsent' in state));
});
test('a burst is ONE turn and includes every inbound message',async()=>{
 const api=fakeOpenai([final('Would you like setup or management?')]);
 await decide({config,records,messages:[inbound('1','Hi'),inbound('2','I want TikTok ads'),inbound('3','How much is it?')],ports:ports(),api});
 assert.equal(api.requests.filter(r=>r.response).length,2);assert.equal([...api.conversations.values()][0].length,3);
});
test('tool loop stops within eight model iterations including required plan',async()=>{
 const api=fakeOpenai(Array.from({length:8},()=>({output:[fc('get_services',{})]})));
 await assert.rejects(decide({config,records,messages:[inbound('1')],ports:ports(),api}),/NO_FINAL_RESPONSE/);
 assert.equal(api.requests.filter(r=>r.response).length,8);
});
test('takeover during model call discards response',async()=>{
 let taken=false;const p=ports();p.assertCurrent=async()=>{if(taken)throw new Error('V3_OWNERSHIP_CHANGED');};
 const api=fakeOpenai([()=>{taken=true;return final('Do not send me');}]);
 await assert.rejects(decide({config,records,messages:[inbound('1')],ports:p,api}),/OWNERSHIP/);
});
test('unsupported media and sensitive data require handoff before any model call',async()=>{
 const api=fakeOpenai();const result=await decide({config,records,messages:[{...inbound('1'),type:'audio'}],ports:ports(),api});assert.equal(result.handoff,'MEDIA_RECEIVED');assert.equal(api.requests.length,0);
});
test('live cannot be entered accidentally by a test runner',async()=>{
 await assert.rejects(decide({config,records,messages:[inbound('1')],ports:ports(),api:fakeOpenai(),simulation:false}),/LIVE_NOT_RELEASED/);
});
