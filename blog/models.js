const mongoose=require('mongoose');
const schema=new mongoose.Schema({title:String,slug:{type:String,unique:true,required:true},html:String,excerpt:String,category:String,cover:String,coverAlt:String,seoTitle:String,seoDescription:String,status:{type:String,enum:['draft','published'],default:'draft'},publishedAt:Date,seoUpdatedAt:Date},{timestamps:true});
schema.index({status:1,publishedAt:-1,_id:-1});
const imageSchema=new mongoose.Schema({key:String,mime:String,size:Number},{timestamps:true});
module.exports={Post:mongoose.model('BlogPost',schema),Image:mongoose.model('BlogImage',imageSchema)};
