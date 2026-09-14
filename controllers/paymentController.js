const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const Booking = require("../models/Booking");
exports.initializePayment = async (req, res) => {
  try {
    const { name, email, phone, service } = req.body;

    const token = uuidv4();
    const paymentReference = `booking-${uuidv4()}`;
    const price = Number(service.calculatedPrice || service.price);
    if (!Number.isFinite(price) || price <= 0) return res.status(400).json({ message: "Invalid booking amount." });

    const booking = await Booking.create({
      name,
      email,
      phone,

      serviceId: service.id,
      serviceTitle: service.title,
      price,
      paymentReference,

      // 🔥 ADD THESE
      duration: service.duration,
      packageSelected: service.packageSelected || service.duration,
      adBudget: service.adBudget,
      serviceFee: service.serviceFee,

      bookingToken: token,
      paid: false,
    });

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",

      {
        email: email,

        amount: Math.round(price * 100),
        reference: paymentReference,

        callback_url: `${process.env.CLIENT_URL}/pickadate?token=${token}`,

        metadata: {
          bookingId: booking._id,
        },
      },

      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`,
          "Content-Type": "application/json",
        },
      },
    );

    res.json({
      paymentUrl: response.data.data.authorization_url,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: "Payment initialization failed" });
  }
};
