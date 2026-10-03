const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { Media, Message, Conversation, Contact } = require('./models');
const media = require('./media'); const storage = require('./mediaStorage'); const provider = require('./provider');
let mongo; let removed; let conversation;
before(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await Promise.all([Media, Message, Conversation, Contact].map(m => m.init())); }, { timeout: 300000 });
after(async () => { await mongoose.disconnect(); await mongo?.stop(); });
beforeEach(async () => { await Promise.all([Media, Message, Conversation, Contact].map(m => m.deleteMany({}))); removed = []; storage.configured = () => true; storage.remove = async key => removed.push(key); storage.put = async () => {}; conversation = new mongoose.Types.ObjectId(); });
async function asset(extra = {}) { const id = new mongoose.Types.ObjectId(); return Media.create({ _id: id, source: String(id), conversation, state: 'ready', key: storage.keyFor(id), expiresAt: new Date(Date.now() - 1000), ...extra }); }
test('automatic cleanup is disabled even for old unkept assets', async () => {
 const old = await asset(); await media.cleanup(); assert.deepEqual(removed, []); assert.equal((await Media.findById(old._id)).state, 'ready');
});
test('storage rejects keys outside dedicated namespace before contacting R2', async () => {
 const real = require('./mediaStorage');
 await assert.rejects(real.get('verification-id-cards/keep-me'), /Invalid Inbox media key/);
 assert.throws(() => real.keyFor('../other'), /Invalid Inbox media key/);
});
test('incoming media copies once to R2, metadata contains no binary, duplicate ensures are safe', async () => {
 const message = await Message.create({ conversation, direction: 'inbound', type: 'audio', media: { id: 'meta-audio', mime: 'audio/ogg' } });
 await Promise.all([media.ensure(message), media.ensure(message)]); assert.equal(await Media.countDocuments(), 1);
 let puts = 0; storage.put = async (key, bytes) => { puts++; assert.equal(bytes.toString(), 'audio'); }; provider.download = async () => ({ buffer: Buffer.from('audio'), mime: 'audio/ogg' });
 assert.equal(await media.copyNext(), false); await media.keep(await Media.findOne(), true); await media.copyNext(); await media.copyNext(); assert.equal(puts, 1); const item = await Media.findOne(); assert.equal(item.state, 'ready'); assert.equal(item.size, 5); assert(!JSON.stringify(item).includes('Buffer'));
});
test('archive failure retains message and retries independently', async () => {
 const message = await Message.create({ conversation, direction: 'inbound', type: 'video', media: { id: 'meta-video' } }); await media.ensure(message);
 provider.download = async () => { throw Error('offline'); }; await media.keep(await Media.findOne(), true); await media.copyNext(); const item = await Media.findOne(); assert.equal(item.state, 'pending'); assert.equal(await Message.countDocuments(), 1); assert(item.leaseUntil > new Date());
});
