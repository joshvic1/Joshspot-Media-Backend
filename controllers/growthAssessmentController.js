const GrowthAssessment = require("../models/GrowthAssessment");

const scoreMaps = {
  monthlyRevenue: {
    "NGN 0-NGN 100k": 2,
    "NGN 100k-NGN 500k": 8,
    "NGN 500k-NGN 1m": 14,
    "NGN 1m-NGN 5m": 19,
    "NGN 5m-NGN 10m": 23,
    "NGN 10m+": 25,
  },
  monthlyAdSpend: {
    "NGN 0": 0,
    "Below NGN 50k": 3,
    "NGN 50k-NGN 100k": 6,
    "NGN 100k-NGN 500k": 11,
    "NGN 500k-NGN 1m": 15,
    "NGN 1m-NGN 5m": 18,
    "NGN 5m+": 20,
  },
  biggestAdsProblem: {
    "I am getting views but not sales": 7,
    "I am getting clicks/messages but not enough customers": 9,
    "My cost per customer is too high": 13,
    "I do not know what type of content/creative to use": 8,
    "I do not know how to structure my campaigns": 8,
    "My campaigns do not scale": 14,
    "I do not understand my data": 9,
    "I have tried several strategies and nothing works consistently": 15,
    Other: 7,
  },
  urgency: {
    "Just researching": 1,
    "Within the next 1-3 months": 5,
    "Within the next few weeks": 8,
    Immediately: 10,
  },
  proposedMonthlyAdBudget: {
    "I am not ready to spend on ads yet": 0,
    "Below NGN 50k": 2,
    "NGN 50k-NGN 100k": 5,
    "NGN 100k-NGN 250k": 8,
    "NGN 250k-NGN 500k": 11,
    "NGN 500k-NGN 1m": 13,
    "NGN 1m+": 15,
  },
  businessOwnership: {
    "I am the sole owner": 5,
    "I own the business with a partner/co-founder": 3,
    "I manage marketing, but I am not an owner": 0,
  },
  businessAge: {
    "Less than 3 months": 1,
    "3-6 months": 2,
    "6-12 months": 3,
    "1-3 years": 4,
    "3+ years": 5,
  },
  paidAdsExperience: {
    Never: 0,
    "Yes, but only occasionally": 2,
    "Yes, consistently": 4,
    "Yes, and I am currently running ads": 5,
  },
};

const requiredFields = [
  "fullName",
  "businessName",
  "whatsappNumber",
  "email",
  "websiteOrSocialPage",
  "businessType",
  "brandDescription",
  "businessAge",
  "monthlyRevenue",
  "marketingPlatforms",
  "paidAdsExperience",
  "monthlyAdSpend",
  "biggestAdsProblem",
  "marketingGoal",
  "growthBlocker",
  "attemptedSolutions",
  "businessOwnership",
  "proposedMonthlyAdBudget",
  "desiredHelp",
  "urgency",
  "implementationReadiness",
];

const getScore = (group, value) => scoreMaps[group]?.[value] || 0;

const hasNoRealBudget = (body) =>
  body.monthlyAdSpend === "NGN 0" ||
  body.proposedMonthlyAdBudget === "I am not ready to spend on ads yet";

const hasLowTeamBudget = (body) =>
  body.implementationReadiness === "Yes" &&
  (body.teamMonthlyBudget === "Below NGN 50k" || !body.teamMonthlyBudget);

const getAssessmentResult = (body) => {
  const score =
    getScore("monthlyRevenue", body.monthlyRevenue) +
    getScore("monthlyAdSpend", body.monthlyAdSpend) +
    getScore("biggestAdsProblem", body.biggestAdsProblem) +
    getScore("urgency", body.urgency) +
    getScore("proposedMonthlyAdBudget", body.proposedMonthlyAdBudget) +
    getScore("businessOwnership", body.businessOwnership) +
    getScore("businessAge", body.businessAge) +
    getScore("paidAdsExperience", body.paidAdsExperience);

  const wantsFreeOnly =
    body.desiredHelp === "Free advice/resources" ||
    body.implementationReadiness === "No, I am only looking for free advice";

  const isNotDecisionMaker =
    body.businessOwnership === "I manage marketing, but I am not an owner";
  const revenueTooLow =
    body.monthlyRevenue === "NGN 0-NGN 100k" ||
    body.monthlyRevenue === "NGN 100k-NGN 500k";

  if (wantsFreeOnly || score <= 29) {
    return {
      score,
      endpoint: "FREE_RESOURCES",
      recommendationTitle: "Start With Free Resources",
      recommendationMessage:
        "Based on your answers, the best next step is to strengthen your foundation before paying for a service. Start with the free trainings first, then come back when you are ready to invest.",
      recommendedAction: "Watch Free Training",
      redirectUrl: "/#services",
    };
  }

  if (hasNoRealBudget(body) || hasLowTeamBudget(body) || score <= 49) {
    return {
      score,
      endpoint: "LOW_TICKET_AUDIT",
      recommendationTitle: "Start With An Ads Account Audit",
      recommendationMessage:
        "You have a real business problem, but the safest next step is diagnosis. An audit will help reveal what is broken before you spend more money on ads or strategy.",
      recommendedAction: "Book Ads Account Audit",
      redirectUrl: "/#services",
    };
  }

  if (
    score >= 70 &&
    !revenueTooLow &&
    !hasNoRealBudget(body) &&
    !isNotDecisionMaker &&
    body.urgency !== "Just researching"
  ) {
    return {
      score,
      endpoint: "STRATEGIC_GROWTH_CALL",
      recommendationTitle: "Request A Strategic Growth Call",
      recommendationMessage:
        "Your answers show a serious business, a meaningful problem, and enough readiness to justify a direct strategy conversation. The next step is to request a strategic growth call.",
      recommendedAction: "Go To Booking",
      redirectUrl: "/#services",
    };
  }

  if (
    body.desiredHelp === "TikTok/Meta Ads setup" ||
    body.desiredHelp === "Ads account audit" ||
    body.desiredHelp === "Ads management"
  ) {
    return {
      score,
      endpoint: "DIRECT_SERVICE",
      recommendationTitle: "Choose The Service That Matches Your Need",
      recommendationMessage:
        "You already have a clear idea of what you need. Go straight to the services section and select the option that matches your current problem.",
      recommendedAction: "View Recommended Services",
      redirectUrl: "/#services",
    };
  }

  return {
    score,
    endpoint: "QUALIFIED_STRATEGY",
    recommendationTitle: "Book A Paid Strategy Or Audit Session",
    recommendationMessage:
      "You are not in the free-resource bucket. The best move is to pay for a focused audit or strategy session so the real problem can be diagnosed properly.",
    recommendedAction: "View Paid Options",
    redirectUrl: "/#services",
  };
};

exports.createGrowthAssessment = async (req, res) => {
  try {
    const missingField = requiredFields.find((field) => {
      const value = req.body[field];
      return Array.isArray(value) ? value.length === 0 : !value;
    });

    if (missingField) {
      return res.status(400).json({
        message: "Please answer all required questions before submitting.",
      });
    }

    if (
      req.body.implementationReadiness === "Yes" &&
      !req.body.teamMonthlyBudget
    ) {
      return res.status(400).json({
        message: "Please select how much you can realistically pay our team.",
      });
    }

    const result = getAssessmentResult(req.body);

    const assessment = await GrowthAssessment.create({
      ...req.body,
      ...result,
    });

    res.status(201).json({
      message: "Growth assessment submitted successfully",
      assessmentId: assessment._id,
      result,
    });
  } catch (error) {
    console.log("GROWTH ASSESSMENT ERROR:", error);
    res.status(500).json({ message: "Unable to submit assessment" });
  }
};

exports.getGrowthAssessments = async (req, res) => {
  try {
    const assessments = await GrowthAssessment.find().sort({ createdAt: -1 });

    res.json(assessments);
  } catch (error) {
    console.log("GET GROWTH ASSESSMENTS ERROR:", error);
    res.status(500).json({ message: "Unable to fetch assessments" });
  }
};

exports.markGrowthAssessmentCalled = async (req, res) => {
  try {
    const assessment = await GrowthAssessment.findByIdAndUpdate(
      req.params.id,
      {
        called: true,
        calledAt: new Date(),
      },
      { new: true },
    );

    if (!assessment) {
      return res.status(404).json({ message: "Assessment not found" });
    }

    res.json(assessment);
  } catch (error) {
    console.log("MARK ASSESSMENT CALLED ERROR:", error);
    res.status(500).json({ message: "Unable to mark assessment as called" });
  }
};
