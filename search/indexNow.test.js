// Isolated database; all search-engine HTTP requests are mocked. Never loads .env.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { Entry, allowed, enqueue, articleChanged, processQueue, reconcile } = require('./indexNow');
const { Post } = require('../blog/models');
const { origin, key } = require('./config.json');
let mongo;
before(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); await Entry.init(); await Post.init(); });
beforeEach(async () => { await Entry.deleteMany({}); await Post.deleteMany({}); delete process.env.INDEXNOW_ENABLED; });
after(async () => { delete process.env.INDEXNOW_ENABLED; await mongoose.disconnect(); await mongo.stop(); });
const post = { title: 'A guide', slug: 'a-guide', html: '<p>A useful guide.</p>', status: 'published' };
test('only approved public paths; no private/query/foreign/noindex URLs', async () => {
  for (const path of ['/crm-inbox', '/admin-7812er', '/pay-invoice/secret', '/tiktok-setup', '/start', '/course?email=private', '/api/blog/admin/posts', '/services/video-ad-scripts']) assert.equal(allowed(origin + path, 'static'), false, path);
  assert.equal(allowed('https://elsewhere.test/course', 'static'), false);
  assert.equal(allowed(origin + '/blog/a-guide', 'blog'), true);
  await assert.rejects(enqueue(origin + '/crm-inbox', 'bad', 'static'));
});
test('publish, update, rename, unpublish, delete; unchanged saves and drafts do not submit', async () => {
  await articleChanged(null, { ...post, status: 'draft' }); assert.equal(await Entry.countDocuments(), 0);
  await articleChanged(null, post);
  const original = await Entry.findOne({ url: origin + '/blog/a-guide' }).lean();
  await articleChanged(post, { ...post }); assert.equal((await Entry.findById(original._id)).fingerprint, original.fingerprint);
  await articleChanged(post, { ...post, slug: 'renamed' });
  assert.equal((await Entry.findOne({ url: origin + '/blog/a-guide' })).fingerprint, 'removed');
  assert.equal((await Entry.findOne({ url: origin + '/blog/renamed' })).pending, true);
  await articleChanged({ ...post, slug: 'renamed' }, { ...post, slug: 'renamed', status: 'draft' });
  assert.equal((await Entry.findOne({ url: origin + '/blog/renamed' })).fingerprint, 'removed');
  await articleChanged(post, null); assert.equal((await Entry.findOne({ url: origin + '/blog/a-guide' })).fingerprint, 'removed');
});
test('disabled by default; dedup, key format, success and retry backoff', async () => {
  await enqueue(origin + '/course', 'one', 'static'); let calls = 0;
  const success = async (url, options) => { calls++; assert.equal(url, 'https://api.indexnow.org/indexnow'); const body = JSON.parse(options.body); assert.equal(body.key, key); assert.equal(body.keyLocation, `${origin}/${key}.txt`); return { status: 202 }; };
  await processQueue(success); assert.equal(calls, 0);
  process.env.INDEXNOW_ENABLED = 'true'; await processQueue(success); assert.equal(calls, 1);
  await enqueue(origin + '/course', 'one', 'static'); await processQueue(success); assert.equal(calls, 1);
  await enqueue(origin + '/course', 'two', 'static'); await processQueue(async () => ({ status: 429 }));
  let item = await Entry.findOne({}); assert.equal(item.pending, true); assert.ok(item.nextAttempt > new Date());
  await processQueue(success); assert.equal(calls, 1);
  await Entry.updateOne({}, { $set: { nextAttempt: new Date(0) } }); await processQueue(success); assert.equal(calls, 2);
});
test('lease prevents concurrent sends and a changed article stays pending during a send', async () => {
  process.env.INDEXNOW_ENABLED = 'true'; await enqueue(origin + '/course', 'one', 'static'); let calls = 0;
  const send = async () => { calls++; await enqueue(origin + '/course', 'two', 'static'); return { status: 200 }; };
  await Promise.all([processQueue(send), processQueue(send)]);
  assert.equal(calls, 1); const item = await Entry.findOne({}); assert.equal(item.fingerprint, 'two'); assert.equal(item.pending, true);
});
test('reconciles published articles, code pages and deletions; rejects corrupt manifests', async () => {
  await Post.create(post); const fp = 'a'.repeat(64);
  const manifest = async () => ({ ok: true, json: async () => ({ version: 1, pages: [{ path: '/', fingerprint: fp }, { path: '/course', fingerprint: fp }] }) });
  await reconcile(manifest); assert.equal(await Entry.countDocuments(), 3);
  await Post.deleteMany({}); await reconcile(manifest); assert.equal((await Entry.findOne({ source: 'blog' })).fingerprint, 'removed');
  await assert.rejects(reconcile(async () => ({ ok: true, json: async () => ({ version: 1, pages: [{ path: '/crm-inbox', fingerprint: fp }] }) })));
  assert.equal(await Entry.countDocuments({ url: origin + '/crm-inbox' }), 0);
});
