const { Resend } = require("resend");

const sendBookingEmail = async (booking) => {
    if (!process.env.RESEND_API_KEY) throw new Error("Resend is not configured");
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { data, error } = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || "Joshspot Media <booking@joshspotmedia.com>",

      to: booking.email,

      subject: "Your Booking is Confirmed",

      text: `Booking Confirmed\n\nHello ${booking.name},\n\nYour booking with Joshspot Media has been confirmed.\n\nService: ${booking.serviceTitle}\nDate: ${booking.date}\nTime: ${booking.time}\nWhatsApp: ${booking.phone}\nNotes: ${booking.notes || "None"}\n\nOur team will contact you shortly.\n\nJoshspot Media`,
    }, { idempotencyKey: `booking-confirmation/${booking._id}/${booking.date}/${booking.time}` });
    if (error) throw new Error("Resend rejected the booking confirmation");
    return data;
};

module.exports = sendBookingEmail;
