const crypto = require("node:crypto");
const Invoice = require("../models/Invoice");
const Booking = require("../models/Booking");
const { matchesBookingPayment } = require("../utils/bookingPayment");
const { queueCourseEmail } = require("../utils/deliverCourseEmail");

exports.paystackWebhook = async (req, res) => {
  if (!process.env.PAYSTACK_SECRET || !req.rawBody) return res.sendStatus(400);
  const expected = crypto.createHmac("sha512", process.env.PAYSTACK_SECRET).update(req.rawBody).digest("hex");
  const signature = req.headers["x-paystack-signature"] || "";
  if (!/^[a-f0-9]{128}$/i.test(signature) || !crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"))) return res.sendStatus(401);
  try {
    const transaction = req.body.data;
    if (req.body.event === "charge.success" && transaction?.status === "success" && transaction.currency === "NGN") {
      const invoice = await Invoice.findOne({ reference: transaction.reference });
      if (invoice && transaction.amount === invoice.amount * 100) {
        await Invoice.updateOne({ _id: invoice._id }, { $set: { status: "paid", paystackStatus: "success",
          paidAt: transaction.paid_at || new Date(), paymentCheckedAt: new Date() } });
        invoice.status = "paid";
        await queueCourseEmail(invoice);
      }
      const booking = await Booking.findOne({ paymentReference: transaction.reference });
      if (booking && matchesBookingPayment(booking, transaction)) {
        await Booking.updateOne({ _id: booking._id }, { $set: {
          paid: true, paidAt: transaction.paid_at || new Date(), paymentVerifiedAt: new Date(),
        } });
      }
    }
    return res.sendStatus(200);
  } catch { return res.sendStatus(500); }
};
