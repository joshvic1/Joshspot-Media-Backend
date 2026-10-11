const {test}=require('node:test'),assert=require('node:assert/strict');
const {inbox,crm,required,validate}=require('./staffPermissions');
function run(guard,req){let result=200;guard(req,{status(code){result=code;return this},json(){}},()=>{});return result;}
test('permissions block API actions while defaults and admin remain allowed',()=>{
 for(const [path,method,body,key] of [
 ['/conversations/id/messages','POST',{type:'text'},'messages'],
 ['/conversations/id/messages','POST',{type:'note'},'notes'],
 ['/conversations/id/messages','POST',{type:'template'},'templates'],
 ['/conversations/id/messages','POST',{type:'audio'},'media'],
 ['/conversations/id/actions/invoice','POST',{},'invoice'],
 ['/conversations/id/actions/payment','POST',{},'payment'],
 ['/conversations/id/actions/crm/setup/id','PUT',{},'setup.edit'],
 ['/conversations/id','PUT',{followUpAt:null},'followUps'],
 ['/ai/conversations/id/control','POST',{},'aiControl'],
 ]){const req={path,method,body,staff:{permissions:{[key]:false}}};assert.equal(required(req).includes(key),true);assert.equal(run(inbox,req),403);assert.equal(run(inbox,{...req,staff:{}}),200);assert.equal(run(inbox,{...req,staff:{admin:true}}),200);}
 assert.equal(run(crm('ads.edit'),{staff:{permissions:{'ads.edit':false}}}),403);
 assert.throws(()=>validate({invoice:'yes'}));assert.throws(()=>validate({admin:true}));
});
