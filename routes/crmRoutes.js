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
  createVerificationClient,
  getVerificationClients,
  updateVerificationClient,
} = require("../controllers/verificationController");

router.post("/login", crmLogin);
router.get("/clients", staffAuth, getClients);
router.post("/clients", staffAuth, createClient);
router.put("/clients/:id", staffAuth, updateClient);
router.get("/verification-clients", staffAuth, getVerificationClients);
router.post("/verification-clients", staffAuth, createVerificationClient);
router.put("/verification-clients/:id", staffAuth, updateVerificationClient);

module.exports = router;
