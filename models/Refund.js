const mongoose = require("mongoose");

const selectedRecordSchema = new mongoose.Schema({
  kind: { type: String, enum: ["setup", "ads", "verification"], required: true },
  record: { type: mongoose.Schema.Types.ObjectId, required: true },
  label: { type: String, default: "" },
}, { _id: false });

const refundSchema = new mongoose.Schema({
  invoice: { type: mongoose.Schema.Types.ObjectId, ref: "Invoice", required: true, index: true },
  provider: { type: String, enum: ["paystack", "flutterwave"], required: true },
  amount: { type: Number, required: true, min: 1 },
  currency: { type: String, default: "NGN" },
  reason: { type: String, required: true, trim: true, maxlength: 500 },
  status: {
    type: String,
    enum: ["initiating", "pending", "processing", "needs_attention", "processed", "failed"],
    default: "initiating",
    index: true,
  },
  providerRefundId: { type: String, default: "", index: true },
  providerStatus: { type: String, default: "" },
  idempotencyKey: { type: String, required: true, maxlength: 128 },
  initiatedBy: { type: String, default: "" },
  selectedRecords: { type: [selectedRecordSchema], default: [] },
  retractionsAppliedAt: Date,
  providerResponse: { type: mongoose.Schema.Types.Mixed, default: null },
  errorCode: { type: String, default: "" },
  errorMessage: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

refundSchema.index({ invoice: 1, idempotencyKey: 1 }, { unique: true });
refundSchema.index({ provider: 1, providerRefundId: 1 }, { sparse: true });

module.exports = mongoose.model("Refund", refundSchema);
