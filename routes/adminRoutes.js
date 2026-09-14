const express = require("express");
const router = express.Router();

const { adminLogin } = require("../controllers/adminController");

router.post("/login", adminLogin);
const adminAuth = require("../middleware/adminAuth");
const { listCoursePayments, checkCoursePayment, remindCoursePayment } = require("../controllers/courseAdminController");
router.get("/course-payments", adminAuth, listCoursePayments);
router.post("/course-payments/:id/check", adminAuth, checkCoursePayment);
router.post("/course-payments/:id/remind", adminAuth, remindCoursePayment);

module.exports = router;
