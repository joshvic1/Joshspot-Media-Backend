const express = require("express");
const router = express.Router();
const staffAuth = require("../middleware/staffAuth");
const {
  createClient,
  crmLogin,
  getClients,
  updateClient,
} = require("../controllers/crmController");
const {
  createAdsClient,
  getAdsClients,
  updateAdsClient,
} = require("../controllers/adsController");
const {
  createVerificationClient,
  downloadVerificationIdCard,
  getVerificationClients,
  updateVerificationClient,
} = require("../controllers/verificationController");

router.post("/login", crmLogin);
router.get("/clients", staffAuth, getClients);
router.post("/clients", staffAuth, createClient);
router.put("/clients/:id", staffAuth, updateClient);
router.get("/ads-clients", staffAuth, getAdsClients);
router.post("/ads-clients", staffAuth, createAdsClient);
router.put("/ads-clients/:id", staffAuth, updateAdsClient);
router.get("/verification-clients", staffAuth, getVerificationClients);
router.post("/verification-clients", staffAuth, createVerificationClient);
router.put("/verification-clients/:id", staffAuth, updateVerificationClient);
router.get(
  "/verification-clients/:id/id-card",
  staffAuth,
  downloadVerificationIdCard,
);

module.exports = router;
