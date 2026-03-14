const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema({
  name: String,

  email: String,

  phone: String,

  serviceId: Number,

  serviceTitle: String,

  price: Number,

  // 🔥 ADD THESE
  duration: String,

  adBudget: Number,

  serviceFee: Number,

  status: {
    type: String,
    default: "confirmed",
  },

  paymentReference: String,

  bookingToken: String,

  paid: {
    type: Boolean,
    default: false,
  },

  date: String,

  time: String,

  notes: String,

  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model("Booking", bookingSchema);
