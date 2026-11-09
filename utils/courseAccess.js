const isCourse = (invoice) => ["ads-course", "whatsapp-course"].includes(invoice.product) ||
  (invoice.note || "").startsWith("Course purchase - WhatsApp:");
const isPaidCourse = (invoice) =>
  invoice.status === "paid" && invoice.product !== "whatsapp-course" && invoice.amount === 8000 && isCourse(invoice);

module.exports = { isPaidCourse, isCourse };
