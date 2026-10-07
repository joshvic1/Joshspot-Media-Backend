// Read-only production configuration/catalogue audit. No application models imported.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
(async()=>{
 if(fs.existsSync(path.join(__dirname,'production-snapshot.json')))throw Error('Refuse overwrite');
 const env=require('dotenv').parse(fs.readFileSync(path.join(root,'.env')));
 const {MongoClient}=require('mongodb');const client=new MongoClient(env.MONGO_URI||env.MONGODB_URI||env.MONGO_URL,{serverSelectionTimeoutMS:15000,monitorCommands:true});
 const commands=[];client.on('commandStarted',e=>{commands.push(e.commandName);if(!['find','getMore','killCursors','endSessions'].includes(e.commandName))throw Error('Unexpected command');});
 let config,records,modelEvidence,dbName;
 try{await client.connect();const db=client.db();dbName=db.databaseName;
 config=await db.collection('inboxaiconfigs').findOne({key:'main'},{projection:{changedBy:0}});
 records=await db.collection('inboxairecords').find({enabled:true,archived:{$ne:true}},{projection:{createdBy:0,changedBy:0}}).sort({kind:1,key:1}).toArray();
 modelEvidence=await db.collection('inboxailogs').find({kind:{$ne:'test'},model:{$type:'string'}},{projection:{_id:0,model:1,createdAt:1,configRevision:1}}).sort({createdAt:-1}).limit(5).toArray();
 }finally{await client.close();}
 const model=config.data.v3Model||config.data.model||env.OPENAI_MODEL;
 if(!model||!env.OPENAI_API_KEY)throw Error('Missing model/key');
 const snap={capturedAt:new Date().toISOString(),dbName,config,records,model,modelEvidence,modelSources:{v3Model:config.data.v3Model,model:config.data.model,localEnvironmentModel:env.OPENAI_MODEL},commands};
 fs.writeFileSync(path.join(__dirname,'production-snapshot.json'),JSON.stringify(snap,null,2),{flag:'wx'});
 const local=structuredClone(snap);const plan=local.records.find(r=>r.kind==='plan'&&r.key==='plan_15');if(!plan)throw Error('Missing plan');
 const before=plan.data.amount;plan.data.amount=265000;
 local.localCorrection={key:'plan_15',field:'data.amount',before,after:265000,authority:'Owner instruction 2026-10-07; calculator unchanged'};
 fs.writeFileSync(path.join(__dirname,'evaluation-snapshot.json'),JSON.stringify(local,null,2),{flag:'wx'});
 const findings=records.filter(r=>JSON.stringify(r.data).match(/285000|285,000/)).map(r=>({collection:'inboxairecords',id:String(r._id),kind:r.kind,key:r.key,revision:r.revision,data:r.data}));
 fs.writeFileSync(path.join(__dirname,'production-price-findings.json'),JSON.stringify({dbName,findings,changesMade:false},null,2),{flag:'wx'});
 console.log(JSON.stringify({model,modelSources:snap.modelSources,modelEvidence,configRevision:config.revision,records:records.length,productionPlan:before,findings:findings.map(({data,...r})=>r),commands},null,2));
})().catch(e=>{console.error(e.name+': '+e.message.replace(/mongodb[^\s]+/g,'[redacted]'));process.exitCode=1;});
