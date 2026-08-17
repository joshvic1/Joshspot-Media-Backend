const express = require("express");
const router = express.Router();
const adminAuth = require("../middleware/adminAuth");
const {
  createGrowthAssessment,
  getGrowthAssessments,
  markGrowthAssessmentCalled,
} = require("../controllers/growthAssessmentController");

router.post("/", createGrowthAssessment);
router.get("/", adminAuth, getGrowthAssessments);
router.put("/:id/called", adminAuth, markGrowthAssessmentCalled);

module.exports = router;
