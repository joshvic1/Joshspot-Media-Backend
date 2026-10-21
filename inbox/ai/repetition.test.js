const {test}=require('node:test');
const assert=require('node:assert/strict');
const {protect}=require('./repetition');
const text='Do you want us to set up your ads account for you, then teach you how to access it and run the ads yourself?\n\nOr\n\nDo you want us to run the ads straight up for you?';
const result={action:'reply',response:text,state:{}};
const sent={_id:'previous',direction:'outbound',author:'ai',status:'delivered',text};
test('Evil BTC repetition hands off; formatting differences also match',()=>{
 const r=protect({...result,response:text.toUpperCase()},'Yes run the ads straight for me',[sent]);
 assert.equal(r.handoff,'AI_REPEATED_RESPONSE');assert.equal(r.handoffTeam,'SS');assert.equal(r.response,'');assert.equal(r.suppressAcknowledgement,true);
});
test('customer requests to resend or clarify permit repetition',()=>{
 for(const message of ['Please resend','Send it again','Abeg explain it again','Please repeat','What do you mean?','I do not understand, explain it again'])assert.equal(protect(result,message,[sent]),result,message);
 assert.equal(protect(result,"Don't repeat that",[sent]).action,'handoff');
});
test('failed, unsent, notes, staff replies and reminders are not evidence',()=>{
 for(const override of [{status:'failed'},{status:'queued'},{direction:'internal'},{author:'admin'},{automation:{followup:true}},{automation:{handoff:true}}])assert.equal(protect(result,'Run it for me',[{...sent,...override}]),result);
});
test('new prices and useful new answers are not rejected; invoice actions untouched',()=>{
 assert.equal(protect({...result,response:'The total price is 35000 naira for 2 days.'},'2 days',[{...sent,text:'The total price is 60000 naira for 7 days.'}]).action,'reply');
 assert.equal(protect({...result,response:'What is your budget and duration?'},'Run it for me',[sent]).action,'reply');
 assert.equal(protect({...result,action:'invoice'},'Send account',[sent]).action,'invoice');
});
