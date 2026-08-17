const mongoose = require("mongoose");

const growthAssessmentSchema = new mongoose.Schema({
  fullName: { type: String, required: true, trim: true },
  businessName: { type: String, required: true, trim: true },
  whatsappNumber: { type: String, required: true, trim: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  websiteOrSocialPage: { type: String, required: true, trim: true },

  businessType: { type: String, required: true },
  businessAge: { type: String, required: true },
  monthlyRevenue: { type: String, required: true },

  marketingPlatforms: { type: [String], default: [] },
  paidAdsExperience: { type: String, required: true },
  monthlyAdSpend: { type: String, required: true },
  adPlatformsUsed: { type: [String], default: [] },
  biggestAdsProblem: { type: String, required: true },

  marketingGoal: { type: String, required: true, trim: true },
  growthBlocker: { type: String, required: true, trim: true },
  attemptedSolutions: { type: String, required: true, trim: true },
  attemptedResults: { type: String, required: true, trim: true },
  sixMonthImpact: { type: String, required: true, trim: true },

  decisionAuthority: { type: String, required: true },
  finalDecisionMaker: { type: String, default: "", trim: true },
  investmentCapacity: { type: String, required: true },
  desiredHelp: { type: String, required: true },
  urgency: { type: String, required: true },
  implementationReadiness: { type: String, required: true },
  extraContext: { type: String, default: "", trim: true },

  score: { type: Number, required: true },
  endpoint: { type: String, required: true },
  recommendationTitle: { type: String, required: true },
  recommendationMessage: { type: String, required: true },
  recommendedAction: { type: String, required: true },
  redirectUrl: { type: String, required: true },

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("GrowthAssessment", growthAssessmentSchema);
