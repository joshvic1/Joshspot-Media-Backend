const mongoose = require("mongoose");

const invoiceSchema = new mongoose.Schema({
  token: {
    type: String,
    required: true,
    unique: true,
  },

  amount: {
    type: Number,
    required: true,
  },

  customerName: {
    type: String,
    default: "",
    trim: true,
  },

  customerEmail: {
    type: String,
    default: "",
    lowercase: true,
    trim: true,
  },
  customerPhone: { type: String, default: "", trim: true },
  attribution: {
    source: { type: String, default: "unknown" },
    method: { type: String, default: "none" },
    browser: { type: String, default: "unknown" },
  },
  product: { type: String, default: "", index: true },
  reminderSentAt: Date,
  reminderClaimedAt: Date,
  reminderCount: { type: Number, default: 0 },
  paymentCheckedAt: Date,
  deletedAt: Date,

  note: {
    type: String,
    default: "",
    trim: true,
  },

  reference: String,
  status: {
    type: String,
    enum: ["draft", "pending", "paid", "expired", "failed"],
    default: "draft",
  },

  accountName: String,
  accountNumber: String,
  bankName: String,
  paystackStatus: String,
  paidAt: Date,
  courseEmailSentAt: Date,
  courseEmailId: String,
  reminderEmailId: String,
  expiresAt: Date,

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("Invoice", invoiceSchema);
