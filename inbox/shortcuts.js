const mongoose = require('mongoose');
const { Schema } = mongoose;
const QuickReply = mongoose.model('InboxQuickReply', new Schema({
  keyword: { type: String, required: true, unique: true }, response: { type: String, required: true }, updatedBy: String,
}, { timestamps: true }));
const Action = mongoose.model('InboxStaffAction', new Schema({
  key: { type: String, unique: true }, conversation: Schema.Types.ObjectId, kind: String, fingerprint: String,
  state: String, result: Schema.Types.Mixed,
}, { timestamps: true }));
const { maskPhone } = require('./phonePrivacy');
module.exports = { QuickReply, Action, maskPhone };
