const mongoose=require('mongoose');
const {Schema}=mongoose;
const thread=new Schema({pair:{type:String,required:true,unique:true},participants:{type:[String],required:true},lastMessageAt:{type:Date,default:Date.now},lastMessageId:Schema.Types.ObjectId,preview:{type:String,default:''},reads:{type:Map,of:Schema.Types.ObjectId,default:{}},received:{type:Map,of:Schema.Types.ObjectId,default:{}}},{timestamps:true});
thread.index({participants:1,lastMessageAt:-1,_id:-1});
const message=new Schema({thread:{type:Schema.Types.ObjectId,required:true},sender:{type:String,required:true},senderName:String,recipient:{type:String,required:true},text:{type:String,required:true,maxlength:10000},clientKey:{type:String,required:true,unique:true},notificationPending:{type:Boolean,default:true},reactions:{type:Map,of:String,default:{}}},{timestamps:true});
message.index({thread:1,_id:-1});message.index({thread:1,recipient:1,_id:1});message.index({notificationPending:1,_id:1});
module.exports={Thread:mongoose.model('InboxStaffThread',thread),StaffMessage:mongoose.model('InboxStaffMessage',message)};
