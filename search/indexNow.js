const mongoose = require('mongoose');
const { createHash } = require('node:crypto');
const { origin, key } = require('./config.json');
const schema = new mongoose.Schema({ url: { type: String, unique: true }, fingerprint: String, submitted: String, source: String, pending: Boolean, attempts: { type: Number, default: 0 }, nextAttempt: Date, leaseUntil: Date, lastStatus: Number, lastError: String }, { timestamps: true });
schema.index({ pending: 1, nextAttempt: 1, leaseUntil: 1 });
const Entry = mongoose.model('SearchNotification', schema);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields = ['title', 'slug', 'html', 'excerpt', 'category', 'cover', 'coverAlt', 'seoTitle', 'seoDescription'];
const fingerprint = post => hash(Object.fromEntries(fields.map(name => [name, post[name] || ''])));
const changed = (old, next) => old?.status !== next?.status || (old && next && fingerprint(old) !== fingerprint(next));
const blogUrl = slug => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug || '') ? origin + '/blog/' + slug : null;
function allowed(url, source) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== origin || parsed.search || parsed.hash) return false;
    if (source === 'blog') return !!blogUrl(parsed.pathname.slice(6)) && parsed.pathname.startsWith('/blog/');
    // Never accept admin, payment, utility or arbitrary paths from the manifest.
    return /^\/(?:|services(?:\/[a-z0-9-]+)?|course|whatsapp|video-script|blog|privacy-policy)$/.test(parsed.pathname) && !parsed.pathname.endsWith('/video-ad-scripts');
  } catch { return false; }
}
async function enqueue(url, fp, source) {
  if (!allowed(url, source)) throw new Error('Ineligible search URL');
  // Conditional update prevents unchanged scans from resetting backoff or leases.
  try {
    await Entry.updateOne({ url, fingerprint: { $ne: fp } }, { $set: { fingerprint: fp, source, pending: true, attempts: 0, nextAttempt: new Date(), lastError: '' }, $setOnInsert: { url } }, { upsert: true });
  } catch (error) { if (error.code !== 11000) throw error; }
}
async function articleChanged(old, next) {
  if (!changed(old, next)) return;
  try {
    if (old?.status === 'published' && (next?.status !== 'published' || old.slug !== next.slug)) await enqueue(blogUrl(old.slug), 'removed', 'blog');
    if (next?.status === 'published') await enqueue(blogUrl(next.slug), fingerprint(next), 'blog');
    // Listing changes are coalesced by the hourly public-manifest reconciliation.
  } catch (error) { console.error('Search notification deferred; reconciliation will retry:', error.name); }
}
async function processQueue(fetcher = fetch) {
  // Explicit opt-in, separate from Inbox/AI workers. Nothing submits in tests by default.
  if (process.env.INDEXNOW_ENABLED !== 'true') return;
  for (let count = 0; count < 25; count++) {
    const now = new Date();
    const entry = await Entry.findOneAndUpdate({ pending: true, nextAttempt: { $lte: now }, $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: now } }] }, { $set: { leaseUntil: new Date(Date.now() + 60000) } }, { new: true }).lean();
    if (!entry) break;
    let status = 0, error = '';
    try {
      if (!allowed(entry.url, entry.source)) throw new Error('Ineligible search URL');
      const response = await fetcher('https://api.indexnow.org/indexnow', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: new URL(origin).host, key, keyLocation: `${origin}/${key}.txt`, urlList: [entry.url] }), signal: AbortSignal.timeout(15000) });
      status = response.status;
      if (![200, 202].includes(status)) error = `IndexNow HTTP ${status}`;
    } catch (cause) { error = cause.message === 'Ineligible search URL' ? cause.message : 'IndexNow unavailable'; }
    const success = [200, 202].includes(status);
    const delay = Math.min(86400000, 60000 * 2 ** Math.min(entry.attempts, 10));
    // If publishing changed this URL while sending, leave the newer event pending.
    await Entry.updateOne({ _id: entry._id, fingerprint: entry.fingerprint }, { $set: { pending: !success, ...(success ? { submitted: entry.fingerprint } : {}), lastStatus: status, lastError: error, leaseUntil: new Date(0), nextAttempt: new Date(Date.now() + delay) }, $inc: { attempts: 1 } });
  }
}
async function reconcile(fetcher = fetch) {
  const { Post } = require('../blog/models');
  // Repairs missed queue writes. Cursor avoids loading article bodies all at once.
  const live = new Set();
  for await (const post of Post.find({ status: 'published' }).lean().cursor()) {
    const url = blogUrl(post.slug); if (!url) continue;
    live.add(url); await enqueue(url, fingerprint(post), 'blog');
  }
  for await (const old of Entry.find({ source: 'blog', fingerprint: { $ne: 'removed' } }).lean().cursor()) if (!live.has(old.url)) await enqueue(old.url, 'removed', 'blog');
  // Only the deployed frontend can announce code-managed public pages.
  const response = await fetcher(origin + '/search-manifest.json', { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Public search manifest unavailable');
  const manifest = await response.json();
  if (manifest.version !== 1 || !Array.isArray(manifest.pages) || !manifest.pages.length || manifest.pages.length > 10000) throw new Error('Invalid public search manifest');
  const paths = new Set();
  for (const item of manifest.pages) {
    if (typeof item.path !== 'string' || !/^[a-f0-9]{64}$/.test(item.fingerprint) || !allowed(origin + item.path, 'static')) throw new Error('Invalid public search manifest item');
    paths.add(origin + item.path);
  }
  for (const item of manifest.pages) {
    // The blog listing also changes when articles are published/unpublished.
    const fp = item.path === '/blog' ? hash([item.fingerprint, [...live].sort(), await Post.find({ status: 'published' }).sort({ _id: 1 }).select('seoUpdatedAt').lean()]) : item.fingerprint;
    await enqueue(origin + item.path, fp, 'static');
  }
  for await (const old of Entry.find({ source: 'static', fingerprint: { $ne: 'removed' } }).lean().cursor()) if (!paths.has(old.url)) await enqueue(old.url, 'removed', 'static');
}
let busy = false, lastScan = 0;
async function tick() {
  if (busy || process.env.INDEXNOW_ENABLED !== 'true' || mongoose.connection.readyState !== 1) return;
  busy = true;
  try {
    if (Date.now() - lastScan > 3600000) { await reconcile(); lastScan = Date.now(); }
    await processQueue();
  } catch (error) { console.error('Search notification worker:', error.message); }
  finally { busy = false; }
}
module.exports = { Entry, fingerprint, changed, allowed, enqueue, articleChanged, processQueue, reconcile, tick };
