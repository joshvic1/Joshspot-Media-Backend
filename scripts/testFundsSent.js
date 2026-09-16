const assert = require('node:assert/strict');
const Model = require('../models/AdsClient');
const {updateAdsClient} = require('../controllers/adsController');
let updates=[];
Model.findByIdAndUpdate=async(id,update)=>{updates.push(update);return {_id:id,...update}};
const res=()=>({code:200,status(n){this.code=n;return this},json(v){this.data=v;return this}});
(async()=>{
for(const role of ['SS','CSS','SES']){let r=res();await updateAdsClient({staff:{role},body:{fundsSent:true},params:{id:'id'}},r);assert.equal(r.code,403)}
assert.equal(updates.length,0);
for(const value of [true,false]){let r=res();await updateAdsClient({staff:{role:'ADMIN',admin:true},body:{fundsSent:value},params:{id:'id'}},r);assert.equal(r.code,200);assert.equal(r.data.fundsSent,value);assert.equal(updates.at(-1).adsPublished,undefined)}
let r=res();await updateAdsClient({staff:{role:'ADMIN',admin:true},body:{fundsSent:'false'},params:{id:'id'}},r);assert.equal(r.code,400);
console.log('Funds status permissions, validation and independent updates passed.');
assert.equal(new Model().fundsStatus,'pending');
assert.equal(new Model({fundsSent:true}).fundsStatus,'sent');
for(const role of ['SS','CSS','SES']){let r=res();await updateAdsClient({staff:{role},body:{fundsStatus:'sent'},params:{id:'id'}},r);assert.equal(r.code,403)}
for(const value of ['pending','sent','not_needed','pending']){let r=res();await updateAdsClient({staff:{role:'ADMIN',admin:true},body:{fundsStatus:value},params:{id:'id'}},r);assert.equal(r.code,200);assert.equal(r.data.fundsStatus,value);assert.equal(r.data.fundsSent,value==='sent');assert.equal(updates.at(-1).adsPublished,undefined)}
for(const value of ['invalid',null,true]){let r=res();await updateAdsClient({staff:{role:'ADMIN',admin:true},body:{fundsStatus:value},params:{id:'id'}},r);assert.equal(r.code,400)}
console.log('Three funds statuses, defaults, legacy compatibility and staff restrictions passed.');
})().catch(e=>{console.error(e);process.exitCode=1});
