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
    sourceLabel: { type: String, default: "", maxlength: 80 },
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
  tiktokPurchaseQueuedAt: Date,
  tiktokPurchaseSentAt: Date,
  tiktokPurchaseClaimedAt: Date,
  tiktokPurchaseRetryAt: Date,
  tiktokPurchaseError: String,
  courseEmailSentAt: Date,
  courseEmailId: String,
  courseEmailClaimedAt: Date,
  courseEmailQueuedAt: Date,
  courseEmailRetryAt: Date,
  courseEmailError: String,
  courseEmailSendCount: { type: Number, default: 0 },
  reminderEmailId: String,
  supportAlertDueAt: Date,
  supportAlertSentAt: Date,
  supportAlertClaimedAt: Date,
  supportAlertRetryAt: Date,
  supportAlertEmailId: String,
  expiresAt: Date,

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("Invoice", invoiceSchema);
