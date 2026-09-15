const Booking = require("../models/Booking");
const Invoice = require("../models/Invoice");
const GrowthAssessment = require("../models/GrowthAssessment");
const { isCourse } = require("../utils/courseAccess");
const { refreshBookingPayment } = require("../utils/bookingPayment");
const { refreshInvoiceStatus } = require("./invoiceController");
const active = { deletedAt: null };
const invoiceService = (row) => isCourse(row) ? "Ads course" :
  (row.note || "").startsWith("Video script purchase") ? "Video script" : "Other invoices";
const invoiceRecord = (row) => ({ id: String(row._id), kind: "invoices", name: row.customerName || "",
  email: row.customerEmail || "", phone: row.customerPhone || (row.note || "").split("WhatsApp:")[1]?.trim() || "",
  amount: Number(row.amount || 0), paidAt: row.paidAt || null, createdAt: row.createdAt,
  service: invoiceService(row), reference: row.reference || "", note: row.note || "", source: "invoices" });
const bookingRecord = (row) => ({ id: String(row._id), kind: "bookings", name: row.name || "",
  email: row.email || "", phone: row.phone || "", amount: Number(row.price || 0), paidAt: row.paidAt || null,
  createdAt: row.createdAt, service: row.serviceTitle || "Other services", reference: row.paymentReference || "", source: "bookings" });

function filters(query) {
  const from = query.from ? new Date(`${query.from}T00:00:00+01:00`) : null;
  const to = query.to ? new Date(`${query.to}T23:59:59.999+01:00`) : null;
  for (const key of ["from", "to"]) if (query[key] && !/^\d{4}-\d{2}-\d{2}$/.test(query[key])) throw new Error("Invalid date filter.");
  if ((from && isNaN(from)) || (to && isNaN(to)) || (from && to && from > to)) throw new Error("Choose a valid date range.");
  const min = query.min ? Number(query.min) : 0, max = query.max ? Number(query.max) : Infinity;
  if (!Number.isFinite(min) || min < 0 || (query.max && !Number.isFinite(max)) || max < min) throw new Error("Choose a valid amount range.");
  const dateMatches = (date) => (!from && !to) || (date && (!from || new Date(date) >= from) && (!to || new Date(date) <= to));
  const serviceMatches = (record) => (!query.source || query.source === "all" || query.source === record.source) &&
    (!query.service || query.service === "all" || query.service === record.service);
  const search = String(query.search || "").trim().toLowerCase();
  return { dateMatches, serviceMatches, matches: (record) => dateMatches(record.paidAt) && serviceMatches(record) &&
    record.amount >= min && record.amount <= max && (!search || [record.name, record.email, record.phone, record.reference, record.note].some((value) => String(value || "").toLowerCase().includes(search))) };
}
function paginate(records, query) {
  const size = [10, 20, 50].includes(Number(query.pageSize)) ? Number(query.pageSize) : 20;
  const pages = Math.max(1, Math.ceil(records.length / size));
  const page = Math.min(pages, Math.max(1, parseInt(query.page, 10) || 1));
  return { records: records.slice((page - 1) * size, page * size), total: records.length, page, pages, pageSize: size };
}
exports.paidInvoices = async (req, res) => {
  let filter; try { filter = filters(req.query); } catch (error) { return res.status(400).json({ message: error.message }); }
  try {
    const all = (await Invoice.find({ ...active, status: "paid" }).sort({ paidAt: -1, _id: -1 }).lean()).map(invoiceRecord);
    const rows = all.filter(filter.matches);
    res.setHeader("Cache-Control", "no-store");
    return res.json({ ...paginate(rows, req.query), revenue: rows.reduce((sum, row) => sum + row.amount, 0),
      services: [...new Set(all.map((row) => row.service))].sort(), unknownDates: rows.filter((row) => !row.paidAt).length });
  } catch { return res.status(500).json({ message: "Unable to load paid invoices." }); }
};
exports.overview = async (req, res) => {
  let filter; try { filter = filters(req.query); } catch (error) { return res.status(400).json({ message: error.message }); }
  try {
    const [bookings, invoices, leads] = await Promise.all([
      Booking.find(active).lean(), Invoice.find({ ...active, status: "paid" }).lean(), GrowthAssessment.find(active).lean(),
    ]);
    const confirmedBookings = bookings.filter((row) => row.paid && row.paymentVerifiedAt).map(bookingRecord);
    const bookingRefs = new Set(confirmedBookings.map((row) => row.reference).filter(Boolean));
    const all = [...confirmedBookings, ...invoices.filter((row) => !row.reference || !bookingRefs.has(row.reference)).map(invoiceRecord)];
    const rows = all.filter(filter.matches).sort((a, b) => new Date(b.paidAt || 0) - new Date(a.paidAt || 0));
    const services = {};
    for (const row of rows) {
      services[row.service] ||= { service: row.service, count: 0, revenue: 0 };
      services[row.service].count++; services[row.service].revenue += row.amount;
    }
    const bookingRows = bookings.filter((row) => filter.dateMatches(row.createdAt) && filter.serviceMatches(bookingRecord(row)));
    const leadRows = leads.filter((row) => filter.dateMatches(row.createdAt));
    const revenue = rows.reduce((sum, row) => sum + row.amount, 0);
    res.setHeader("Cache-Control", "no-store");
    return res.json({ revenue, payments: rows.length, bookingRevenue: rows.filter((row) => row.source === "bookings").reduce((sum, row) => sum + row.amount, 0),
      invoiceRevenue: rows.filter((row) => row.source === "invoices").reduce((sum, row) => sum + row.amount, 0),
      courseRevenue: rows.filter((row) => row.service === "Ads course").reduce((sum, row) => sum + row.amount, 0),
      bookings: bookingRows.length, completed: bookingRows.filter((row) => row.status === "completed").length,
      leads: leadRows.length, highPriority: leadRows.filter((row) => row.score >= 70 || row.endpoint === "STRATEGIC_GROWTH_CALL").length,
      unverifiedBookings: bookings.filter((row) => row.paid && !row.paymentVerifiedAt).length,
      unknownDates: all.filter((row) => !row.paidAt).length,
      breakdown: Object.values(services).sort((a, b) => b.revenue - a.revenue),
      services: [...new Set([...all.map((row) => row.service), ...bookings.map((row) => row.serviceTitle).filter(Boolean)])].sort(),
      recent: paginate(rows, req.query),
    });
  } catch { return res.status(500).json({ message: "Unable to load overview totals." }); }
};
exports.deleteRecord = async (req, res) => {
  const model = { bookings: Booking, leads: GrowthAssessment, invoices: Invoice }[req.params.kind];
  if (!model || !/^[a-f\d]{24}$/i.test(req.params.id)) return res.status(400).json({ message: "Invalid record." });
  try {
    const update = req.method === "DELETE" ? { $set: { deletedAt: new Date() } } : { $unset: { deletedAt: 1 } };
    const record = await model.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!record) return res.status(404).json({ message: "Record not found." });
    return res.json({ message: req.method === "DELETE" ? "Record deleted from CRM views. You can undo this." : "Record restored." });
  } catch { return res.status(500).json({ message: "Unable to update this record." }); }
};
exports.syncPayments = async (req, res) => {
  try {
    const [bookings, invoices] = await Promise.all([
      Booking.find({ ...active, paymentReference: { $exists: true, $ne: "" }, paymentVerifiedAt: null }).sort({ paymentCheckedAt: 1 }).limit(10),
      Invoice.find({ ...active, status: { $ne: "paid" }, reference: { $exists: true, $ne: "" } }).sort({ paymentCheckedAt: 1 }).limit(10),
    ]);
    let failed = 0, confirmed = 0;
    const tasks = [...bookings.map((row) => async () => { await refreshBookingPayment(row); if (row.paymentVerifiedAt) confirmed++; }),
      ...invoices.map((row) => async () => { await refreshInvoiceStatus(row, true); if (row.status === "paid") confirmed++; })];
    for (let i = 0; i < tasks.length; i += 5) {
      const results = await Promise.allSettled(tasks.slice(i, i + 5).map((task) => task()));
      failed += results.filter((result) => result.status === "rejected").length;
    }
    return res.json({ message: `Checked ${tasks.length} payment records; ${confirmed} confirmed, ${failed} could not be checked.`, checked: tasks.length, failed });
  } catch { return res.status(502).json({ message: "Unable to sync Paystack payments." }); }
};
exports.filters = filters;
exports.paginate = paginate;
