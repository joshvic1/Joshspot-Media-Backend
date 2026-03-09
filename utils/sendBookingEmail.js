const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

const sendBookingEmail = async (booking) => {
  try {
    await resend.emails.send({
      from: "Joshspot Media <booking@joshspotmedia.com>",

      to: booking.email,

      subject: "Your Booking is Confirmed",

      html: `

<h2>Booking Confirmed</h2>

<p>Hello ${booking.name},</p>

<p>Your booking with Joshspot Media has been confirmed.</p>

<hr/>

<h3>Booking Details</h3>

<p><b>Date:</b> ${booking.date}</p>
<p><b>Time:</b> ${booking.time}</p>
<p><b>WhatsApp:</b> ${booking.phone}</p>
<p><b>Notes:</b> ${booking.notes || "None"}</p>

<hr/>

<p>Our team will contact you shortly.</p>

<p>Joshspot Media</p>

`,
    });
  } catch (err) {
    console.log("Email error:", err);
  }
};

module.exports = sendBookingEmail;
