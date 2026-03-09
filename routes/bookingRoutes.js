const express = require("express");
const router = express.Router();
const adminAuth = require("../middleware/adminAuth");
const {
  verifyBooking,
  getBookedSlots,
  completeBooking,
  getAllBookings,
  cancelBooking,
  completeBookingAdmin,
} = require("../controllers/bookingController");

router.get("/verify/:token", verifyBooking);

router.get("/slots/:date", getBookedSlots);

router.post("/complete", completeBooking);

router.get("/all", adminAuth, getAllBookings);

router.put("/cancel/:id", adminAuth, cancelBooking);

router.put("/complete/:id", adminAuth, completeBookingAdmin);

module.exports = router;
