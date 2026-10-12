// Optional restrictions layered on top of existing role, ownership and privacy rules.
const definitions = [
 ['messages','Inbox','Send messages'],['notes','Inbox','Write internal notes'],
 ['templates','Inbox','Send approved templates'],['media','Inbox','Upload and send media'],
 ['reactions','Inbox','React to messages'],['retry','Inbox','Retry failed messages'],
 ['keepMedia','Inbox','Keep media'],['contacts','Inbox','Add contacts'],
 ['editContact','Inbox','Edit contact details'],['claim','Inbox','Claim eligible conversations'],['transfer','Inbox','Transfer assigned chats'],
 ['status','Inbox','Change conversation status'],['labels','Inbox','Edit conversation labels'],
 ['followUps','Inbox','Schedule or clear follow-ups'],['aiControl','Inbox','Change permitted AI handling'],
 ['drafts','Inbox','Approve AI drafts'],['invoice','Payments','Generate and send invoices'],
 ['payment','Payments','Check payment status'],
 ...['setup','ads','verification'].flatMap(kind=>['create','edit'].map(action=>[`${kind}.${action}`,'CRM records',`${action==='create'?'Add':'Edit'} ${kind} clients`])),
].map(([key,group,label])=>({key,group,label}));
function validate(value){
 if(!value || typeof value!=='object' || Array.isArray(value) || Object.entries(value).some(([k,v])=>!definitions.some(d=>d.key===k)||typeof v!=='boolean'))throw Object.assign(new Error('Invalid staff permissions.'),{status:400});
 return Object.fromEntries(Object.entries(value));
}
function required(req){
 const p=req.path,m=req.method,b=req.body||{},keys=[];
 if(m==='GET'||m==='DELETE')return keys;
 if(p==='/contacts')keys.push('contacts');
 if(/\/contact$/.test(p))keys.push('editContact');
 if(/\/messages$/.test(p)){keys.push(b.type==='note'?'notes':'messages');if(b.type==='template')keys.push('templates');if(['audio','video','image','document'].includes(b.type))keys.push('media');}
 for(const [suffix,key] of [['media','media'],['reaction','reactions'],['retry','retry'],['media-keep','keepMedia'],['actions/invoice','invoice'],['actions/payment','payment'],['control','aiControl'],['draft','drafts']])if(p.endsWith('/'+suffix))keys.push(key);
 if(/^\/conversations\/[^/]+$/.test(p)&&m==='PUT')for(const [field,key] of [['assignedTo',b.assignedTo===req.staff?.staffId?'claim':'transfer'],['status','status'],['labels','labels'],['followUpAt','followUps']])if(Object.hasOwn(b,field))keys.push(key);
 if(p.endsWith('/retry')||p.endsWith('/draft'))keys.push('messages');
 const match=p.match(/\/actions\/crm\/(setup|ads|verification)(?:\/[^/]+)?$/);
 if(match)keys.push(`${match[1]}.${m==='POST'?'create':'edit'}`);
 return keys;
}
function deny(req,res,next,keys){
 if(req.staff?.admin||req.actor?.admin)return next();
 if(keys.some(key=>req.staff?.permissions?.[key]===false))return res.status(403).json({message:'Your administrator has disabled this permission for your account.'});
 next();
}
const inbox=(req,res,next)=>deny(req,res,next,required(req));
const crm=(key)=>(req,res,next)=>deny(req,res,next,[key]);
module.exports={definitions,validate,required,inbox,crm};
