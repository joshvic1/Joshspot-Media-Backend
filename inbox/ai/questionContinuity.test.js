const test=require('node:test'),assert=require('node:assert/strict');
const {history,applyV4,instructions}=require('./questionContinuity');
const pack=(purchase,readiness='UNKNOWN')=>({purchase,readiness,allowedQuestions:['service','platform','budget','budget_basis','duration','proceed','payment'],actions:{}});
test('only delivered outgoing questions and actual customer answers become context',()=>{
 const rows=['queued','failed','cancelled','sent','delivered','read'].map((status,i)=>({_id:String(i),direction:'outbound',status,text:'Which platform?'}));rows.push({direction:'internal',text:'Ask for budget'});rows.push({direction:'inbound',text:'TikTok'});
 assert.deepEqual(history(rows).map(r=>r.role),['assistant','assistant','assistant','user']);assert.equal(history(rows).at(-1).text,'TikTok');
});
test('already answered and partially answered details are not asked again',()=>{
 const p=applyV4(pack([{platform:'TIKTOK',service:'ADS_MANAGEMENT',duration:7}]));assert.deepEqual(p.allowedQuestions,['budget','budget_basis','proceed','payment']);
 const full=applyV4(pack([{platform:'TIKTOK',service:'ADS_MANAGEMENT',duration:7,budget:{amount:5000,basis:'DAILY_AD_SPEND'}}],'READY_TO_PAY'));assert.deepEqual(full.allowedQuestions,['payment']);
});
test('unknown fields remain available for focused follow-up; scopes are not flattened',()=>{
 const p=applyV4(pack([{platform:'TIKTOK',service:'ADS_MANAGEMENT',duration:7},{platform:'META',service:'ADS_MANAGEMENT'}]));assert.ok(p.allowedQuestions.includes('duration'));assert.ok(p.allowedQuestions.includes('budget'));assert.ok(!p.allowedQuestions.includes('platform'));
});
test('deferral and existing invoice remove repeated payment/proceed pressure',()=>{
 const p=pack([],'DEFERRED');applyV4(p);assert.ok(!p.allowedQuestions.includes('proceed'));assert.ok(!p.allowedQuestions.includes('payment'));
 const paid=pack([]);paid.verifiedPayment={status:'paid'};applyV4(paid);assert.ok(!paid.allowedQuestions.includes('payment'));
});
test('a correction uses latest resolved scope rather than stale previous answers',()=>{
 const p=applyV4(pack([{platform:'META',service:'ADS_MANAGEMENT',budget:{amount:10000,basis:'UNKNOWN'}}]));assert.ok(p.allowedQuestions.includes('duration'));assert.ok(p.allowedQuestions.includes('budget_basis'));assert.ok(!p.allowedQuestions.includes('budget'));
});
