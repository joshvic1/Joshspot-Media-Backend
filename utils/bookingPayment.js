const axios = require("axios");
const matchesBookingPayment = (booking, transaction) => transaction?.status === "success" &&
  transaction.currency === "NGN" && transaction.amount === Math.round(Number(booking.price) * 100) &&
  transaction.reference === booking.paymentReference;
async function refreshBookingPayment(booking, callbackReference) {
  if (booking.paid && booking.paymentVerifiedAt) return booking;
  const reference = booking.paymentReference || callbackReference;
  if (!reference || !/^[a-zA-Z0-9_.=-]{1,150}$/.test(reference)) return booking;
  const response = await axios.get(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET}` }, timeout: 10000,
  });
  const transaction = response.data.data;
  booking.paymentCheckedAt = new Date();
  if (!booking.paymentReference) {
    let metadata = transaction?.metadata;
    if (typeof metadata === "string") { try { metadata = JSON.parse(metadata); } catch { metadata = {}; } }
    if (String(metadata?.bookingId || "") !== String(booking._id)) return booking;
    booking.paymentReference = reference;
  }
  if (matchesBookingPayment(booking, transaction)) {
    booking.paid = true;
    booking.paidAt = transaction.paid_at || transaction.paidAt || new Date();
    booking.paymentVerifiedAt = new Date();
  }
  await booking.save();
  return booking;
}
module.exports = { refreshBookingPayment, matchesBookingPayment };
