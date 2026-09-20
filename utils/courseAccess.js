const courses = [
  { title: "How to run TikTok ads", url: "https://t.me/+zpLNcLN6nAhhNDY8" },
  { title: "Facebook & Instagram Ads", url: "https://t.me/+RwLlZhhBUXk2ZDk0" },
];

const isCourse = (invoice) => invoice.product === "ads-course" ||
  (invoice.note || "").startsWith("Course purchase - WhatsApp:");
const isPaidCourse = (invoice) =>
  invoice.status === "paid" && invoice.product !== "whatsapp-course" && invoice.amount === 8000 && isCourse(invoice);

module.exports = { courses, isPaidCourse, isCourse };
