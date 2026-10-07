const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
(async()=>{
 const env=require('dotenv').parse(fs.readFileSync(path.join(root,'.env')));
 const {MongoClient}=require('mongodb');
 const dbClient=new MongoClient(env.MONGO_URI||env.MONGODB_URI||env.MONGO_URL,{serverSelectionTimeoutMS:15000,monitorCommands:true});
 const commands=[];dbClient.on('commandStarted',e=>{commands.push(e.commandName);if(!['find','getMore','killCursors','endSessions'].includes(e.commandName))throw Error('READ_ONLY_COMMAND_VIOLATION');});
 let config;
 try{await dbClient.connect();config=await dbClient.db().collection('inboxaiconfigs').findOne({key:'main'},{projection:{'data.v3Model':1,'data.model':1,'data.v3MaxOutputTokens':1,'data.maxResponseLength':1,revision:1,_id:0}});}finally{await dbClient.close();}
 const model=config?.data?.v3Model||config?.data?.model||env.OPENAI_MODEL;
 if(!model||!env.OPENAI_API_KEY)throw Error('MODEL_OR_KEY_MISSING');
 const result={at:new Date().toISOString(),model,config,commands,scope:'Read only configuration fields. No customer or financial reads/writes. Evaluation catalogue remains the previously corrected local snapshot.'};
 fs.writeFileSync(path.join(__dirname,'preflight.json'),JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify(result));
})().catch(e=>{console.error(e.name+': '+e.message.replace(/mongodb[^\s]+/g,'[redacted]'));process.exitCode=1;});
