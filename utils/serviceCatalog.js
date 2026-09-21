// Authoritative prices for new bookings. Historical bookings retain their stored totals.
const services = {
  1: { title: "Book Consultation", options: { "30 mins": 30000, "1 hr": 50000, "2 hrs": 80000 } },
  2: { title: "Ads Account Audit", options: { Meta: 20000, TikTok: 20000 } },
  3: { title: "TikTok/Meta Ads Account Setup", options: { "TikTok only": 20000, "Meta only": 30000, "TikTok and Meta": 50000 } },
  4: { title: "Ads Training (1 on 1)", options: { "TikTok (1 on 1)": 100000, "Meta (1 on 1)": 100000, "TikTok and Meta": 150000 } },
  9: { title: "Promo Video with Josh", price: 100000, duration: "1 minute" },
};
function resolveService(input) {
  const id = Number(input?.id);
  const service = services[id];
  if (!service) throw new Error("Please choose an available service.");
  const selected = String(input.packageSelected || input.duration || "");
  if (service.options && !Object.hasOwn(service.options, selected)) throw new Error("Please choose a valid package or platform.");
  return { id, title: service.title + (service.options ? " - " + selected : ""),
    price: service.options ? service.options[selected] : service.price,
    packageSelected: service.options ? selected : "One-minute promo video",
    duration: service.duration || selected };
}
module.exports = { services, resolveService };
