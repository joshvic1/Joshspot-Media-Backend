// Isolated MongoDB and storage stub. Does not load .env or contact production.
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const mongoose=require('mongoose');
const jwt=require('jsonwebtoken');
const {MongoMemoryServer}=require('mongodb-memory-server');
const {Post,Image}=require('./models');
const {clean}=require('./content');
const storage=require('../utils/r2Storage');
const {Readable}=require('node:stream');
let mongo,server,base,token,original,stored;
before(async()=>{
  process.env.JWT_SECRET='blog-test-only-secret';
  mongo=await MongoMemoryServer.create();await mongoose.connect(mongo.getUri());await Post.init();
  original=storage.getR2Client;storage.getR2Client=()=>({send:async command=>{if(command.input.Body){stored=command.input.Body;return {};}return {Body:Readable.from(stored)};}});
  const app=express();app.use(express.json({limit:'8mb'}));app.use('/blog',require('./routes'));
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}/blog`;token=jwt.sign({admin:true},process.env.JWT_SECRET);
});
after(async()=>{storage.getR2Client=original;if(server)await new Promise(r=>server.close(r));await mongoose.disconnect();if(mongo)await mongo.stop();});
async function request(path,method='GET',body,auth=token){const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(auth?{authorization:auth}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json().catch(()=>null)};}
const sample={title:'Grow your business',slug:'grow-your-business',html:'<h2>A useful guide</h2><p>Hello <strong>world</strong>.</p>',status:'draft',category:'Advertising'};
test('sanitizes pasted HTML while keeping article formatting',()=>{
  const html=clean('<h1>Hello</h1><p onclick="bad()" style="position:fixed;text-align:center;color:#123456">Text<script>alert(1)</script></p><a href="javascript:alert(1)">bad</a><img src="data:image/svg+xml,bad" onerror="bad()"><img src="https://example.test/photo.jpg" alt="Photo"><table><tr><td>Cell</td></tr></table>');
  assert.ok(html.includes('<h2>Hello</h2>'));assert.ok(html.includes('text-align:center'));assert.ok(html.includes('table'));assert.ok(html.includes('https://example.test/photo.jpg'));
  for(const unsafe of ['onclick','onerror','javascript:','data:image','<script','position:fixed'])assert.equal(html.includes(unsafe),false);
});
test('admin-only lifecycle, private drafts, safe updates, immediate unpublish and delete',async()=>{
  assert.equal((await request('/admin/posts','POST',sample,null)).status,401);
  assert.equal((await request('/admin/posts','GET',undefined,jwt.sign({role:'SS'},process.env.JWT_SECRET))).status,401);
  assert.equal((await request('/admin/posts','POST',{...sample,title:''})).status,400);
  assert.equal((await request('/admin/posts','POST',{...sample,status:'published',html:'<script>x</script>'})).status,400);
  const created=await request('/admin/posts','POST',sample);assert.equal(created.status,201);
  assert.equal((await request('/posts')).data.total,0);assert.equal((await request('/posts/'+sample.slug)).status,404);assert.equal((await request('/sitemap')).data.length,0);
  assert.equal((await request('/admin/posts','POST',sample)).status,409);
  const published=await request('/admin/posts/'+created.data._id,'PUT',{...created.data,status:'published'});assert.equal(published.status,200);
  assert.ok(published.data.seoUpdatedAt);
  const unchanged=await request('/admin/posts/'+created.data._id,'PUT',{...published.data});assert.equal(unchanged.data.seoUpdatedAt,published.data.seoUpdatedAt);published.data=unchanged.data;
  const post=(await request('/posts/'+sample.slug)).data;assert.equal(post.title,sample.title);assert.ok(post.html.includes('strong'));assert.equal(post.createdAt,undefined);assert.equal(post.author,undefined);assert.equal(post.publishedAt,undefined);
  assert.equal((await request('/posts')).data.total,1);assert.equal((await request('/sitemap')).data[0].slug,sample.slug);
  assert.equal((await request('/admin/posts/'+created.data._id,'PUT',{...created.data,title:'Stale edit'})).status,409);
  const draft=await request('/admin/posts/'+created.data._id,'PUT',{...published.data,status:'draft'});assert.equal(draft.status,200);assert.equal((await request('/posts/'+sample.slug)).status,404);
  assert.equal((await request('/admin/posts/'+created.data._id,'DELETE')).status,200);assert.equal(await Post.countDocuments(),0);
});
test('image upload validates signatures, requires admin and returns durable image URL',async()=>{
  assert.equal((await request('/admin/images','POST',{data:'data:image/png;base64,YmFk'})).status,400);
  const data='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=';
  assert.equal((await request('/admin/images','POST',{data},null)).status,401);
  const uploaded=await request('/admin/images','POST',{data});assert.equal(uploaded.status,201);
  const image=await fetch(base+uploaded.data.url.replace('/api/blog',''));assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');assert.ok((await image.arrayBuffer()).byteLength>8);assert.equal(await Image.countDocuments(),1);
});
