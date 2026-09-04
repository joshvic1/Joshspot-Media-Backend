const mongoose = require("mongoose");

const adsClientSchema = new mongoose.Schema({
  businessName: {
    type: String,
    required: true,
    trim: true,
  },

  amountPaid: {
    type: Number,
    default: 0,
  },

  videoLinks: {
    type: String,
    required: true,
    trim: true,
  },

  servicePaidFor: {
    type: String,
    enum: [
      "TikTok Ads Landing Page",
      "TikTok DM Ads",
      "Meta Ads Landing Page",
      "Meta DM Ads",
    ],
    required: true,
  },

  note: {
    type: String,
    default: "",
    trim: true,
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

module.exports = mongoose.model("AdsClient", adsClientSchema);
