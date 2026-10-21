const search=require('../search/indexNow');
const router=require('express').Router();
const {Post,Image}=require('./models');
const {validate}=require('./content');
const admin=require('../middleware/adminAuth');
const {PutObjectCommand,GetObjectCommand}=require('@aws-sdk/client-s3');
const storage=require('../utils/r2Storage');
const {randomUUID}=require('node:crypto');
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const validId=id=>/^[a-f\d]{24}$/i.test(id || '');
const card='title slug excerpt category cover coverAlt';
router.get('/posts',wrap(async(req,res)=>{
  const page=Math.max(1,Math.min(10000,parseInt(req.query.page,10)||1));
  const filter={status:'published'};
  const [items,total]=await Promise.all([Post.find(filter).select(card).sort({publishedAt:-1,_id:-1}).skip((page-1)*12).limit(12).lean(),Post.countDocuments(filter)]);
  res.json({items,total,page,pages:Math.max(1,Math.ceil(total/12))});
}));
router.get('/sitemap-info',wrap(async(req,res)=>{res.json({pages:Math.max(1,Math.ceil(await Post.countDocuments({status:'published'})/10000))});}));
router.get('/sitemap',wrap(async(req,res)=>{
  const rows=await Post.find({status:'published'}).select('slug seoUpdatedAt -_id').sort({_id:1}).skip((Math.max(1,Math.min(100000,parseInt(req.query.page,10)||1))-1)*10000).limit(10000).lean();res.json(rows);
}));
router.get('/posts/:slug',wrap(async(req,res)=>{
  const post=await Post.findOne({slug:req.params.slug,status:'published'}).select(`${card} html seoTitle seoDescription`).lean();
  if(!post)return res.status(404).json({message:'Article not found.'});
  res.json(post);
}));
router.get('/images/:id',wrap(async(req,res)=>{
  if(!validId(req.params.id))return res.status(404).end();
  const asset=await Image.findById(req.params.id).lean();if(!asset)return res.status(404).end();
  const object=await storage.getR2Client().send(new GetObjectCommand({Bucket:process.env.R2_BUCKET,Key:asset.key}));
  res.set({'Content-Type':asset.mime,'Content-Length':String(asset.size),'Cache-Control':'public, max-age=31536000, immutable','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex'});
  object.Body.on('error',()=>res.destroy());object.Body.pipe(res);
}));
router.use('/admin',admin,(req,res,next)=>{res.set('Cache-Control','private, no-store');next();});
router.get('/admin/posts',wrap(async(req,res)=>{
  const page=Math.max(1,parseInt(req.query.page,10)||1),filter={};
  if(['draft','published'].includes(req.query.status))filter.status=req.query.status;
  if(req.query.q)filter.title=new RegExp(String(req.query.q).slice(0,100).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i');
  const [items,total,drafts,published]=await Promise.all([Post.find(filter).select(`${card} status updatedAt __v`).sort({updatedAt:-1}).skip((page-1)*20).limit(20).lean(),Post.countDocuments(filter),Post.countDocuments({status:'draft'}),Post.countDocuments({status:'published'})]);
  res.json({items,total,pages:Math.max(1,Math.ceil(total/20)),drafts,published});
}));
router.get('/admin/posts/:id',wrap(async(req,res)=>{
  const post=validId(req.params.id)&&await Post.findById(req.params.id).lean();
  if(!post)return res.status(404).json({message:'Article not found.'});res.json(post);
}));
router.post('/admin/posts',wrap(async(req,res)=>{
  const data=validate(req.body);if(data.status==='published'){data.publishedAt=new Date();data.seoUpdatedAt=data.publishedAt;}
  const saved=await Post.create(data);await search.articleChanged(null,saved);res.status(201).json(saved);
}));
router.put('/admin/posts/:id',wrap(async(req,res)=>{
  if(!validId(req.params.id))return res.status(404).end();
  if(!Number.isInteger(req.body.__v)||req.body.__v<0)return res.status(400).json({message:'Reload this article before saving.'});
  const data=validate(req.body),old=await Post.findById(req.params.id).lean();
  if(!old)return res.status(404).json({message:'Article not found.'});
  if(data.status==='published'&&!old.publishedAt)data.publishedAt=new Date();
  if(data.status==='published'&&search.changed(old,data))data.seoUpdatedAt=new Date();
  const saved=await Post.findOneAndUpdate({_id:old._id,__v:req.body.__v},{$set:data,$inc:{__v:1}},{new:true});
  if(!saved)return res.status(409).json({message:'This article changed in another tab. Reload it before saving.'});await search.articleChanged(old,saved);res.json(saved);
}));
router.delete('/admin/posts/:id',wrap(async(req,res)=>{
  if(!validId(req.params.id))return res.status(404).end();
  const old=await Post.findOneAndDelete({_id:req.params.id}).lean();await search.articleChanged(old,null);res.json({ok:true});
}));
router.post('/admin/images',wrap(async(req,res)=>{
  const data=req.body.data;
  if(typeof data!=='string'||data.length>7100000)return res.status(400).json({message:'Choose an image smaller than 5 MB.'});
  const match=data.match(/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/);
  if(!match)return res.status(400).json({message:'Use a JPEG, PNG, WebP or GIF image.'});
  const buffer=Buffer.from(match[2],'base64');
  const signatures={png:buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpeg:buffer[0]===255&&buffer[1]===216&&buffer[2]===255,webp:buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP',gif:/^GIF8[79]a/.test(buffer.toString('ascii',0,6))};
  if(!signatures[match[1]]||buffer.length>5*1024*1024)return res.status(400).json({message:'Invalid image or image exceeds 5 MB.'});
  const key=`blog/${randomUUID()}.${match[1]}`,mime=`image/${match[1]}`;
  await storage.getR2Client().send(new PutObjectCommand({Bucket:process.env.R2_BUCKET,Key:key,Body:buffer,ContentType:mime}));
  const asset=await Image.create({key,mime,size:buffer.length});res.status(201).json({url:`/api/blog/images/${asset._id}`});
}));
router.use((error,req,res,next)=>{
  if(res.headersSent)return next(error);
  if(error.code===11000)return res.status(409).json({message:'That article URL is already used. Choose another.'});
  const isInput=error.status===400;
  res.status(isInput?400:503).json({message:isInput?error.message:'The blog service is temporarily unavailable. Please try again.'});
});
module.exports=router;
