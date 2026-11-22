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

  setupCompletedAt: {
    type: Date,
    default: null,
  },

  setupCompletedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Staff",
    default: null,
  },

  // A refund may remove a service record from day-to-day CRM views without
  // destroying the original record or its audit trail.
  retractedAt: { type: Date, default: null },
  retractedBy: { type: String, default: "" },
  retractedByRefund: { type: mongoose.Schema.Types.ObjectId, ref: "Refund", default: null },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

clientSchema.add({ inboxRequestKey: { type: String, unique: true, sparse: true } });
clientSchema.index({ retractedAt: 1 });

module.exports = mongoose.model("Client", clientSchema);
