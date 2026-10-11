const express = require("express");
const router = express.Router();
const permit = require("../inbox/staffPermissions").crm;
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
router.get("/session", staffAuth, (req, res) => res.json({ staff: req.staff }));
const deleteClient = require("../controllers/crmDeletionController");
router.delete("/:kind/:id", staffAuth, deleteClient);
router.get("/clients", staffAuth, getClients);
router.post("/clients", staffAuth, permit("setup.create"), createClient);
router.put("/clients/:id", staffAuth, permit("setup.edit"), updateClient);
router.get("/ads-clients", staffAuth, getAdsClients);
router.post("/ads-clients", staffAuth, permit("ads.create"), createAdsClient);
router.put("/ads-clients/:id", staffAuth, permit("ads.edit"), updateAdsClient);
router.get("/verification-clients", staffAuth, getVerificationClients);
router.post("/verification-clients", staffAuth, permit("verification.create"), createVerificationClient);
router.put("/verification-clients/:id", staffAuth, permit("verification.edit"), updateVerificationClient);
router.get(
  "/verification-clients/:id/id-card",
  staffAuth,
  downloadVerificationIdCard,
);

module.exports = router;
