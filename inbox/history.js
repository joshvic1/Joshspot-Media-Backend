const { Message } = require('./models');
const mongoose = require('mongoose');
const DAY = 86400000;
const bad = () => { throw Object.assign(new Error('Invalid message cursor.'), { status: 400 }); };
const oid = (v) => { if (!mongoose.isValidObjectId(v)) bad(); return v; };
const date = (v) => { const d = new Date(v); if (!Number.isFinite(d.getTime())) bad(); return d; };
const encode = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
const decode = (v) => { try { if (typeof v !== 'string' || v.length > 2000) bad(); const result = JSON.parse(Buffer.from(v, 'base64url').toString()); if (!result || typeof result !== 'object' || Array.isArray(result)) bad(); return result; } catch { bad(); } };

// Arrival time provides stable windows even for delayed WhatsApp deliveries.
async function history(conversation, params) {
  const syncedAt = new Date().toISOString();
  const base = { conversation };
  if (params.changes) {
    const c = decode(params.changes); const since = date(c.date);
    const query = { ...base, $or: [{ updatedAt: { $gt: since } }, { updatedAt: since, _id: { $gt: oid(c.id) } }] };
    const rows = await Message.find(query).sort({ updatedAt: 1, _id: 1 }).limit(51).lean();
    const items = rows.slice(0, 50); const last = items.at(-1);
    return { items, more: rows.length > 50, changes: last ? encode({ date: last.updatedAt, id: last._id }) : params.changes };
  }
  let end = new Date(); let before; let target;
  if (params.page) { const c = decode(params.page); end = date(c.end); if (c.before) before = oid(c.before); }
  if (params.target) {
    target = await Message.findOne({ ...base, _id: oid(params.target) }).lean();
    if (!target) throw Object.assign(new Error('This note is no longer available.'), { status: 404 });
    end = new Date(new Date(target.createdAt).getTime() + 1);
  }
  let start = new Date(end.getTime() - DAY);
  const query = { ...base, createdAt: { $gte: start, $lt: end }, ...(target ? { _id: { $lte: target._id } } : before ? { _id: { $lt: before } } : {}) };
  let rows = await Message.find(query).sort({ _id: -1 }).limit(51).lean();
  // Skip empty historical periods, but keep the initial view strictly last 24 hours.
  if (!rows.length && params.page) {
    const prior = await Message.findOne({ ...base, createdAt: { $lt: start } }).sort({ createdAt: -1, _id: -1 }).lean();
    if (prior) {
      end = new Date(new Date(prior.createdAt).getTime() + 1); start = new Date(end.getTime() - DAY);
      rows = await Message.find({ ...base, createdAt: { $gte: start, $lt: end } }).sort({ _id: -1 }).limit(51).lean();
    }
  }
  const items = rows.slice(0, 50); const withinDay = rows.length > 50;
  const older = !withinDay && await Message.exists({ ...base, createdAt: { $lt: start } });
  return { items: items.reverse(), more: Boolean(withinDay || older), withinDay,
    next: withinDay ? encode({ end, before: items[0]._id }) : older ? encode({ end: start }) : null,
    windowStart: start, windowEnd: end, target: target?._id,
    changes: encode({ date: syncedAt, id: '000000000000000000000000' }) };
}
module.exports = { history };
