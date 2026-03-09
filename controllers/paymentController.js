const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const Booking = require("../models/Booking");
const sendBookingEmail = require("../utils/sendEmail");
exports.initializePayment = async (req, res) => {
  try {
    const { name, email, phone, service } = req.body;

    const token = uuidv4();

    const booking = await Booking.create({
      name,
      email,
      phone,

      serviceId: service.id,
      serviceTitle: service.title,
      price: service.calculatedPrice,

      bookingToken: token,
      paid: false,
    });

    await sendBookingEmail(booking);

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",

      {
        email: email,

        amount: (service.calculatedPrice || service.price) * 100,

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
