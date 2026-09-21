const assert=require("node:assert/strict"),fs=require("node:fs"),vm=require("node:vm"),path=require("node:path");
function load(file,deps){const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,"..",file),"utf8"),{module,exports:module.exports,require:key=>{if(!(key in deps))throw Error(key);return deps[key];},console,process:{env:{}}});return module.exports;}
const response=()=>({code:200,setHeader(){},status(n){this.code=n;return this;},json(data){this.data=data;return this;}});
(async()=>{
let saved;
const ads=load("controllers/adsController.js",{"../models/AdsClient":{create:async data=>{saved=data;return data;}}});
const body={businessName:"Test",videoLinks:"https://example.com/video",servicePaidFor:"TikTok DM Ads",clientNumber:"+234 800 000 0000"};
for(const role of ["ADMIN","CSS","SS"]){let res=response();await ads.createAdsClient({staff:{role},body:{...body}},res);assert.equal(res.code,201);assert.equal(saved.clientNumber,body.clientNumber);}
for(const number of [undefined,"","abc"]){let res=response();await ads.createAdsClient({staff:{role:"CSS"},body:{...body,clientNumber:number}},res);assert.equal(res.code,400);}
let res=response();await ads.createAdsClient({staff:{role:"SES"},body},res);assert.equal(res.code,403);
const records=[{_id:"a",product:"ads-course",status:"paid",amount:8000},{_id:"w",product:"whatsapp-course",status:"paid",amount:10000},{_id:"wp",product:"whatsapp-course",status:"pending",amount:10000,createdAt:new Date()},{_id:"legacy",product:"",status:"paid",amount:8000,note:"Course purchase - WhatsApp: 0800"}];
const courses=load("controllers/courseAdminController.js",{"../models/Invoice":{find:()=>({sort:()=>({lean:async()=>records})})},resend:{}, "./invoiceController":{}, "../utils/courseAccess":require("../utils/courseAccess")});
res=response();await courses.listCoursePayments({query:{course:"whatsapp-course"}},res);assert.equal(res.data.total,2);assert.equal(res.data.summary.paid,1);assert.equal(res.data.summary.revenue,10000);assert.ok(res.data.records.every(r=>r.product==="whatsapp-course"));
res=response();await courses.listCoursePayments({query:{course:"ads-course"}},res);assert.equal(res.data.total,2);assert.equal(res.data.summary.revenue,16000);
res=response();await courses.listCoursePayments({query:{course:"whatsapp-course",status:"paid"}},res);assert.equal(res.data.total,1);assert.equal(res.data.records[0].courseName,"WhatsApp Status ads");
res=response();await courses.listCoursePayments({query:{course:"unknown"}},res);assert.equal(res.code,400);
console.log("PASS: ads phone persisted for creators, missing/invalid phone rejected, setup cannot create; course filters, per-course totals, paid filter, legacy classification.");
})().catch(error=>{console.error(error);process.exitCode=1;});

