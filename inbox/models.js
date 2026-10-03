const mongoose = require('mongoose');
const { Schema } = mongoose;
const ref = (model) => ({ type: Schema.Types.ObjectId, ref: model });
const contact = new Schema({
  phone: { type: String, required: true, unique: true }, name: { type: String, default: '' },
  email: { type: String, default: '' }, source: { type: String, default: 'WhatsApp' }, service: { type: String, default: '' },
  status: { type: String, default: 'lead', enum: ['lead', 'customer', 'inactive'] },
  revision: { type: Number, default: 0 },
}, { timestamps: true });
contact.index({ name: 'text', phone: 'text', email: 'text' });
contact.index({ name: 1 });
contact.index({ email: 1 });
const conversation = new Schema({
  contact: { ...ref('InboxContact'), required: true }, channel: { type: String, default: 'whatsapp' },
  assignedTo: { ...ref('Staff'), default: null }, status: { type: String, enum: ['open', 'follow_up', 'resolved'], default: 'open' },
  labels: [String], revision: { type: Number, default: 0 }, lastInboundAt: Date, followUpAt: Date,
  lastMessageAt: { type: Date, default: Date.now }, lastMessageId: Schema.Types.ObjectId, preview: String,
  reads: { type: Map, of: Schema.Types.ObjectId, default: {} }, lastInboundId: Schema.Types.ObjectId, resolvedAt: Date,
}, { timestamps: true });
conversation.index({ contact: 1, channel: 1 }, { unique: true });
conversation.index({ assignedTo: 1, status: 1, lastMessageAt: -1, _id: -1 });
conversation.add({ collaborators: [{ type: Schema.Types.ObjectId, ref: 'Staff' }] });
conversation.add({ ai: {
  phoneId:String, active: {type:Boolean,default:true}, pending:Boolean, pendingAt:Date, leaseUntil:Date, leaseToken:String,
  version:{type:Number,default:0}, lastProcessedId:Schema.Types.ObjectId, state:Schema.Types.Mixed,
  draft:Schema.Types.Mixed, handoffReason:String, needsHuman:Boolean, priority:Boolean,
  consecutive:{type:Number,default:0}, returnedBy:String, sendLease:Date,
} });
conversation.index({'ai.pending':1,'ai.pendingAt':1,'ai.leaseUntil':1});
conversation.index({ collaborators: 1, lastMessageAt: -1, _id: -1 });
conversation.index({ status: 1, lastMessageAt: -1, _id: -1 });
conversation.index({ lastMessageAt: -1, _id: -1 });
conversation.index({ assignedTo: 1, status: 1, followUpAt: 1 });
const message = new Schema({
  conversation: { ...ref('InboxConversation'), required: true }, direction: { type: String, enum: ['inbound', 'outbound', 'internal'], required: true },
  type: { type: String, enum: ['text', 'template', 'image', 'document', 'audio', 'video', 'sticker', 'unsupported', 'note', 'activity'], required: true },
  text: { type: String, default: '' }, author: String, authorName: String,
  providerId: { type: String, unique: true, sparse: true }, clientKey: { type: String, unique: true, sparse: true },
  status: { type: String, default: 'queued', enum: ['queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'unknown', 'received', 'internal'] },
  providerPayload: { type: Schema.Types.Mixed, select: false }, media: { id: String, mime: String, name: String },
  error: String, sentAt: Date, deliveredAt: Date, readAt: Date, attemptedAt: Date, attempts: { type: Number, default: 0 },
  occurredAt: { type: Date, default: Date.now },
}, { timestamps: true });
message.add({ mentions: [{ type: Schema.Types.ObjectId, ref: 'Staff' }], mentionsPending: Boolean, routingPhoneId: String, 'media.asset': ref('InboxMedia'), reactions: { type: Map, of: new Schema({ emoji: String, name: String, timestamp: Number, providerId: String, status: String }, { _id: false }) }, reactionLease: Date });
message.index({ 'media.id': 1, 'media.asset': 1 });
message.add({ automation: {version:Number, inputId:Schema.Types.ObjectId, configRevision:Number, handoff:Boolean} });
message.index({ conversation: 1, createdAt: -1, _id: -1 });
message.index({ conversation: 1, updatedAt: 1, _id: 1 });
message.index({ mentionsPending: 1 });
message.index({ 'reactions.business.providerId': 1 }, { sparse: true });
message.index({ conversation: 1, _id: -1 });
message.index({ conversation: 1, type: 1, _id: -1 });
message.index({ conversation: 1, direction: 1, occurredAt: -1 });
message.index({ status: 1, createdAt: 1 });
message.index({ text: 'text' });
const job = new Schema({ key: { type: String, unique: true }, payload: Schema.Types.Mixed, state: { type: String, default: 'pending' }, leaseUntil: Date, attempts: { type: Number, default: 0 }, error: String, expiresAt: Date }, { timestamps: true });
job.add({ routingPhoneIds: { type: [String], default: undefined }, worker: String, result: Schema.Types.Mixed, errorCode: String });
job.index({ routingPhoneIds: 1, state: 1, leaseUntil: 1 });
job.index({ state: 1, leaseUntil: 1 });
job.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const template = new Schema({ externalId: { type: String, unique: true }, name: String, language: String, category: String, status: String, components: [Schema.Types.Mixed], syncedAt: Date });
const rate = new Schema({ key: { type: String, unique: true }, count: Number, expiresAt: Date });
rate.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const notification = new Schema({ kind: {type:String,default:'mention'}, recipient: { type: Schema.Types.ObjectId, required: true }, conversation: { ...ref('InboxConversation'), required: true }, message: { ...ref('InboxMessage'), required: true }, authorName: String, readAt: Date }, { timestamps: true });
notification.index({ recipient: 1, message: 1 }, { unique: true });
notification.index({ recipient: 1, _id: -1 });
notification.index({ recipient: 1, readAt: 1 });
const media = new Schema({
  source: { type: String, unique: true }, conversation: { ...ref('InboxConversation'), required: true },
  providerId: String, key: String, url: String, mime: String, name: String, size: Number,
  state: { type: String, default: 'pending', enum: ['pending', 'copying', 'ready', 'failed', 'deleting', 'deleted'] },
  keep: { type: Boolean, default: false }, expiresAt: Date,
  leaseUntil: Date, attempts: { type: Number, default: 0 }, error: String,
}, { timestamps: true });
media.index({ state: 1, leaseUntil: 1 });
media.index({ keep: 1, expiresAt: 1, state: 1 });
module.exports = {
  Media: mongoose.model('InboxMedia', media),
  Notification: mongoose.model('InboxNotification', notification),
  Contact: mongoose.model('InboxContact', contact), Conversation: mongoose.model('InboxConversation', conversation),
  Message: mongoose.model('InboxMessage', message), WebhookJob: mongoose.model('InboxWebhookJob', job),
  Template: mongoose.model('InboxTemplate', template), RateBucket: mongoose.model('InboxRateBucket', rate),
};
