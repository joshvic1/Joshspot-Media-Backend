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
  expiresAt: Date,

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("Invoice", invoiceSchema);
