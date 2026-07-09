const mongoose = require("mongoose");

const clientSchema = new mongoose.Schema({
  businessName: {
    type: String,
    required: true,
    trim: true,
  },

  amountPaid: {
    type: Number,
    default: 0,
  },

  servicePaidFor: {
    type: String,
    enum: [
      "Meta ads setup",
      "TikTok ads setup - DM",
      "Tiktok Ads Setup - Landing Page",
    ],
    required: true,
  },

  clientLoginDetails: {
    type: String,
    default: "",
  },

  landingPageLogins: {
    type: String,
    default: "",
  },

  landingPageLink: {
    type: String,
    default: "",
  },

  clientNumber: {
    type: String,
    default: "",
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

module.exports = mongoose.model("Client", clientSchema);
