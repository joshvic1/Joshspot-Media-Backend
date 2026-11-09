const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  telegramUserId: { type: String, required: true, unique: true, index: true },
  accessToken: { type: String, default: '', trim: true },
  state: { type: String, enum: ['awaiting_email'], default: 'awaiting_email' },
  expiresAt: { type: Date, required: true, index: true },
}, { timestamps: true });

schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.models.TelegramCourseSession || mongoose.model('TelegramCourseSession', schema);
