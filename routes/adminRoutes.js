const express = require("express");
const router = express.Router();

const { adminLogin } = require("../controllers/adminController");

router.post("/login", adminLogin);
const adminAuth = require("../middleware/adminAuth");
const { listCoursePayments, checkCoursePayment, remindCoursePayment } = require("../controllers/courseAdminController");
router.get("/course-payments", adminAuth, listCoursePayments);
router.get("/source-analytics", adminAuth, require("../controllers/courseAdminController").sourceAnalytics);
router.post("/course-payments/:id/check", adminAuth, checkCoursePayment);
router.post("/course-payments/:id/remind", adminAuth, remindCoursePayment);
router.post("/course-payments/:id/resend", adminAuth, require("../controllers/courseAdminController").resendCourseEmail);
const reports = require("../controllers/adminReportsController");
router.get("/overview", adminAuth, reports.overview);
router.get("/paid-invoices", adminAuth, reports.paidInvoices);
router.patch("/paid-invoices/:id/contact", adminAuth, require("../controllers/invoiceContactController").update);
router.post("/paid-invoices/:id/receipt", adminAuth, require("../controllers/receiptController").sendReceipt);
router.post("/sync-payments", adminAuth, reports.syncPayments);
router.delete("/records/:kind/:id", adminAuth, reports.deleteRecord);
router.post("/records/:kind/:id/restore", adminAuth, reports.deleteRecord);

router.get("/general-settings", adminAuth, require("../utils/generalSettings").get);
router.put("/general-settings", adminAuth, require("../utils/generalSettings").save);

const telegramCourseAdmin = require("../controllers/telegramCourseAdminController");
router.get("/telegram-access", adminAuth, telegramCourseAdmin.status);
router.post("/telegram-access/setup", adminAuth, telegramCourseAdmin.setupWebhook);
router.post("/telegram-access/channels", adminAuth, telegramCourseAdmin.saveChannel);
router.patch("/telegram-access/channels/:id", adminAuth, telegramCourseAdmin.updateChannel);
router.delete("/telegram-access/channels/:id", adminAuth, telegramCourseAdmin.deactivateChannel);
router.post("/telegram-access/:id/revoke", adminAuth, telegramCourseAdmin.revoke);
router.post("/telegram-access/:id/restore", adminAuth, telegramCourseAdmin.restore);
module.exports = router;
