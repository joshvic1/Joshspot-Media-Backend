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

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("VerificationClient", verificationClientSchema);
