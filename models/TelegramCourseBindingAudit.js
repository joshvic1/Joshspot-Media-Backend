const mongoose = require('mongoose');

// Preserves the previous link when an administrator deliberately releases a
// paid email from one Telegram account for another account to claim.
const schema = new mongoose.Schema({
  identity: { type: mongoose.Schema.Types.ObjectId, ref: 'TelegramCourseIdentity', required: true, index: true },
  email: { type: String, required: true, trim: true, lowercase: true, index: true },
  releasedTelegramUserId: { type: String, required: true, trim: true, index: true },
  releasedTelegramUsername: { type: String, default: '', trim: true },
  releasedTelegramName: { type: String, default: '', trim: true },
  reason: { type: String, default: '', trim: true, maxlength: 500 },
  releasedAt: { type: Date, default: Date.now, index: true },
}, { timestamps: true });

schema.index({ email: 1, releasedAt: -1 });
module.exports = mongoose.models.TelegramCourseBindingAudit || mongoose.model('TelegramCourseBindingAudit', schema);
