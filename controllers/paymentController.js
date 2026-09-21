const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const Booking = require("../models/Booking");
const { resolveService } = require("../utils/serviceCatalog");
exports.initializePayment = async (req, res) => {
  try {
    const { name, email, phone, service } = req.body;
    let selected;
    try { selected = resolveService(service); } catch (error) { return res.status(400).json({ message: error.message }); }
    if (!String(name || "").trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "")) || !String(phone || "").trim()) {
      return res.status(400).json({ message: "Please enter your name, email and WhatsApp number." });
    }

    const token = uuidv4();
    const paymentReference = `booking-${uuidv4()}`;
    const price = selected.price;
    if (!Number.isFinite(price) || price <= 0) return res.status(400).json({ message: "Invalid booking amount." });

    const booking = await Booking.create({
      name,
      email,
      phone,

      serviceId: selected.id,
      serviceTitle: selected.title,
      price,
      paymentReference,

      // 🔥 ADD THESE
      duration: selected.duration,
      packageSelected: selected.packageSelected,
      adBudget: service.adBudget,
      serviceFee: price,

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
