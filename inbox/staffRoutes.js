const Staff=require('../models/Staff');const bcrypt=require('bcryptjs');
const permissions=require('./staffPermissions');
module.exports=(router,wrap,rateLimit)=>{
 const requireAdmin=req=>{if(!req.actor.admin)throw Object.assign(new Error('Administrator access required.'),{status:403})};
 router.get('/staff-management',wrap(async(req,res)=>{requireAdmin(req);const page=Math.max(0,Number(req.query.page)||0);if(!Number.isInteger(page)||page>10000)return res.status(400).json({message:'Invalid page.'});const rows=await Staff.find().select('name email role permissions createdAt').sort({_id:-1}).skip(page*20).limit(21).lean();res.json({permissions:permissions.definitions,items:rows.slice(0,20),next:rows.length>20?page+1:null})}));
 router.post('/staff-management',wrap(async(req,res)=>{
  requireAdmin(req);await rateLimit(req,10);const {name,email,password,role}=req.body;
  if(typeof name!=='string'||!name.trim()||name.length>100||typeof email!=='string'||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())||typeof password!=='string'||password.length<10||Buffer.byteLength(password)>72||!['CSS','SS','SES'].includes(role))return res.status(400).json({message:'Enter a name, valid email, role and password of at least 10 characters (maximum 72 bytes).'});
  try{const staff=await Staff.create({name:name.trim(),email:email.trim().toLowerCase(),password:await bcrypt.hash(password,12),role,permissions:permissions.validate(req.body.permissions||{})});res.status(201).json({id:staff._id,name:staff.name,email:staff.email,role:staff.role})}catch(e){if(e.code===11000)return res.status(409).json({message:'A staff account already uses this email.'});throw e;}
 }));
 router.put('/staff-management/:id',wrap(async(req,res)=>{
  requireAdmin(req);await rateLimit(req,20);
  if(!/^[a-f0-9]{24}$/i.test(req.params.id))return res.status(400).json({message:'Invalid staff account.'});
  const {name,email,role,password}=req.body;
  if(typeof name!=='string'||!name.trim()||name.length>100||typeof email!=='string'||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())||!['CSS','SS','SES'].includes(role))return res.status(400).json({message:'Enter a valid name, email and role.'});
  const changes={name:name.trim(),email:email.trim().toLowerCase(),role,permissions:permissions.validate(req.body.permissions||{})};
  if(password){if(typeof password!=='string'||password.length<10||Buffer.byteLength(password)>72)return res.status(400).json({message:'Password must contain at least 10 characters (maximum 72 bytes).'});changes.password=await bcrypt.hash(password,12);}
  try{const staff=await Staff.findByIdAndUpdate(req.params.id,{$set:changes},{returnDocument:'after',runValidators:true}).select('name email role permissions createdAt');if(!staff)return res.status(404).json({message:'Staff account not found.'});res.json(staff);}catch(e){if(e.code===11000)return res.status(409).json({message:'A staff account already uses this email.'});throw e;}
 }));
};
