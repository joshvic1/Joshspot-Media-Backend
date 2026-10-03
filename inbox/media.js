const crypto = require('node:crypto');
const { Media, Message } = require('./models');
const storage = require('./mediaStorage');
const provider = require('./provider');
const live = require('./live');
const DAY = 86400000;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const safe = asset => ({ state: asset.state, keep: asset.keep, expiresAt: asset.expiresAt, mime: asset.mime, name: asset.name, size: asset.size });
async function ensure(message) {
  if (message.media?.asset) return Media.findById(message.media.asset);
  if (!message.media?.id) fail(404, 'No media attached.');
  const source = `message:${message._id}`;
  let asset;
  try { asset = await Media.findOneAndUpdate({ source }, { $setOnInsert: { source, conversation: message.conversation, providerId: message.media.id, mime: message.media.mime, name: message.media.name } }, { upsert: true, returnDocument: 'after' }); }
  catch (error) { if (error.code !== 11000) throw error; asset = await Media.findOne({ source }); }
  await Message.updateOne({ _id: message._id }, { $set: { 'media.asset': asset._id } });
  return asset;
}
async function upload(buffer, mime, name, conversation) {
  if (!storage.configured()) fail(503, 'Inbox media storage is not configured.');
  // Record ownership before the PUT, so interrupted uploads remain eligible for cleanup.
  const asset = await Media.create({ source: `upload:${crypto.randomUUID()}`, conversation, mime, name, size: buffer.length, state: 'copying', leaseUntil: new Date(Date.now() + 120000) });
  asset.key = storage.keyFor(asset._id); await asset.save();
  try {
    await storage.put(asset.key, buffer, mime);
    asset.state = 'ready'; asset.url = `r2://${process.env.R2_BUCKET}/${asset.key}`; await asset.save();
    return asset;
  } catch (error) { await Media.updateOne({ _id: asset._id }, { $set: { state: 'failed', error: 'Storage upload failed.' } }); throw error; }
}
async function copyNext() {
  const now = new Date();
  const asset = await Media.findOneAndUpdate({ providerId: { $exists: true }, $or: [{ state: 'pending', $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] }, { state: 'copying', leaseUntil: { $lte: now } }] }, { $set: { state: 'copying', leaseUntil: new Date(Date.now() + 120000) }, $inc: { attempts: 1 } }, { returnDocument: 'after', sort: { createdAt: 1 } });
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
  const result = await Media.findOneAndUpdate({ _id: asset._id, state: { $nin: ['deleting', 'deleted'] } }, { $set: { keep: value } }, { returnDocument: 'after' });
  if (!result) fail(409, 'This media is already being deleted or has expired.');
  live.notify(); return safe(result);
}
let running = false;
async function tick() {
  if (running || !storage.configured() || !require('./workerPolicy').workerEnabled()) return;
  running = true;
  try {
    for (const message of await Message.find({ 'media.id': { $exists: true }, 'media.asset': { $exists: false }, createdAt: { $gte: new Date(Date.now() - 30 * DAY) } }).limit(10)) await ensure(message);
    for (let i = 0; i < 3; i++) if (!await copyNext()) break;
  } catch { console.error('Inbox media worker will retry'); } finally { running = false; }
}
module.exports = { ensure, upload, copyNext, cleanup, keep, tick, safe };
