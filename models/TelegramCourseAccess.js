const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  identity: { type: mongoose.Schema.Types.ObjectId, ref: 'TelegramCourseIdentity', required: true, index: true },
  invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', required: true, index: true },
  channel: { type: mongoose.Schema.Types.ObjectId, ref: 'TelegramCourseChannel', required: true, index: true },
  telegramUserId: { type: String, required: true, index: true },
  status: { type: String, enum: ['approved', 'revoked'], default: 'approved', index: true },
  approvedAt: { type: Date, default: Date.now },
  revokedAt: Date,
  revokedReason: { type: String, default: '', trim: true, maxlength: 500 },
}, { timestamps: true });

schema.index({ identity: 1, channel: 1 }, { unique: true });
module.exports = mongoose.models.TelegramCourseAccess || mongoose.model('TelegramCourseAccess', schema);
