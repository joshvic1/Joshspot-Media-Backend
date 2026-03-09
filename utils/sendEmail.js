const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

const sendBookingEmail = async (booking) => {
  const link = `${process.env.CLIENT_URL}/pickadate?token=${booking.bookingToken}`;

  await resend.emails.send({
    from: "Joshspot Media <booking@joshspot.com>",

    to: booking.email,

    subject: "Your Joshspot Media Booking",

    html: `
<h2>Payment Successful</h2>

<p>You paid for:</p>

<b>${booking.serviceTitle}</b>

<p>Amount:</p>

<b>₦${booking.price}</b>

<p>Continue your booking below:</p>

<a href="${link}">
Continue Booking
</a>

`,
  });
};

module.exports = sendBookingEmail;
