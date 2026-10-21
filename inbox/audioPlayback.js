const jwt = require('jsonwebtoken');
const { createHash } = require('node:crypto');
const { Conversation, Message } = require('./models');
const Staff = require('../models/Staff');
const policy = require('./policy');
const provider = require('./provider');
const storage = require('./mediaStorage');
const media = require('./media');
const cache = new Map(), pending = new Map();
const TTL = 5 * 60000, MAX_BYTES = 32 * 1024 * 1024;
let bytes = 0;
function prune() {
  for (const [key, value] of cache) if (value.until < Date.now()) {
    bytes -= value.buffer.length; cache.delete(key);
  }
}
async function prepare(asset) {
  prune();
  const key = createHash('sha256').update(`${asset._id}:${asset.providerId}:${asset.key || ''}`).digest('hex');
  if (cache.has(key)) return cache.get(key).buffer;
  if (pending.has(key)) return pending.get(key);
  const work = (async () => {
    const file = asset.keep && asset.state === 'ready' && asset.key ? await storage.get(asset.key) : await provider.download(asset.providerId);
    if (!String(file.mime || asset.mime).startsWith('audio/')) throw Object.assign(new Error('This attachment is not audio.'), { status:400 });
    const buffer = await require('./playback')(file.buffer);
    while (cache.size && bytes + buffer.length > MAX_BYTES) {
      const oldest = cache.keys().next().value; bytes -= cache.get(oldest).buffer.length; cache.delete(oldest);
    }
    if (buffer.length <= MAX_BYTES) { cache.set(key, {buffer, until:Date.now()+TTL}); bytes += buffer.length; }
    return buffer;
  })();
  pending.set(key, work);
  try { return await work; } finally { pending.delete(key); }
}
function ticket(actor, conversation, message) {
  return jwt.sign({ purpose:'inbox-audio-playback', actor:actor.id, conversation:String(conversation), message:String(message) }, process.env.JWT_SECRET, {expiresIn:'5m', algorithm:'HS256'});
}
function publicRoute(router, wrap) {
  router.get('/audio-playback', wrap(async (req,res) => {
    let claim;
    try { claim = jwt.verify(String(req.query.ticket || ''),process.env.JWT_SECRET,{algorithms:['HS256']}); }
    catch { return res.status(401).end(); }
    if (claim.purpose !== 'inbox-audio-playback') return res.status(401).end();
    const actor = {id:claim.actor,admin:claim.actor==='admin'};
    if (!actor.admin && !await Staff.exists({_id:actor.id,role:{$in:['SS','CSS']}})) return res.status(403).end();
    const conversation = await Conversation.findOne({$and:[policy.accessible(actor),{_id:claim.conversation,deleting:{$ne:true}}]}).lean();
    if (!conversation) return res.status(404).end();
    const message = await Message.findOne({_id:claim.message,conversation:conversation._id,type:'audio'}).lean();
    if (!message?.media?.id) return res.status(404).end();
    const asset = await media.ensure(message);
    const buffer = await prepare(asset);
    let start=0,end=buffer.length-1;
    res.set({'Content-Type':'audio/mpeg','Accept-Ranges':'bytes','Content-Disposition':'inline; filename="voice-note.mp3"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
    if (req.headers.range) {
      const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1]&&!match[2])) return res.status(416).set('Content-Range',`bytes */${buffer.length}`).end();
      if (!match[1]) start=Math.max(0,buffer.length-Number(match[2]));
      else { start=Number(match[1]); if(match[2])end=Math.min(Number(match[2]),end); }
      if (!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=buffer.length) return res.status(416).set('Content-Range',`bytes */${buffer.length}`).end();
      res.status(206).set('Content-Range',`bytes ${start}-${end}/${buffer.length}`);
    }
    res.set('Content-Length',String(end-start+1));
    if(req.method==='HEAD')return res.end();
    res.end(buffer.subarray(start,end+1));
  }));
}
module.exports = {prepare,ticket,publicRoute};
