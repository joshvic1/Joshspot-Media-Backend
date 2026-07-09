const express = require("express");
const router = express.Router();
const staffAuth = require("../middleware/staffAuth");
const {
  createClient,
  crmLogin,
  getClients,
  updateClient,
} = require("../controllers/crmController");

router.post("/login", crmLogin);
router.get("/clients", staffAuth, getClients);
router.post("/clients", staffAuth, createClient);
router.put("/clients/:id", staffAuth, updateClient);

module.exports = router;
