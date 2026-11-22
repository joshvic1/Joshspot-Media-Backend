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
  clientNumber: { type: String, trim: true, default: "" },

  videoLinks: {
    type: String,
    required: true,
    trim: true,
  },

  clientLoginDetails: {
    type: String,
    default: "",
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

  adsPublished: {
    type: Boolean,
    default: false,
  },
  fundsSent: { type: Boolean, default: false },
  fundsStatus: { type: String, enum: ["pending", "sent", "not_needed"], default: function () { return this.fundsSent ? "sent" : "pending"; } },

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

adsClientSchema.add({ inboxRequestKey: { type: String, unique: true, sparse: true } });
adsClientSchema.index({ retractedAt: 1 });

module.exports = mongoose.model("AdsClient", adsClientSchema);
