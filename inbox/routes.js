const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const staffAuth = require('../middleware/staffAuth');
const Staff = require('../models/Staff');
const { Contact, Conversation, Message, Template, RateBucket, WebhookJob } = require('./models');
const policy = require('./policy');
const provider = require('./provider');
const service = require('./service');
const router = express.Router();
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const id = (value) => { if (!mongoose.isValidObjectId(value)) fail(400, 'Invalid record identifier.'); return value; };
const text = (value, max = 120) => { if (typeof value !== 'string' || value.length > max) fail(400, `Enter text no longer than ${max} characters.`); return value.trim(); };
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const scoped = (req, query = {}) => ({ $and: [policy.visible(req.actor), query] });
async function conversationFor(req) {
  const item = await Conversation.findOne(scoped(req, { _id: id(req.params.id) })).populate('contact');
  if (!item) fail(404, 'Conversation not found or no longer assigned to you.');
  return item;
}
async function rateLimit(req, limit = 90) {
  const minute = Math.floor(Date.now() / 60000);
  const key = `${req.actor.id}:${minute}`;
  let bucket;
  try { bucket = await RateBucket.findOneAndUpdate({ key }, { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((minute + 2) * 60000) } }, { upsert: true, returnDocument: 'after' }); }
  catch (error) { if (error.code !== 11000) throw error; bucket = await RateBucket.findOneAndUpdate({ key }, { $inc: { count: 1 } }, { returnDocument: 'after' }); }
  if (bucket.count > limit) fail(429, 'Too many changes. Please wait a minute and try again.');
}
router.get('/webhook', (req, res) => {
  if (process.env.WHATSAPP_VERIFY_TOKEN && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.WHATSAPP_VERIFY_TOKEN) return res.status(200).send(String(req.query['hub.challenge'] || ''));
  return res.sendStatus(403);
});
router.post('/webhook', wrap(async (req, res) => {
  if (!policy.signature(req.rawBody, req.headers['x-hub-signature-256'], process.env.WHATSAPP_APP_SECRET)) return res.sendStatus(401);
  if (req.body.object !== 'whatsapp_business_account') return res.sendStatus(400);
  await service.enqueueWebhook(req.rawBody, req.body);
  res.sendStatus(200);
}));
router.use((req, res, next) => process.env.JWT_SECRET ? next() : res.status(503).json({ message: 'Inbox requires a configured JWT_SECRET.' }));
router.use(staffAuth);
router.use(wrap(async (req, res, next) => {
  if (req.staff.admin) req.actor = { id: 'admin', admin: true, name: 'Administrator', role: 'ADMIN' };
  else {
    const staff = await Staff.findById(req.staff.staffId).select('name role');
    if (!staff || !['SS', 'CSS'].includes(staff.role)) fail(403, 'Your role does not have access to customer messaging.');
    req.actor = { id: String(staff._id), name: staff.name, role: staff.role, admin: false };
  }
  next();
}));
router.get('/session', wrap(async (req, res) => {
  const config = provider.configuration();
  const staff = await Staff.find({ role: { $in: ['SS', 'CSS'] } }).select('name role').sort({ name: 1 }).lean();
  const failedJobs = req.actor.admin ? await WebhookJob.countDocuments({ state: 'dead' }) : undefined;
  res.json({ actor: req.actor, staff, provider: { configured: config.configured, ...(req.actor.admin ? { missing: config.missing, failedJobs } : {}) } });
}));
router.post('/webhooks/retry', wrap(async (req, res) => {
  if (!req.actor.admin) fail(403, 'Administrator access required.');
  await rateLimit(req);
  const result = await WebhookJob.updateMany({ state: 'dead' }, { $set: { state: 'pending', attempts: 0, leaseUntil: null } });
  res.json({ retried: result.modifiedCount });
}));
router.get('/conversations', wrap(async (req, res) => {
  const filter = { $and: [policy.visible(req.actor)] };
  const view = String(req.query.view || 'inbox');
  if (view === 'mine') filter.$and.push({ assignedTo: req.actor.admin ? null : req.actor.id });
  if (view === 'unassigned') filter.$and.push({ assignedTo: null });
  if (view === 'follow_up') filter.$and.push({ status: 'follow_up' });
  else if (view === 'resolved') filter.$and.push({ status: 'resolved' });
  else if (view !== 'contacts' && !['open', 'follow_up', 'resolved'].includes(req.query.status)) filter.$and.push({ status: { $ne: 'resolved' } });
  if (view === 'unread') filter.$and.push({ $expr: { $gt: ['$lastInboundId', { $ifNull: [`$reads.${req.actor.id}`, new mongoose.Types.ObjectId('000000000000000000000000')] }] } });
  if (req.query.agent) filter.$and.push({ assignedTo: req.query.agent === 'unassigned' ? null : id(req.query.agent) });
  if (req.query.status && ['open', 'follow_up', 'resolved'].includes(req.query.status)) filter.$and.push({ status: req.query.status });
  const search = text(String(req.query.q || ''), 100);
  if (req.query.label) filter.$and.push({ labels: text(String(req.query.label), 40) });
  if (req.query.source || req.query.customerStatus) {
    const contactFilter = {};
    if (req.query.source) contactFilter.source = { $regex: `^${escapeRegex(text(String(req.query.source), 120))}`, $options: 'i' };
    if (req.query.customerStatus) {
      if (!['lead', 'customer', 'inactive'].includes(req.query.customerStatus)) fail(400, 'Invalid customer status.');
      contactFilter.status = req.query.customerStatus;
    }
    const contacts = await Contact.find(contactFilter).select('_id').limit(500).lean();
    filter.$and.push({ contact: { $in: contacts.map((contact) => contact._id) } });
  }
  if (search) {
    const terms = escapeRegex(search);
    const contacts = await Contact.find({ $or: [{ name: { $regex: `^${terms}`, $options: 'i' } }, { phone: { $regex: `^${escapeRegex(search.replace(/^\+/, ''))}` } }, { email: { $regex: `^${terms}`, $options: 'i' } }] }).select('_id').limit(500).lean();
    const messages = await Message.find({ $text: { $search: search } }).select('conversation').limit(500).lean();
    filter.$and.push({ $or: [{ contact: { $in: contacts.map((c) => c._id) } }, { _id: { $in: messages.map((m) => m.conversation) } }, { labels: { $regex: terms, $options: 'i' } }] });
  }
  if (req.query.before) {
    let cursor; try { cursor = JSON.parse(Buffer.from(String(req.query.before), 'base64url').toString()); } catch { fail(400, 'Invalid page cursor.'); }
    const date = new Date(cursor.date); id(cursor.id);
    if (Number.isNaN(date.getTime())) fail(400, 'Invalid page cursor.');
    filter.$and.push({ $or: [{ lastMessageAt: { $lt: date } }, { lastMessageAt: date, _id: { $lt: cursor.id } }] });
  }
  const rows = await Conversation.find(filter).sort({ lastMessageAt: -1, _id: -1 }).limit(41).populate('contact').lean();
  const hasMore = rows.length > 40; const items = rows.slice(0, 40).map((row) => ({ ...row, unread: Boolean(row.lastInboundId && String(row.lastInboundId) > String(row.reads?.[req.actor.id] || '')), reads: undefined }));
  const last = items.at(-1);
  res.json({ items, next: hasMore ? Buffer.from(JSON.stringify({ date: last.lastMessageAt, id: last._id })).toString('base64url') : null });
}));
router.get('/counts', wrap(async (req, res) => {
  const base = policy.visible(req.actor);
  const entries = await Promise.all(Object.entries({ inbox: { status: { $ne: 'resolved' } }, mine: { assignedTo: req.actor.admin ? null : req.actor.id, status: { $ne: 'resolved' } }, unassigned: { assignedTo: null, status: { $ne: 'resolved' } }, unread: { status: { $ne: 'resolved' }, $expr: { $gt: ['$lastInboundId', { $ifNull: [`$reads.${req.actor.id}`, new mongoose.Types.ObjectId('000000000000000000000000')] }] } }, follow_up: { status: 'follow_up' }, resolved: { status: 'resolved' } }).map(async ([key, query]) => [key, await Conversation.countDocuments({ $and: [base, query] })]));
  res.json(Object.fromEntries(entries));
}));
router.post('/contacts', wrap(async (req, res) => {
  await rateLimit(req);
  const number = policy.phone(req.body.phone); const name = text(req.body.name || '');
  const contact = await service.upsertContact(number, name);
  const conversation = await service.openConversation(contact);
  if (!req.actor.admin && conversation.assignedTo && String(conversation.assignedTo) !== req.actor.id) fail(409, 'This contact already belongs to another representative. Ask an administrator to reassign it.');
  res.status(201).json({ id: conversation._id });
}));
router.get('/conversations/:id', wrap(async (req, res) => {
  const conversation = await conversationFor(req);
  res.json({ ...conversation.toObject(), reads: undefined, windowOpen: policy.windowOpen(conversation.lastInboundAt) });
}));
router.get('/conversations/:id/crm', wrap(async (req, res) => {
  const conversation = await conversationFor(req); const number = conversation.contact.phone;
  const variants = [number, `+${number}`, ...(number.startsWith('234') ? [`0${number.slice(3)}`] : [])];
  const pattern = new RegExp(`^(?:${variants.map((v) => [...v].map(escapeRegex).join('[\\s().-]*')).join('|')})$`);
  const records = [];
  for (const [model, route] of [['Client', '/crm-dashboard'], ['AdsClient', '/crm-ads-dashboard'], ['VerificationClient', '/crm-verification-dashboard']]) {
    const rows = await require(`../models/${model}`).find({ clientNumber: pattern }).select('businessName name servicePaidFor service').limit(10).lean();
    rows.forEach((row) => records.push({ id: row._id, kind: model, name: row.businessName || row.name, service: row.servicePaidFor || row.service, href: route }));
  }
  if (req.actor.admin) {
    const invoices = await require('../models/Invoice').find({ customerPhone: pattern, deletedAt: null }).select('customerName amount status product createdAt').sort({ createdAt: -1 }).limit(10).lean();
    invoices.forEach((row) => records.push({ id: row._id, kind: 'Invoice', name: row.customerName, service: row.product, amount: row.amount, status: row.status, href: '/admin-7812er/invoices' }));
  }
  res.json(records);
}));
router.put('/conversations/:id', wrap(async (req, res) => {
  await rateLimit(req); const current = await conversationFor(req);
  if (!Number.isInteger(req.body.revision)) fail(400, 'A conversation revision is required.');
  const changes = {}; const descriptions = [];
  if ('assignedTo' in req.body) {
    const target = req.body.assignedTo || null;
    if (!req.actor.admin && (target !== req.actor.id || current.assignedTo)) fail(403, 'You can only claim an unassigned conversation.');
    const agent = target ? await Staff.findOne({ _id: id(target), role: { $in: ['SS', 'CSS'] } }).select('name') : null;
    if (target && !agent) fail(400, 'Choose an available representative.');
    changes.assignedTo = target; descriptions.push(target ? `Assigned to ${agent.name}` : 'Unassigned conversation');
  }
  if ('status' in req.body || 'labels' in req.body || 'followUpAt' in req.body) {
    if (!policy.canReply(req.actor, current)) fail(403, 'Claim this conversation before changing it.');
    if ('status' in req.body) {
      if (!['open', 'follow_up', 'resolved'].includes(req.body.status)) fail(400, 'Invalid conversation status.');
      changes.status = req.body.status; changes.resolvedAt = req.body.status === 'resolved' ? new Date() : null;
      descriptions.push(`Marked ${req.body.status.replace('_', ' ')}`);
      if (req.body.status !== 'follow_up') changes.followUpAt = null;
    }
    if ('labels' in req.body) {
      if (!Array.isArray(req.body.labels) || req.body.labels.length > 15) fail(400, 'Use up to 15 labels.');
      changes.labels = [...new Set(req.body.labels.map((label) => text(label, 40)).filter(Boolean))]; descriptions.push('Updated labels');
    }
    if ('followUpAt' in req.body) {
      if (req.body.followUpAt === null) { changes.followUpAt = null; descriptions.push('Cleared follow-up date'); }
      else {
        if (typeof req.body.followUpAt !== 'string') fail(400, 'Choose a valid follow-up date and time.');
        const when = new Date(req.body.followUpAt);
        if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) fail(400, 'Choose a future follow-up date and time.');
        if (req.body.status && req.body.status !== 'follow_up') fail(400, 'A scheduled follow-up must use follow-up status.');
        changes.followUpAt = when; changes.status = 'follow_up'; changes.resolvedAt = null;
        descriptions.push(`Follow-up scheduled for ${when.toISOString()}`);
      }
    }
  }
  if (!Object.keys(changes).length) fail(400, 'No changes supplied.');
  const updated = await Conversation.findOneAndUpdate(scoped(req, { _id: current._id, revision: req.body.revision }), { $set: changes, $inc: { revision: 1 } }, { returnDocument: 'after' });
  if (!updated) fail(409, 'This conversation changed. Refresh and try again.');
  await service.activity(current._id, req.actor, descriptions.join(' · '));
  res.json({ revision: updated.revision });
}));
router.put('/conversations/:id/contact', wrap(async (req, res) => {
  await rateLimit(req); const conversation = await conversationFor(req);
  if (!policy.canReply(req.actor, conversation)) fail(403, 'Claim this conversation before editing customer details.');
  const fields = {};
  for (const key of ['name', 'email', 'source', 'service', 'status']) if (key in req.body) fields[key] = text(req.body[key], key === 'email' ? 254 : 120);
  if (fields.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) fail(400, 'Enter a valid email address.');
  if (fields.status && !['lead', 'customer', 'inactive'].includes(fields.status)) fail(400, 'Invalid customer status.');
  if (!Number.isInteger(req.body.revision)) fail(400, 'A contact revision is required.');
  const updated = await Contact.findOneAndUpdate({ _id: conversation.contact._id, revision: req.body.revision }, { $set: fields, $inc: { revision: 1 } }, { returnDocument: 'after' });
  if (!updated) fail(409, 'Customer details changed. Refresh and try again.');
  await service.activity(conversation._id, req.actor, 'Updated customer details');
  res.json(updated);
}));
router.get('/conversations/:id/messages', wrap(async (req, res) => {
  const conversation = await conversationFor(req);
  const query = { conversation: conversation._id };
  if (req.query.kind === 'media') query.type = { $in: ['image', 'document', 'audio', 'video', 'sticker'] };
  else if (req.query.kind === 'activity') query.type = { $in: ['note', 'activity'] };
  if (req.query.before) query._id = { $lt: id(req.query.before) };
  if (req.query.after) query._id = { $gt: id(req.query.after) };
  const rows = await Message.find(query).sort({ _id: req.query.after ? 1 : -1 }).limit(51).lean();
  const items = rows.slice(0, 50);
  res.json({ items: req.query.after ? items : items.reverse(), more: rows.length > 50 });
}));
router.post('/conversations/:id/read', wrap(async (req, res) => {
  const conversation = await conversationFor(req);
  const message = await Message.findOne({ _id: id(req.body.messageId), conversation: conversation._id, direction: 'inbound' }).select('_id');
  if (message) await Conversation.updateOne({ _id: conversation._id }, { $max: { [`reads.${req.actor.id}`]: message._id } });
  res.json({ ok: true });
}));
router.post('/conversations/:id/media', wrap(async (req, res) => {
  await rateLimit(req, 60); const conversation = await conversationFor(req);
  if (!policy.canReply(req.actor, conversation)) fail(403, 'Claim this conversation before attaching files.');
  if (!policy.windowOpen(conversation.lastInboundAt)) fail(400, 'The reply window is closed. Send an approved template.');
  const encoded = text(req.body.data, 7000000); const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) fail(400, 'Choose a file smaller than 5 MB.');
  const mime = buffer.subarray(0, 5).toString() === '%PDF-' ? 'application/pdf' : buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' : buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255 ? 'image/jpeg' : null;
  if (!mime) fail(400, 'Choose a PNG, JPEG or PDF file.');
  const name = text(req.body.name || 'attachment', 120).replace(/[^\w. -]/g, '_');
  const mediaId = await provider.upload(buffer, mime, name);
  const media = { id: mediaId, mime, name };
  const ticket = jwt.sign({ media, conversation: String(conversation._id), actor: req.actor.id, purpose: 'inbox-media' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  res.json({ ticket, name, type: mime === 'application/pdf' ? 'document' : 'image' });
}));
router.post('/conversations/:id/messages', wrap(async (req, res) => {
  await rateLimit(req, 60); const conversation = await conversationFor(req);
  if (!policy.canReply(req.actor, conversation)) fail(403, 'Claim this conversation before replying.');
  const type = req.body.type || 'text';
  if (!['text', 'note', 'template', 'image', 'document'].includes(type)) fail(400, 'Unsupported message type.');
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(req.body.clientId || '')) fail(400, 'A unique message key is required.');
  const clientKey = `${req.actor.id}:${conversation._id}:${req.body.clientId}`;
  const existing = await Message.findOne({ clientKey }).lean(); if (existing) return res.json(existing);
  if (type !== 'note' && !provider.configuration().configured) fail(503, 'WhatsApp is not configured. Your administrator needs to connect it first.');
  if (!['note', 'template'].includes(type) && !policy.windowOpen(conversation.lastInboundAt)) fail(400, 'The reply window is closed. Choose an approved template.');
  let body = text(req.body.text || '', type === 'note' ? 10000 : 4096); let providerPayload; let media;
  if (type === 'template') {
    const template = await Template.findById(id(req.body.templateId)).lean();
    if (!template || !template.syncedAt || Date.now() - new Date(template.syncedAt).getTime() > 86400000) fail(400, 'Refresh templates before sending.');
    const result = policy.templatePayload(template, req.body.values || {}); body = result.preview; providerPayload = result.payload;
  } else if (['image', 'document'].includes(type)) {
    let ticket; try { ticket = jwt.verify(req.body.ticket, process.env.JWT_SECRET); } catch { fail(400, 'Attachment expired. Upload it again.'); }
    if (ticket.purpose !== 'inbox-media' || ticket.actor !== req.actor.id || ticket.conversation !== String(conversation._id)) fail(400, 'Invalid attachment.');
    media = ticket.media;
    if ((type === 'document') !== (media.mime === 'application/pdf')) fail(400, 'Attachment type mismatch.');
    if (body.length > 1024) fail(400, 'Attachment captions must be at most 1024 characters.');
  } else if (!body) fail(400, 'Write a message first.');
  let message;
  try { message = await Message.create({ conversation: conversation._id, clientKey, direction: type === 'note' ? 'internal' : 'outbound', type, text: body, author: req.actor.id, authorName: req.actor.name, status: type === 'note' ? 'internal' : 'queued', providerPayload, media }); }
  catch (error) { if (error.code !== 11000) throw error; message = await Message.findOne({ clientKey }); }
  await Conversation.updateOne({ _id: conversation._id, $or: [{ lastMessageId: { $lt: message._id } }, { lastMessageId: null }] }, { $set: { lastMessageId: message._id, lastMessageAt: message.createdAt, preview: type === 'note' ? 'Internal note' : body.slice(0, 160) || `[${type}]` } });
  const result = message.toObject(); delete result.providerPayload;
  res.status(201).json(result);
}));
router.post('/conversations/:id/messages/:messageId/retry', wrap(async (req, res) => {
  await rateLimit(req, 60); const conversation = await conversationFor(req);
  if (!policy.canReply(req.actor, conversation)) fail(403, 'Claim this conversation before retrying.');
  const message = await Message.findOne({ _id: id(req.params.messageId), conversation: conversation._id, direction: 'outbound', status: 'failed' });
  if (!message) fail(409, 'Only definitively failed messages can be retried.');
  if (message.type !== 'template' && !policy.windowOpen(conversation.lastInboundAt)) fail(400, 'The reply window closed. Send an approved template.');
  if (!provider.configuration().configured) fail(503, 'WhatsApp is not configured.');
  const result = await Message.updateOne({ _id: message._id, status: 'failed' }, { $set: { status: 'queued', error: '', author: req.actor.id, authorName: req.actor.name }, $unset: { providerId: 1 } });
  if (!result.modifiedCount) fail(409, 'Message status changed. Refresh before retrying.');
  await service.activity(conversation._id, req.actor, 'Retried a failed message'); res.json({ ok: true });
}));
router.get('/conversations/:id/messages/:messageId/media', wrap(async (req, res) => {
  const conversation = await conversationFor(req);
  const message = await Message.findOne({ _id: id(req.params.messageId), conversation: conversation._id });
  if (!message?.media?.id) fail(404, 'Attachment not found.');
  const media = await provider.download(message.media.id);
  res.set({ 'Content-Type': ['image/jpeg', 'image/png', 'image/webp', 'audio/ogg', 'audio/mpeg', 'video/mp4'].includes(media.mime) ? media.mime : 'application/octet-stream', 'Content-Disposition': `attachment; filename="${(message.media.name || `attachment-${message._id}`).replace(/[^\w.-]/g, '_')}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' }).send(Buffer.from(media.buffer));
}));
router.get('/templates', wrap(async (req, res) => {
  const q = text(String(req.query.q || ''), 100);
  const filter = q ? { name: { $regex: escapeRegex(q), $options: 'i' } } : {};
  for (const key of ['category', 'status', 'language']) if (req.query[key]) filter[key] = text(String(req.query[key]), 40);
  if (req.query.before) filter._id = { $gt: id(req.query.before) };
  const items = await Template.find(filter).sort({ _id: 1 }).limit(101).lean();
  res.json({ items: items.slice(0, 100).map((item) => ({ ...item, fields: policy.templateFields(item) })), next: items.length > 100 ? String(items[99]._id) : null });
}));
router.post('/templates/sync', wrap(async (req, res) => {
  if (!req.actor.admin) fail(403, 'Ask an administrator to refresh templates.');
  await rateLimit(req, 10); res.json({ count: await service.syncTemplates() });
}));
router.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.status || (error.name === 'CastError' || error.name === 'ValidationError' ? 400 : 500);
  if (status === 500) console.error('Inbox request failed', req.method, req.route?.path || req.path, error.name);
  res.status(status).json({ message: status === 500 ? 'Inbox is temporarily unavailable. Please try again.' : error.message });
});
module.exports = router;
