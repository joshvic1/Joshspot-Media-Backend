const mongoose = require('mongoose');
const { Schema } = mongoose;
const QuickReply = mongoose.model('InboxQuickReply', new Schema({
  keyword: { type: String, required: true, unique: true }, response: { type: String, required: true }, updatedBy: String,
}, { timestamps: true }));
const Action = mongoose.model('InboxStaffAction', new Schema({
  key: { type: String, unique: true }, conversation: Schema.Types.ObjectId, kind: String, fingerprint: String,
  state: String, result: Schema.Types.Mixed,
}, { timestamps: true }));
const maskPhone = value => { const p = String(value || '').replace(/\D/g, ''); return p ? `+${p.startsWith('234') ? '234' : p.slice(0, 1)}******${p.slice(-3)}` : ''; };
module.exports = { QuickReply, Action, maskPhone };
