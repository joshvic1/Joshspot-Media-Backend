const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Contact, Conversation, Message, WebhookJob, Template, Notification } = require('./models');
const live = require('./live');
const policy = require('./policy');
const provider = require('./provider');

// Optional integrations subscribe here. Durable integrations should consume stored messages by cursor.
const events = new EventEmitter();
function publish(name, payload) {
  live.notify();
  for (const listener of events.listeners(name)) Promise.resolve().then(() => listener(payload)).catch(() => console.error(`Inbox extension failed: ${name}`));
}
async function upsertContact(number, name = '') {
  const normalized = policy.phone(number);
  try { return await Contact.findOneAndUpdate({ phone: normalized }, { $setOnInsert: { phone: normalized, name: name.slice(0, 120) } }, { upsert: true, returnDocument: 'after' }); }
  catch (error) { if (error.code === 11000) return Contact.findOne({ phone: normalized }); throw error; }
}
async function openConversation(contact) {
  try { return await Conversation.findOneAndUpdate({ contact: contact._id, channel: 'whatsapp' }, { $setOnInsert: { contact: contact._id, channel: 'whatsapp' } }, { upsert: true, returnDocument: 'after' }); }
  catch (error) { if (error.code === 11000) return Conversation.findOne({ contact: contact._id, channel: 'whatsapp' }); throw error; }
}
async function activity(conversation, actor, text) {
  live.notify();
  return Message.create({ conversation, direction: 'internal', type: 'activity', status: 'internal', author: actor.id, authorName: actor.name, text });
}
async function receive(value) {
  if (String(value.metadata?.phone_number_id) !== process.env.WHATSAPP_PHONE_NUMBER_ID) return;
  for (const item of value.messages || []) {
    if (!item.id || !item.from) continue;
    const name = value.contacts?.find((contact) => contact.wa_id === item.from)?.profile?.name || '';
    const contact = await upsertContact(item.from, name);
    const conversation = await openConversation(contact);
    const type = ['text', 'image', 'document', 'audio', 'video', 'sticker'].includes(item.type) ? item.type : 'unsupported';
    const text = item.text?.body || item[item.type]?.caption || item.interactive?.button_reply?.title || item.interactive?.list_reply?.title || item.button?.text || `[${item.type || 'Unsupported'} message]`;
    const timestamp = Number(item.timestamp) * 1000;
    const occurredAt = new Date(Number.isFinite(timestamp) && timestamp > 0 ? Math.min(timestamp, Date.now()) : Date.now());
    let result;
    try {
      result = await Message.updateOne({ providerId: item.id }, { $setOnInsert: { conversation: conversation._id, direction: 'inbound', type, text: text.slice(0, 10000), status: 'received', providerId: item.id, occurredAt, ...(item[item.type]?.id ? { media: { id: item[item.type].id, mime: item[item.type].mime_type, name: item[item.type].filename } } : {}) } }, { upsert: true });
    } catch (error) { if (error.code !== 11000) throw error; }
    const stored = await Message.findOne({ providerId: item.id }).select('_id createdAt');
    // Repairable after a crash between storing the message and updating its conversation.
    await Conversation.updateOne({ _id: conversation._id, $or: [{ lastInboundId: { $lt: stored._id } }, { lastInboundId: null }] }, { $set: { lastInboundId: stored._id, status: 'open', resolvedAt: null }, $max: { lastInboundAt: occurredAt }, $inc: { revision: 1 } });
    await Conversation.updateOne({ _id: conversation._id, $or: [{ lastMessageId: { $lt: stored._id } }, { lastMessageId: null }] }, { $set: { lastMessageId: stored._id, lastMessageAt: stored.createdAt, preview: text.slice(0, 160) } });
    if (result?.upsertedCount) publish('message.received', { conversationId: String(conversation._id), providerId: item.id });
  }
  for (const item of value.statuses || []) {
    if (typeof item.id !== 'string' || !item.id || !['sent', 'delivered', 'read', 'failed'].includes(item.status)) continue;
    const clauses = [{ providerId: item.id }];
    const callback = /^([a-f0-9]{24}):(\d+)$/.exec(item.biz_opaque_callback_data || '');
    if (callback) clauses.push({ _id: callback[1], attempts: Number(callback[2]), status: { $ne: 'queued' } });
    const message = await Message.findOne({ direction: 'outbound', $or: clauses });
    if (!message || !policy.statusCanAdvance(message.status, item.status)) continue;
    const update = { status: item.status, providerId: item.id, error: item.status === 'failed' ? `WhatsApp could not deliver this message (code ${Number(item.errors?.[0]?.code) || 'unknown'}).` : '' };
    if (item.status !== 'failed') update[`${item.status}At`] = new Date(Number(item.timestamp) * 1000 || Date.now());
    const allowed = ['sending', 'unknown', 'sent', 'delivered', 'failed'].filter((status) => policy.statusCanAdvance(status, item.status));
    await Message.updateOne({ _id: message._id, attempts: message.attempts, status: { $in: allowed } }, { $set: update });
    live.notify();
  }
}
async function enqueueWebhook(raw, payload) {
  const key = crypto.createHash('sha256').update(raw).digest('hex');
  try { await WebhookJob.updateOne({ key }, { $setOnInsert: { key, payload, state: 'pending' } }, { upsert: true }); }
  catch (error) { if (error.code !== 11000) throw error; }
}
async function deliverMentions(message) {
  if (!message.mentionsPending) return;
  const recipients = message.mentions || [];
  if (recipients.length) {
    await Conversation.updateOne({ _id: message.conversation }, { $addToSet: { collaborators: { $each: recipients } } });
    await Notification.bulkWrite(recipients.map(recipient => ({ updateOne: { filter: { recipient, message: message._id }, update: { $setOnInsert: { recipient, message: message._id, conversation: message.conversation, authorName: message.authorName } }, upsert: true } })));
  }
  await Message.updateOne({ _id: message._id }, { $set: { mentionsPending: false } });
  live.notify();
}
async function processMentions() {
  for (const message of await Message.find({ mentionsPending: true }).limit(25)) await deliverMentions(message);
}
async function processWebhooks() {
  for (let count = 0; count < 25; count++) {
    const now = new Date();
    const job = await WebhookJob.findOneAndUpdate({ $or: [{ state: 'pending', $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }] }, { state: 'processing', leaseUntil: { $lt: now } }] }, { $set: { state: 'processing', leaseUntil: new Date(Date.now() + 120000) }, $inc: { attempts: 1 } }, { returnDocument: 'after', sort: { createdAt: 1 } });
    if (!job) break;
    try {
      for (const entry of job.payload.entry || []) for (const change of entry.changes || []) if (change.field === 'messages') await receive(change.value || {});
      await WebhookJob.updateOne({ _id: job._id }, { $set: { state: 'done', expiresAt: new Date(Date.now() + 7 * 86400000) }, $unset: { payload: 1, error: 1 } });
    } catch {
      await WebhookJob.updateOne({ _id: job._id }, { $set: { state: job.attempts >= 10 ? 'dead' : 'pending', leaseUntil: new Date(Date.now() + Math.min(job.attempts * 30000, 600000)), error: 'Processing failed; inspect configuration and database availability.' } });
      console.error('Inbox webhook processing failed', String(job._id));
    }
  }
}
async function processOutbox() {
  // A crashed/timeout request may already have reached Meta: never resend automatically.
  await Message.updateMany({ status: 'sending', attemptedAt: { $lt: new Date(Date.now() - 120000) } }, { $set: { status: 'unknown', error: 'Delivery is uncertain. Wait for a WhatsApp status update before sending again.' } });
  if (!provider.configuration().configured) return;
  for (let count = 0; count < 15; count++) {
    const message = await Message.findOneAndUpdate({ direction: 'outbound', status: 'queued' }, { $set: { status: 'sending', attemptedAt: new Date() }, $inc: { attempts: 1 } }, { returnDocument: 'after', sort: { createdAt: 1 } }).select('+providerPayload');
    if (!message) break;
    try {
      const conversation = await Conversation.findById(message.conversation).populate('contact');
      if (message.author !== 'admin' && !await require('../models/Staff').exists({ _id: message.author, role: { $in: ['SS', 'CSS'] } })) throw Object.assign(new Error('The sending representative no longer has messaging access.'), { safe: true });
      if (!conversation || (message.author !== 'admin' && String(conversation.assignedTo) !== message.author)) throw Object.assign(new Error('Assignment changed. Claim the conversation and try again.'), { safe: true });
      if (message.type !== 'template' && !policy.windowOpen(conversation.lastInboundAt)) throw Object.assign(new Error('The 24-hour reply window closed. Send an approved template.'), { safe: true });
      const id = await provider.send(conversation.contact.phone, message);
      await Message.updateOne({ _id: message._id, status: { $in: ['sending', 'unknown'] } }, { $set: { status: 'sent', providerId: id, sentAt: new Date(), error: '' } });
      publish('message.sent', { messageId: String(message._id), conversationId: String(message.conversation) });
    } catch (error) {
      live.notify();
      const definite = error.safe || (error.response?.status >= 400 && error.response?.status < 500 && error.response.status !== 408);
      const code = Number(error.response?.data?.error?.code);
      await Message.updateOne({ _id: message._id, status: 'sending' }, { $set: { status: definite ? 'failed' : 'unknown', error: error.safe ? error.message : definite ? `WhatsApp rejected this message${code ? ` (code ${code})` : ''}. Check the recipient, template and provider settings before retrying.` : 'Delivery is uncertain. Wait for a WhatsApp status update before sending again.' } });
    }
  }
}
let running = false;
async function tick() {
  if (running) return;
  running = true;
  try { live.start(); await processWebhooks(); await processOutbox(); await processMentions(); } catch { console.error('Inbox worker temporarily unavailable'); } finally { running = false; }
}
async function syncTemplates() {
  const items = await provider.templates(); const syncedAt = new Date();
  for (const item of items) await Template.updateOne({ externalId: item.id }, { $set: { externalId: item.id, name: item.name, language: item.language, category: item.category, status: item.status, components: item.components || [], syncedAt } }, { upsert: true });
  await Template.updateMany({ syncedAt: { $lt: syncedAt } }, { $set: { status: 'UNAVAILABLE' } });
  return items.length;
}
module.exports = { deliverMentions, processMentions, events, activity, upsertContact, openConversation, enqueueWebhook, receive, processWebhooks, processOutbox, tick, syncTemplates };
