const express = require("express");
const router = express.Router();

const { adminLogin } = require("../controllers/adminController");

router.post("/login", adminLogin);
const adminAuth = require("../middleware/adminAuth");
const { listCoursePayments, checkCoursePayment, remindCoursePayment } = require("../controllers/courseAdminController");
router.get("/course-payments", adminAuth, listCoursePayments);
router.post("/course-payments/:id/check", adminAuth, checkCoursePayment);
router.post("/course-payments/:id/remind", adminAuth, remindCoursePayment);
router.post("/course-payments/:id/resend", adminAuth, require("../controllers/courseAdminController").resendCourseEmail);
const reports = require("../controllers/adminReportsController");
router.get("/overview", adminAuth, reports.overview);
router.get("/paid-invoices", adminAuth, reports.paidInvoices);
router.post("/sync-payments", adminAuth, reports.syncPayments);
router.delete("/records/:kind/:id", adminAuth, reports.deleteRecord);
router.post("/records/:kind/:id/restore", adminAuth, reports.deleteRecord);

module.exports = router;
