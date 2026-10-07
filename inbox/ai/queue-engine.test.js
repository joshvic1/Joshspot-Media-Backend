// In-memory mocked persistence only. No database, provider or paid model calls.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {Message,Conversation}=require('../models');
const settings=require('./config'),live=require('../live'),worker=require('./worker');
test('legacy structured debug version cannot cancel valid replies or handoff acknowledgments',async()=>{
 const originals=[Message.findOneAndUpdate,Conversation.updateOne,Conversation.findOne,settings.getConfig,live.notify];
 let row;
 Message.findOneAndUpdate=async(q,u)=>({...u.$setOnInsert,_id:'out',createdAt:new Date()});
 Conversation.updateOne=async()=>({matchedCount:1});
 Conversation.findOne=q=>({lean:async()=>q['ai.version']===4?{}:null});
 settings.getConfig=async()=>row;live.notify=()=>{};
 try{
  for(const engineVersion of ['v1','shadow'])for(const handoff of [false,true]){
   row={revision:30,data:{engineVersion,enabled:true,mode:'LIVE',autoReply:true}};
   const msg=await worker.queue({_id:'chat',ai:{version:4}},{response:'Test',debug:{engineVersion:2},engineVersion:'2',handoff},row,'in','key');
   assert.equal(msg.automation.engineVersion,'v1');assert.equal(await worker.eligible(msg),true);
   row={...row,revision:31};assert.equal(await worker.eligible(msg),false);
   row={...row,revision:30};msg.automation.version=3;assert.equal(await worker.eligible(msg),false);
  }
 }finally{[Message.findOneAndUpdate,Conversation.updateOne,Conversation.findOne,settings.getConfig,live.notify]=originals;}
});
