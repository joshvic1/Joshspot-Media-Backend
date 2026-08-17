const express = require("express");
const router = express.Router();
const {
  createGrowthAssessment,
} = require("../controllers/growthAssessmentController");

router.post("/", createGrowthAssessment);

module.exports = router;
