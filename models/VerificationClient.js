const mongoose = require("mongoose");

const verificationClientSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },

  businessName: {
    type: String,
    required: true,
    trim: true,
  },

  clientLoginDetails: {
    type: String,
    required: true,
    trim: true,
  },

  amountPaid: {
    type: Number,
    required: true,
  },

  clientNumber: {
    type: String,
    required: true,
    trim: true,
  },

  service: {
    type: String,
    default: "Verification",
  },

  idCard: {
    fileName: String,
    mimeType: String,
    key: String,
    size: Number,
  },

  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Staff",
  },

  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Staff",
  },

  retractedAt: { type: Date, default: null },
  retractedBy: { type: String, default: "" },
  retractedByRefund: { type: mongoose.Schema.Types.ObjectId, ref: "Refund", default: null },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

verificationClientSchema.add({ inboxRequestKey: { type: String, unique: true, sparse: true } });
verificationClientSchema.index({ retractedAt: 1 });

module.exports = mongoose.model("VerificationClient", verificationClientSchema);
