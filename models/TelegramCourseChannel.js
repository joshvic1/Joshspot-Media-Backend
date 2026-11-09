const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 120 },
  chatId: { type: String, required: true, trim: true, unique: true },
  product: { type: String, enum: ['ads-course', 'whatsapp-course'], required: true, index: true },
  active: { type: Boolean, default: true },
  discoveredAt: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.models.TelegramCourseChannel || mongoose.model('TelegramCourseChannel', schema);
