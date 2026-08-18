const express = require("express");
const router = express.Router();
const adminAuth = require("../middleware/adminAuth");
const {
  createInvoice,
  getInvoice,
  listInvoices,
  startInvoiceTransfer,
} = require("../controllers/invoiceController");

router.post("/", adminAuth, createInvoice);
router.get("/", adminAuth, listInvoices);
router.get("/:token", getInvoice);
router.post("/:token/transfer", startInvoiceTransfer);

module.exports = router;
