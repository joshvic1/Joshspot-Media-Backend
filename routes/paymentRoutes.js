const express = require("express");

const router = express.Router();

const { initializePayment } = require("../controllers/paymentController");

router.post("/initialize", initializePayment);
router.post("/webhook", require("../controllers/paymentWebhookController").paystackWebhook);

module.exports = router;
