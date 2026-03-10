const Booking = require("../models/Booking");
const sendBookingEmail = require("../utils/sendBookingEmail");

// Initialize payment and create booking
exports.verifyBooking = async (req, res) => {
  try {
    const token = req.params.token;

    const booking = await Booking.findOne({ bookingToken: token });

    if (!booking) {
      return res.status(404).json({ message: "Invalid booking" });
    }

    res.json(booking);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.getBookedSlots = async (req, res) => {
  try {
    const date = new Date(req.params.date).toISOString().split("T")[0];

    const bookings = await Booking.find({ date });

    const times = bookings.map((b) => b.time);

    res.json(times);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.completeBooking = async (req, res) => {
  try {
    const { token, date, time, notes } = req.body;

    const normalizedDate = new Date(date).toISOString().split("T")[0];

    const booking = await Booking.findOne({ bookingToken: token });

    if (!booking) {
      return res.status(404).json({ message: "Invalid booking" });
    }

    const today = new Date();

    const slotDate = new Date(normalizedDate);

    let hour = parseInt(time);

    if (time.includes("pm") && hour !== 12) {
      hour += 12;
    }

    if (time.includes("am") && hour === 12) {
      hour = 0;
    }

    slotDate.setHours(hour);

    const diffHours = (slotDate - today) / (1000 * 60 * 60);

    if (diffHours < 24) {
      return res.status(400).json({
        message: "Bookings must be at least 24 hours in advance",
      });
    }

    const existing = await Booking.findOne({
      date: normalizedDate,
      time: time,
    });

    if (existing) {
      return res.status(400).json({
        message: "This slot is already booked",
      });
    }

    booking.date = normalizedDate;
    booking.time = time;
    booking.notes = notes;
    booking.paid = true;

    await booking.save();

    await sendBookingEmail(booking);

    res.json({ message: "Booking completed" });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.getAllBookings = async (req, res) => {
  try {
    const bookings = await Booking.find().sort({ createdAt: -1 });

    res.json(bookings);
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};
exports.cancelBooking = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    booking.status = "cancelled";

    await booking.save();

    res.json({ message: "Booking cancelled" });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.completeBookingAdmin = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    booking.status = "completed";

    await booking.save();

    res.json({ message: "Booking marked as completed" });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};
