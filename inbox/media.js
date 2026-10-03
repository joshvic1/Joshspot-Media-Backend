const { Media, Message } = require('./models');
const storage = require('./mediaStorage');
const provider = require('./provider');
const live = require('./live');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const safe = asset => ({ state: asset.state, keep: asset.keep, expiresAt: asset.expiresAt, mime: asset.mime, name: asset.name, size: asset.size });
async function ensure(message) {
  if (message.media?.asset) return Media.findOneAndUpdate({ _id: message.media.asset }, { $set: { providerId: message.media.id } }, { returnDocument: 'after' });
  if (!message.media?.id) fail(404, 'No media attached.');
  const source = `message:${message._id}`;
  let asset;
  try { asset = await Media.findOneAndUpdate({ source }, { $setOnInsert: { source, conversation: message.conversation, providerId: message.media.id, mime: message.media.mime, name: message.media.name } }, { upsert: true, returnDocument: 'after' }); }
  catch (error) { if (error.code !== 11000) throw error; asset = await Media.findOne({ source }); }
  await Message.updateOne({ _id: message._id }, { $set: { 'media.asset': asset._id } });
  return asset;
}
async function copyNext() {
  const now = new Date();
  const asset = await Media.findOneAndUpdate({ keep: true, providerId: { $exists: true }, $or: [{ state: 'pending', $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] }, { state: 'copying', leaseUntil: { $lte: now } }] }, { $set: { state: 'copying', leaseUntil: new Date(Date.now() + 120000) }, $inc: { attempts: 1 } }, { returnDocument: 'after', sort: { createdAt: 1 } });
  if (!asset) return false;
  try {
    const key = storage.keyFor(asset._id);
    await Media.updateOne({ _id: asset._id }, { $set: { key } });
    const file = await provider.download(asset.providerId);
    await storage.put(key, file.buffer, file.mime);
    await Media.updateOne({ _id: asset._id, state: 'copying' }, { $set: { key, url: `r2://${process.env.R2_BUCKET}/${key}`, mime: file.mime, size: file.buffer.length, state: 'ready', error: '' } });
  } catch {
    await Media.updateOne({ _id: asset._id, state: 'copying' }, { $set: { state: asset.attempts >= 10 ? 'failed' : 'pending', leaseUntil: new Date(Date.now() + Math.min(asset.attempts * 30000, 600000)), error: 'Could not archive media. It may no longer be available from WhatsApp.' } });
  }
  live.notify(); return true;
}
// Retention is indefinite. Kept as a no-op for compatibility with older callers.
async function cleanup() {}
async function keep(asset, value) {
  if (value && !storage.configured()) fail(503, 'R2 storage is not configured.');
  const result = await Media.findOneAndUpdate({ _id: asset._id, state: { $nin: ['deleting', 'deleted'] } }, { $set: { keep: value, ...(value && asset.state === 'failed' ? { state: 'pending', attempts: 0, leaseUntil: null } : {}) } }, { returnDocument: 'after' });
  if (!result) fail(409, 'This media is already being deleted or has expired.');
  live.notify(); return safe(result);
}
let running = false;
async function tick() {
  if (running || !storage.configured() || !require('./workerPolicy').workerEnabled()) return;
  running = true;
  try {
    for (let i = 0; i < 3; i++) if (!await copyNext()) break;
  } catch { console.error('Inbox media worker will retry'); } finally { running = false; }
}
module.exports = { ensure, copyNext, cleanup, keep, tick, safe };