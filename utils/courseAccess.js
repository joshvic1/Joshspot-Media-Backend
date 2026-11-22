const isCourse = (invoice) => ["ads-course", "whatsapp-course"].includes(invoice.product) ||
  (invoice.note || "").startsWith("Course purchase - WhatsApp:");
const isFullyRefunded = (invoice) => Number(invoice?.amount || 0) > 0 &&
  Number(invoice?.refundedAmount || 0) >= Number(invoice.amount || 0);
const isPaidCourse = (invoice) =>
  !isFullyRefunded(invoice) && invoice.status === "paid" && invoice.product !== "whatsapp-course" && invoice.amount === 8000 && isCourse(invoice);

module.exports = { isPaidCourse, isCourse, isFullyRefunded };
