const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  inviteLink: { type: String, required: true, unique: true },
  identity: { type: mongoose.Schema.Types.ObjectId, ref: 'TelegramCourseIdentity', required: true, index: true },
  channel: { type: mongoose.Schema.Types.ObjectId, ref: 'TelegramCourseChannel', required: true, index: true },
  telegramUserId: { type: String, required: true, index: true },
  expiresAt: { type: Date, required: true, index: true },
  status: { type: String, enum: ['active', 'approved', 'declined', 'expired', 'revoked'], default: 'active', index: true },
  approvedAt: Date,
  declinedAt: Date,
}, { timestamps: true });

schema.index({ channel: 1, telegramUserId: 1, status: 1 });
module.exports = mongoose.models.TelegramCourseInvite || mongoose.model('TelegramCourseInvite', schema);
