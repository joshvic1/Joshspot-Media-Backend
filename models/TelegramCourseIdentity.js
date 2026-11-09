const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  email: { type: String, required: true, trim: true, lowercase: true, unique: true, index: true },
  telegramUserId: { type: String, required: true, trim: true, index: true },
  telegramUsername: { type: String, default: '', trim: true },
  telegramName: { type: String, default: '', trim: true },
  boundAt: { type: Date, default: Date.now },
  lastAccessAt: { type: Date, default: Date.now },
  revokedAt: Date,
  revokedReason: { type: String, default: '', trim: true, maxlength: 500 },
  bindingReleasedAt: Date,
  bindingReleasedReason: { type: String, default: '', trim: true, maxlength: 500 },
}, { timestamps: true });

schema.index({ email: 1, telegramUserId: 1 });
module.exports = mongoose.models.TelegramCourseIdentity || mongoose.model('TelegramCourseIdentity', schema);
