const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const staffAuth = require('../middleware/staffAuth');
const Staff = require('../models/Staff');
const { Contact, Conversation, Message, Template, RateBucket, WebhookJob, Notification } = require('./models');
const policy = require('./policy');
const provider = require('./provider');
const mediaService = require('./media');
const mediaStorage = require('./mediaStorage');
const service = require('./service');
const router = express.Router();
const live = require('./live');
const { history } = require('./history');
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const id = (value) => { if (!mongoose.isValidObjectId(value)) fail(400, 'Invalid record identifier.'); return value; };
const text = (value, max = 120) => { if (typeof value !== 'string' || value.length > max) fail(400, `Enter text no longer than ${max} characters.`); return value.trim(); };
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const scoped = (req, query = {}) => ({ $and: [policy.visible(req.actor), query] });
async function conversationFor(req) {
  const item = await Conversation.findOne(scoped(req, { _id: id(req.params.id) })).populate('contact');
  if (!item) fail(404, 'Conversation not found or no longer assigned to you.');
  if(item.deleting) fail(409, 'This chat is being deleted.');
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
// A short-lived, single-use stream ticket never carries the normal login token in a URL.
const tickets = new Map();
const connections = new Map();
router.get('/events', wrap(async (req, res) => {
  const ticket = tickets.get(req.query.ticket); tickets.delete(req.query.ticket);
  if (!ticket || ticket.until < Date.now()) return res.sendStatus(401);
  if (!ticket.actor.admin && !await Staff.exists({ _id: ticket.actor.id, role: { $in: ['SS', 'CSS'] } })) return res.sendStatus(403);
  const open = connections.get(ticket.actor.id) || new Set();
  while (open.size >= 3) { const oldest = open.values().next().value; open.delete(oldest); oldest.end(); }
  open.add(res); connections.set(ticket.actor.id, open);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store', 'X-Accel-Buffering': 'no' });
  res.flushHeaders(); res.write('data: connected\n\n');
  const changed = () => { if (!res.writableEnded && !res.write('data: change\n\n')) res.end(); };
  live.bus.on('change', changed); live.start();
  const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 25000);
  const expiry = setTimeout(() => res.end(), 240000);
  req.on('close', () => { open.delete(res); if (!open.size) connections.delete(ticket.actor.id); clearInterval(heartbeat); clearTimeout(expiry); live.bus.off('change', changed); });
}));
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
router.use((req, res, next) => {
  if (!req.actor.admin) {
    const json = res.json.bind(res);
    res.json = data => json(require('./phonePrivacy').maskPhoneFields(JSON.parse(JSON.stringify(data))));
  }
  next();
});
require('./push').routes(router,wrap,rateLimit);
router.use('/ai', require('./ai/routes'));
router.post('/events-ticket', wrap(async (req, res) => {
  for (const [key, value] of tickets) if (value.until < Date.now()) tickets.delete(key);
  if (tickets.size > 1000) fail(429, 'Please retry shortly.');
  const ticket = require('node:crypto').randomBytes(32).toString('hex');
  tickets.set(ticket, { actor: req.actor, until: Date.now() + 30000 });
  res.json({ ticket });
}));
router.use((req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  if (req.method !== 'GET') res.on('finish', () => { if (res.statusCode < 400) live.notify(); });
  next();
});
router.use(require('./actions')({ wrap, fail, id, conversationFor, rateLimit }));
router.get('/notifications', wrap(async (req, res) => {
  if (req.actor.admin) return res.json({ items: [], unread: 0, next: null });
  const query = { recipient: req.actor.id, ...(req.query.before ? { _id: { $lt: id(req.query.before) } } : {}) };
  const rows = await Notification.find(query).sort({ _id: -1 }).limit(21).lean();
  const unread = await Notification.countDocuments({ recipient: req.actor.id, readAt: null });
  res.json({ items: rows.slice(0, 20), unread, next: rows.length > 20 ? String(rows[19]._id) : null });
}));
router.post('/notifications/:notificationId/read', wrap(async (req, res) => {
  if (req.actor.admin) fail(404, 'Notification not found.');
  const item = await Notification.findOneAndUpdate({ _id: id(req.params.notificationId), recipient: req.actor.id }, { $set: { readAt: new Date() } }, { returnDocument: 'after' });
  if (!item) fail(404, 'Notification not found.');
  res.json({ conversation: item.conversation, message: item.message });
}));
router.get('/session', wrap(async (req, res) => {
  const config = provider.configuration();
  const staff = await Staff.find({ role: { $in: ['SS', 'CSS'] } }).select('name role').sort({ name: 1 }).lean();
  const failedJobs = req.actor.admin ? await WebhookJob.countDocuments({ state: { $in: ['dead', 'blocked'] } }) : undefined;
  res.json({ actor: req.actor, staff, provider: { configured: config.configured, ...(req.actor.admin ? { missing: config.missing, failedJobs } : {}) } });
}));
router.get('/diagnostics', wrap(async (req, res) => {
  if (!req.actor.admin) fail(403, 'Administrator access required.');
  const since = new Date(Date.now() - 86400000);
  const queue = await WebhookJob.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$state', count: { $sum: 1 }, latest: { $max: '$createdAt' } } }]);
  const recent = await WebhookJob.find().select('state createdAt attempts worker result errorCode').sort({ createdAt: -1 }).limit(10).lean();
  res.json({ workerEnabled: require('./workerPolicy').workerEnabled(), phoneIdSuffix: process.env.WHATSAPP_PHONE_NUMBER_ID?.slice(-4), queue, recent });
}));
router.post('/connection-check', wrap(async (req, res) => {
  if (!req.actor.admin) fail(403, 'Administrator access required.');
  await rateLimit(req, 10);
  res.json(await provider.checkConnection());
}));
router.post('/webhooks/retry', wrap(async (req, res) => {
  if (!req.actor.admin) fail(403, 'Administrator access required.');
  await rateLimit(req);
  const result = await WebhookJob.updateMany({ state: { $in: ['dead', 'blocked'] }, $or: [{ routingPhoneIds: process.env.WHATSAPP_PHONE_NUMBER_ID }, { routingPhoneIds: { $exists: false } }] }, { $set: { state: 'pending', attempts: 0, leaseUntil: null }, $unset: { expiresAt: 1 } });
  res.json({ retried: result.modifiedCount });
}));
router.get('/conversations', wrap(async (req, res) => {
  const filter = { $and: [policy.visible(req.actor), { deleting: { $ne: true } }] };
  const view = String(req.query.view || 'inbox');
  if (view === 'mine') filter.$and.push(req.actor.admin ? { _id: null } : { assignedTo: req.actor.id });
  if (view === 'unassigned') filter.$and.push({ assignedTo: null });
  if (view === 'follow_up') filter.$and.push({ status: 'follow_up' });
  else if (view === 'resolved') filter.$and.push({ status: 'resolved' });
  else if (!['contacts', 'inbox'].includes(view) && !['open', 'follow_up', 'resolved'].includes(req.query.status)) filter.$and.push({ status: { $ne: 'resolved' } });
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
  const rows = await Conversation.find(filter).sort({ lastMessageAt: -1, _id: -1 }).limit(21).populate('contact').lean();
  const hasMore = rows.length > 20; const items = rows.slice(0, 20).map((row) => ({ ...row, unread: Boolean(row.lastInboundId && String(row.lastInboundId) > String(row.reads?.[req.actor.id] || '')), reads: undefined }));
  const latestMessages = await Message.find({ _id: { $in: items.map(row => row.lastMessageId).filter(Boolean) }, conversation: { $in: items.map(row => row._id) } }).select('conversation direction type status').lean();
  const latestById = new Map(latestMessages.map(message => [String(message._id), message]));
  for (const row of items) {
    const latest = latestById.get(String(row.lastMessageId));
    row.previewStatus = latest && String(latest.conversation) === String(row._id) && latest.direction === 'outbound' && !['note', 'activity'].includes(latest.type) ? latest.status : null;
  }
  const last = items.at(-1);
  res.json({ items, next: hasMore ? Buffer.from(JSON.stringify({ date: last.lastMessageAt, id: last._id })).toString('base64url') : null });
}));
router.get('/counts', wrap(async (req, res) => {
  const filters = { inbox: { status: { $ne: 'resolved' } }, mine: { assignedTo: req.actor.admin ? null : req.actor.id, status: { $ne: 'resolved' } }, unassigned: { assignedTo: null, status: { $ne: 'resolved' } }, unread: { status: { $ne: 'resolved' }, $expr: { $gt: ['$lastInboundId', { $ifNull: [`$reads.${req.actor.id}`, new mongoose.Types.ObjectId('000000000000000000000000')] }] } }, follow_up: { status: 'follow_up' }, resolved: { status: 'resolved' } };
  // One permission-scoped aggregation instead of six independent count queries.
  const actorScope = policy.visible({ ...req.actor, id: req.actor.admin ? req.actor.id : new mongoose.Types.ObjectId(req.actor.id) });
  if (!req.actor.admin) filters.mine.assignedTo = new mongoose.Types.ObjectId(req.actor.id);
  const [counts] = await Conversation.aggregate([{ $match: actorScope }, { $facet: Object.fromEntries(Object.entries(filters).map(([key, query]) => [key, [{ $match: query }, { $count: 'total' }]])) }]);
  res.json(Object.fromEntries(Object.keys(filters).map(key => [key, counts[key][0]?.total || 0])));
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
  const pattern = require('./crmPhoneMatch')(number);
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
router.delete('/conversations/:id',wrap(async(req,res)=>{
  if(!req.actor.admin)fail(403,'Only administrators can delete chats.');
  if(req.body.confirm!==true)fail(400,'Confirm permanent chat deletion.');
  await rateLimit(req);res.json(await require('./deleteChat').deleteChat(id(req.params.id)));
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
    changes.assignedTo = target; changes['ai.active'] = false; changes['ai.draft'] = null; changes['ai.handoffPending'] = null; changes['ai.assignmentError'] = ''; changes['ai.needsHuman'] = false; changes['ai.handoffReason'] = 'ASSIGNMENT_CHANGED'; descriptions.push(target ? `Assigned to ${agent.name}` : 'Unassigned conversation');
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
  if(changes.assignedTo && String(current.assignedTo)!==String(changes.assignedTo))await require('./push').record(`assignment:${current._id}:${updated.revision}`,'assignments',current._id,changes.assignedTo).catch(()=>{});
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
  if (!req.query.kind && !req.query.before && !req.query.after) return res.json(await history(conversation._id, req.query));
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
  const mime = buffer.subarray(0, 5).toString() === '%PDF-' ? 'application/pdf' : buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' : buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255 ? 'image/jpeg' : buffer.subarray(4, 8).toString() === 'ftyp' ? 'video/mp4' : buffer.subarray(0, 4).toString() === 'OggS' ? 'audio/ogg' : buffer.subarray(0, 3).toString() === 'ID3' || (buffer[0] === 255 && (buffer[1] & 224) === 224) ? 'audio/mpeg' : null;
  if (!mime) fail(400, 'Choose a PNG, JPEG, PDF, MP4, MP3 or OGG file.');
  const name = text(req.body.name || 'attachment', 120).replace(/[^\w. -]/g, '_');
  const mediaId = await provider.upload(buffer, mime, name);
  const media = { id: mediaId, mime, name };
  const ticket = jwt.sign({ media, conversation: String(conversation._id), actor: req.actor.id, purpose: 'inbox-media' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  res.json({ ticket, name, type: mime === 'application/pdf' ? 'document' : mime.split('/')[0] });
}));
router.post('/conversations/:id/messages', wrap(async (req, res) => {
  await rateLimit(req, 60); const conversation = await conversationFor(req);
  if (!policy.canReply(req.actor, conversation)) fail(403, 'Claim this conversation before replying.');
  const type = req.body.type || 'text';
  if (!['text', 'note', 'template', 'image', 'document', 'audio', 'video'].includes(type)) fail(400, 'Unsupported message type.');
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
  } else if (['image', 'document', 'audio', 'video'].includes(type)) {
    let ticket; try { ticket = jwt.verify(req.body.ticket, process.env.JWT_SECRET); } catch { fail(400, 'Attachment expired. Upload it again.'); }
    if (ticket.purpose !== 'inbox-media' || ticket.actor !== req.actor.id || ticket.conversation !== String(conversation._id)) fail(400, 'Invalid attachment.');
    media = ticket.media;
    if (type !== (media.mime === 'application/pdf' ? 'document' : media.mime.split('/')[0])) fail(400, 'Attachment type mismatch.');
    if (body.length > 1024) fail(400, 'Attachment captions must be at most 1024 characters.');
  } else if (!body) fail(400, 'Write a message first.');
  let replyTo;
  if (req.body.replyTo) {
    const original = await Message.findOne({ _id: id(req.body.replyTo), conversation: conversation._id });
    if (!original || original.direction === 'internal' || !original.providerId || ['failed','queued','sending','unknown'].includes(original.status)) fail(400, 'Choose a delivered WhatsApp message to reply to.');
    if (type === 'note' || type === 'template') fail(400, 'Quoted replies require a regular WhatsApp message.');
    replyTo = { message: original._id, providerId: original.providerId, text: original.text.slice(0, 500), type: original.type, authorName: original.direction === 'inbound' ? conversation.contact.name : original.authorName || 'Your team' };
  }
  let mentions = [];
  if (req.body.mentions?.length) {
    if (type !== 'note' || !Array.isArray(req.body.mentions) || req.body.mentions.length > 10) fail(400, 'Mention up to 10 staff in an internal note.');
    mentions = [...new Set(req.body.mentions.map(id))].filter(value => value !== req.actor.id);
    if (await Staff.countDocuments({ _id: { $in: mentions }, role: { $in: ['SS', 'CSS'] } }) !== mentions.length) fail(400, 'Choose an available staff member.');
  }
  if (type !== 'note') await require('./ai/worker').pause(conversation._id, req.actor, 'HUMAN_REPLY');
  let message;
  try { message = await Message.create({ conversation: conversation._id, clientKey, direction: type === 'note' ? 'internal' : 'outbound', type, text: body, author: req.actor.id, authorName: req.actor.name, status: type === 'note' ? 'internal' : 'queued', providerPayload, media, replyTo, mentions, mentionsPending: mentions.length > 0, ...(type !== 'note' ? { routingPhoneId: process.env.WHATSAPP_PHONE_NUMBER_ID } : {}) }); }
  catch (error) { if (error.code !== 11000) throw error; message = await Message.findOne({ clientKey }); }
  await Conversation.updateOne({ _id: conversation._id, $or: [{ lastMessageId: { $lt: message._id } }, { lastMessageId: null }] }, { $set: { lastMessageId: message._id, lastMessageAt: message.createdAt, preview: type === 'note' ? 'Internal note' : body.slice(0, 160) || `[${type}]` } });
  await service.deliverMentions(message);
  const result = message.toObject(); delete result.providerPayload;
  res.status(201).json(result);
}));
router.put('/conversations/:id/messages/:messageId/reaction', wrap(async (req, res) => {
  await rateLimit(req, 60); const conversation = await conversationFor(req);
  if (!policy.canReply(req.actor, conversation)) fail(403, 'Claim this conversation before reacting.');
  const emoji = req.body.emoji;
  if (!['', '👍', '❤️', '😂', '✅', '🙏', '😮'].includes(emoji)) fail(400, 'Choose one of the available reactions.');
  const message = await Message.findOne({ _id: id(req.params.messageId), conversation: conversation._id });
  if (!message || message.type === 'activity') fail(404, 'Message not found.');
  const note = message.type === 'note';
  if (!note && (!message.providerId || ['failed', 'queued', 'sending', 'unknown'].includes(message.status))) fail(400, 'This message is not available for a WhatsApp reaction.');
  if (!note && Date.now() - new Date(message.occurredAt || message.createdAt).getTime() > 30 * 86400000) fail(400, 'WhatsApp reactions are available on messages from the last 30 days.');
  const lease = new Date(Date.now() + 60000);
  const claimed = await Message.updateOne({ _id: message._id, $or: [{ reactionLease: null }, { reactionLease: { $lt: new Date() } }] }, { $set: { reactionLease: lease } });
  if (!claimed.modifiedCount) fail(409, 'Another reaction is being saved. Please try again.');
  try {
    let providerId;
    if (!note) {
      try { providerId = await provider.react(conversation.contact.phone, message.providerId, emoji); }
      catch (error) { fail(502, `WhatsApp could not confirm the reaction${error.response?.data?.error?.code ? ` (code ${Number(error.response.data.error.code)})` : ''}. Please try again.`); }
    }
    const key = note ? `staff_${req.actor.id}` : 'business';
    await Message.updateOne({ _id: message._id }, { $set: { [`reactions.${key}`]: { emoji, name: req.actor.name, timestamp: Date.now(), providerId, status: note ? 'internal' : 'sent' } } });
    live.notify(); res.json({ ok: true });
  } finally { await Message.updateOne({ _id: message._id, reactionLease: lease }, { $unset: { reactionLease: 1 } }); }
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
async function messageMedia(req) {
  const conversation = await conversationFor(req);
  const message = await Message.findOne({ _id: id(req.params.messageId), conversation: conversation._id });
  if (!message?.media?.id) fail(404, 'Attachment not found.');
  const asset = await mediaService.ensure(message);
  if (!asset || String(asset.conversation) !== String(conversation._id)) fail(404, 'Attachment not found.');
  return { asset, conversation };
}
router.get('/conversations/:id/messages/:messageId/media-info', wrap(async (req, res) => {
  const { asset } = await messageMedia(req); res.json(mediaService.safe(asset));
}));
router.get('/conversations/:id/messages/:messageId/media-link', wrap(async (req, res) => {
  const { asset } = await messageMedia(req);
  if (asset.keep && asset.state === 'ready' && asset.key) {
    return res.set('Cache-Control', 'private, no-store').json({ source: 'r2', url: await mediaStorage.link(asset, req.query.download === '1') });
  }
  res.set('Cache-Control', 'private, no-store').json({ source: 'meta' });
}));
router.put('/conversations/:id/messages/:messageId/media-keep', wrap(async (req, res) => {
  await rateLimit(req, 60);
  const { asset, conversation } = await messageMedia(req);
  if (!policy.canReply(req.actor, conversation)) fail(403, 'Only the assigned representative or admin can change media retention.');
  if (typeof req.body.keep !== 'boolean') fail(400, 'Choose whether to keep this media.');
  res.json(await mediaService.keep(asset, req.body.keep));
}));
router.get('/conversations/:id/messages/:messageId/media', wrap(async (req, res) => {
  const { asset } = await messageMedia(req);
  let file;
  try { file = asset.keep && asset.state === 'ready' && asset.key ? await mediaStorage.get(asset.key) : await provider.download(asset.providerId); }
  catch { fail(410, 'This media is no longer available from its provider.'); }
  const mime = String(file.mime || asset.mime).split(';')[0];
  res.set({ 'Content-Type': ['image/jpeg', 'image/png', 'image/webp', 'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/amr', 'video/mp4', 'video/3gpp'].includes(mime) ? mime : 'application/octet-stream', 'Content-Disposition': `attachment; filename="${(asset.name || 'attachment').replace(/[^\w.-]/g, '_')}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' }).send(file.buffer);
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
