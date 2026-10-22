const mongoose=require('mongoose');
const Settings=mongoose.model('GeneralSettings',new mongoose.Schema({_id:{type:String,default:'general'},courseGateway:{type:String,enum:['paystack','flutterwave'],default:'flutterwave'}},{timestamps:true}));
const ready=(provider)=>provider==='paystack'?Boolean(process.env.PAYSTACK_SECRET):provider==='flutterwave'&&Boolean(process.env.FLUTTERWAVE_SECRET_KEY&&process.env.FLUTTERWAVE_WEBHOOK_SECRET);
async function gateway(){const row=await Settings.findById('general').lean();return row?.courseGateway||'flutterwave';}
async function snapshot(){return {courseGateway:await gateway(),providers:{paystack:{ready:ready('paystack')},flutterwave:{ready:ready('flutterwave')}}};}
async function get(req,res){try{res.json(await snapshot());}catch{res.status(503).json({message:'Unable to load payment settings.'});}}
async function save(req,res){const provider=req.body.courseGateway;if(!['paystack','flutterwave'].includes(provider))return res.status(400).json({message:'Choose Paystack or Flutterwave.'});if(!ready(provider))return res.status(400).json({message:'The selected provider is not configured. Add its required backend keys first.'});try{await Settings.findByIdAndUpdate('general',{$set:{courseGateway:provider}},{upsert:true,runValidators:true});res.json(await snapshot());}catch{res.status(503).json({message:'Unable to save payment settings.'});}}
module.exports={Settings,ready,gateway,get,save};
