const {test}=require('node:test');const assert=require('node:assert/strict');const settings=require('./generalSettings');
test('gateway defaults, save validation and unavailable providers',async()=>{
 const oldFind=settings.Settings.findById,oldUpdate=settings.Settings.findByIdAndUpdate,oldSecret=process.env.PAYSTACK_SECRET;let stored=null;
 settings.Settings.findById=()=>({lean:async()=>stored});settings.Settings.findByIdAndUpdate=async(id,update)=>{stored=update.$set;};
 const response=()=>({code:200,status(n){this.code=n;return this},json(v){this.body=v;}});
 try{assert.equal(await settings.gateway(),'flutterwave');let res=response();await settings.save({body:{courseGateway:'other'}},res);assert.equal(res.code,400);delete process.env.PAYSTACK_SECRET;res=response();await settings.save({body:{courseGateway:'paystack'}},res);assert.equal(res.code,400);assert.equal(stored,null);process.env.PAYSTACK_SECRET='synthetic';res=response();await settings.save({body:{courseGateway:'paystack'}},res);assert.equal(res.code,200);assert.equal(await settings.gateway(),'paystack');assert.equal(JSON.stringify(res.body).includes('synthetic'),false);}finally{settings.Settings.findById=oldFind;settings.Settings.findByIdAndUpdate=oldUpdate;if(oldSecret===undefined)delete process.env.PAYSTACK_SECRET;else process.env.PAYSTACK_SECRET=oldSecret;}
});
