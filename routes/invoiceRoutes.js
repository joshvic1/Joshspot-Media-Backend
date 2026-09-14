const express = require("express");
const router = express.Router();
const adminAuth = require("../middleware/adminAuth");
const {
  createInvoice,
  getInvoice,
  listInvoices,
  startInvoiceTransfer,
  emailCourseAccess,
} = require("../controllers/invoiceController");

router.post("/", createInvoice);
router.get("/", adminAuth, listInvoices);
router.get("/:token", getInvoice);
router.post("/:token/transfer", startInvoiceTransfer);
router.post("/:token/course-email", emailCourseAccess);

module.exports = router;
