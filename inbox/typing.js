const mongoose=require('mongoose');
const schema=new mongoose.Schema({conversation:mongoose.Schema.Types.ObjectId,actor:String,name:String,expiresAt:Date});
schema.index({conversation:1,actor:1},{unique:true});schema.index({expiresAt:1},{expireAfterSeconds:0});
module.exports=mongoose.model('InboxTyping',schema);
