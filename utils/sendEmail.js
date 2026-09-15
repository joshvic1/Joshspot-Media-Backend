const { Resend } = require("resend");

const sendBookingEmail = async (booking) => {
  if (!booking.paid || !booking.paymentVerifiedAt) throw new Error("Payment is not verified");
  if (!process.env.RESEND_API_KEY) throw new Error("Resend is not configured");
  const resend = new Resend(process.env.RESEND_API_KEY);
  const link = `${process.env.CLIENT_URL}/pickadate?token=${booking.bookingToken}`;

  const { data, error } = await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL || "Joshspot Media <booking@joshspotmedia.com>",

    to: booking.email,

    subject: "Your Joshspot Media Booking",

    text: `Payment Successful\n\nYou paid for: ${booking.serviceTitle}\nAmount: ₦${booking.price}\n\nContinue your booking: ${link}`,
  }, { idempotencyKey: `booking-payment/${booking._id}` });
  if (error) throw new Error("Resend rejected the payment email");
  return data;
};

module.exports = sendBookingEmail;
