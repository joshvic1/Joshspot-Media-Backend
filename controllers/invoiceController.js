const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const Invoice = require("../models/Invoice");
const { Resend } = require("resend");
const { courses, isPaidCourse } = require("../utils/courseAccess");

const PAYSTACK_BASE_URL = "https://api.paystack.co";
const INVOICE_LIFETIME_HOURS = 8;
const sanitizeAttribution = require("../utils/courseAttribution");

const paystackHeaders = () => ({
  Authorization: `Bearer ${process.env.PAYSTACK_SECRET}`,
  "Content-Type": "application/json",
});

const getPublicInvoice = (invoice) => ({
  token: invoice.token,
  amount: invoice.amount,
  customerName: invoice.customerName,
  note: invoice.note,
  status: invoice.status,
  accountName: invoice.accountName,
  accountNumber: invoice.accountNumber,
  bankName: invoice.bankName,
  expiresAt: invoice.expiresAt,
  paidAt: invoice.paidAt,
  createdAt: invoice.createdAt,
  ...(isPaidCourse(invoice) ? { courses } : {}),
});

const refreshInvoiceStatus = async (invoice, strict = false) => {
  if (invoice.status === "paid") return invoice;

  if (!invoice.reference && invoice.expiresAt && new Date(invoice.expiresAt) < new Date()) {
    invoice.status = "expired";
    await invoice.save();
    return invoice;
  }

  if (!invoice.reference) return invoice;

  try {
    const response = await axios.get(
      `${PAYSTACK_BASE_URL}/transaction/verify/${invoice.reference}`,
      { headers: paystackHeaders(), timeout: 10000 },
    );

    const transaction = response.data.data;
    invoice.paystackStatus = transaction.status;
    invoice.paymentCheckedAt = new Date();

    if (transaction.status === "success" &&
        transaction.amount === invoice.amount * 100 &&
        transaction.currency === "NGN") {
      invoice.status = "paid";
      invoice.paidAt = transaction.paid_at || new Date();
    } else if (transaction.status === "failed" || transaction.status === "abandoned") {
      invoice.status = "failed";
    } else if (invoice.expiresAt && new Date(invoice.expiresAt) < new Date()) {
      invoice.status = "expired";
    }

    await invoice.save();
  } catch (error) {
    if (strict) throw error;
    console.log("PAYSTACK VERIFY ERROR:", error.response?.data || error.message);
  }

  return invoice;
};

const generateInvoiceTransfer = async (invoice) => {
  const refreshedInvoice = await refreshInvoiceStatus(invoice);

  if (refreshedInvoice.status === "paid" || refreshedInvoice.status === "expired") {
    return refreshedInvoice;
  }

  if (refreshedInvoice.accountNumber && refreshedInvoice.status === "pending") {
    return refreshedInvoice;
  }

  const reference = `invoice-${Date.now()}-${uuidv4().slice(0, 8)}`;
  const expiresAt = new Date(
    Date.now() + INVOICE_LIFETIME_HOURS * 60 * 60 * 1000,
  );
  const email =
    refreshedInvoice.customerEmail ||
    `invoice-${refreshedInvoice.token}@joshspotmedia.com`;

  // Preserve the reference if Paystack accepts the charge but the response is lost.
  refreshedInvoice.reference = reference;
  await refreshedInvoice.save();

  const response = await axios.post(
    `${PAYSTACK_BASE_URL}/charge`,
    {
      email,
      amount: refreshedInvoice.amount * 100,
      reference,
      bank_transfer: {
        account_expires_at: expiresAt.toISOString(),
      },
      metadata: {
        invoiceId: refreshedInvoice._id,
        invoiceToken: refreshedInvoice.token,
        customerName: refreshedInvoice.customerName,
        note: refreshedInvoice.note,
      },
    },
    { headers: paystackHeaders() },
  );

  const charge = response.data.data;

  refreshedInvoice.reference = charge.reference || reference;
  refreshedInvoice.status = "pending";
  refreshedInvoice.paystackStatus = charge.status;
  refreshedInvoice.accountName = charge.account_name;
  refreshedInvoice.accountNumber = charge.account_number;
  refreshedInvoice.bankName = charge.bank?.name;
  refreshedInvoice.expiresAt = charge.account_expires_at || expiresAt;

  await refreshedInvoice.save();

  return refreshedInvoice;
};

exports.createInvoice = async (req, res) => {
  let invoice;
  try {
    const coursePurchase = req.body.product === "ads-course" || String(req.body.note || "").startsWith("Course purchase - WhatsApp:");
    const amount = coursePurchase ? 8000 : Number(req.body.amount);
    const customerEmail = String(req.body.customerEmail || "").trim().toLowerCase();
    const customerName = String(req.body.customerName || "").trim();
    const customerPhone = String(req.body.customerPhone || "").trim();
    if (customerEmail && (customerEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail))) {
      return res.status(400).json({ message: "Please enter a valid email address." });
    }
    if (coursePurchase && (!customerName || customerName.length > 150 || !/^\+?\d{7,15}$/.test(customerPhone || String(req.body.note).split("WhatsApp:")[1]?.trim() || ""))) {
      return res.status(400).json({ message: "Please enter your name and a valid WhatsApp number." });
    }

    if (!amount || amount < 100) {
      return res.status(400).json({ message: "Please enter a valid amount." });
    }

    invoice = await Invoice.create({
      token: uuidv4(),
      amount,
      customerName,
      customerEmail,
      customerPhone,
      product: coursePurchase ? "ads-course" : "",
      ...(coursePurchase ? { attribution: sanitizeAttribution(req.body.attribution) } : {}),
      note: req.body.note || "",
      expiresAt: new Date(Date.now() + INVOICE_LIFETIME_HOURS * 60 * 60 * 1000),
    });

    const invoiceWithTransfer = await generateInvoiceTransfer(invoice);
    const clientUrl =
      process.env.CLIENT_URL || req.headers.origin || "http://localhost:3000";

    res.status(201).json({
      invoice: getPublicInvoice(invoiceWithTransfer),
      invoiceUrl: `${clientUrl}/pay-invoice/${invoice.token}`,
    });
  } catch (error) {
    if (invoice) {
      invoice.status = "failed";
      await invoice.save().catch(() => {});
    }
    console.log("CREATE INVOICE ERROR:", error.response?.data || error);
    res.status(500).json({ message: "Unable to create invoice" });
  }
};

exports.getInvoice = async (req, res) => {
  try {
    const invoice = await Invoice.findOne({ token: req.params.token });

    if (!invoice) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    let refreshedInvoice = await refreshInvoiceStatus(invoice);

    if (
      refreshedInvoice.status !== "paid" &&
      refreshedInvoice.status !== "expired" &&
      !refreshedInvoice.accountNumber
    ) {
      refreshedInvoice = await generateInvoiceTransfer(refreshedInvoice);
    }

    res.json(getPublicInvoice(refreshedInvoice));
  } catch (error) {
    console.log("GET INVOICE ERROR:", error.response?.data || error);
    res.status(500).json({ message: "Unable to fetch invoice" });
  }
};

exports.startInvoiceTransfer = async (req, res) => {
  try {
    const invoice = await Invoice.findOne({ token: req.params.token });

    if (!invoice) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    const invoiceWithTransfer = await generateInvoiceTransfer(invoice);

    if (invoiceWithTransfer.status === "expired") {
      return res.status(410).json({ message: "This invoice has expired." });
    }

    res.json(getPublicInvoice(invoiceWithTransfer));
  } catch (error) {
    console.log("START INVOICE TRANSFER ERROR:", error.response?.data || error);
    res.status(500).json({ message: "Unable to generate payment account" });
  }
};

exports.listInvoices = async (req, res) => {
  try {
    const invoices = await Invoice.find({ deletedAt: null }).sort({ createdAt: -1 });
    res.json(invoices);
  } catch (error) {
    console.log("LIST INVOICES ERROR:", error);
    res.status(500).json({ message: "Unable to fetch invoices" });
  }
};

exports.emailCourseAccess = async (req, res) => {
  let claimedInvoice;
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: "Please enter a valid email address." });
    }
    const invoice = await Invoice.findOne({ token: req.params.token });
    if (!invoice) return res.status(404).json({ message: "Invoice not found." });
    await refreshInvoiceStatus(invoice);
    if (!isPaidCourse(invoice)) {
      return res.status(403).json({ message: "Your course payment must be confirmed first." });
    }
    invoice.customerEmail = email;
    await invoice.save();
    if (!process.env.RESEND_API_KEY) {
      return res.status(503).json({ message: "Email is unavailable right now. You can still join both Telegram channels below." });
    }
    claimedInvoice = await Invoice.findOneAndUpdate({
      _id: invoice._id,
      $or: [
        { courseEmailSentAt: { $exists: false } },
        { courseEmailSentAt: { $lt: new Date(Date.now() - 60000) } },
      ],
    }, { $set: { courseEmailSentAt: new Date() } }, { new: true });
    if (!claimedInvoice) {
      return res.status(429).json({ message: "Please wait a minute before sending the links again." });
    }
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { data: emailResult, error } = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || "Joshspot Media <booking@joshspotmedia.com>",
      to: email,
      subject: "How to run Tiktok, Fb and Ig ads — Joshspot Media",
      text: `Your payment is confirmed!

Here are your course links. Join both Telegram channels and start learning. Keep this email so you can always find your way back.

${courses.map((course) => `${course.title}: ${course.url}`).join("\n\n")}

The tutorial contains:
- How to register on TikTok Ads Manager, set things up and start running ads from scratch.
- How to create Facebook ad campaigns without getting confused by the buttons inside Ads Manager.
- How to run Instagram ads to your Instagram page, WhatsApp or website.
- How to create a simple online store where people can see your products and place orders.
- How to open and arrange your ads account properly before you start spending money.
- How to add your card and fund your ads account.
- How to choose the right audience for your ads.
- How to connect your ad to a landing page or store so people can buy or message you.
- How to choose videos and pictures for your ads.
- How to read your ad results, see what is working and know what to fix.
- How to retarget people who have watched, clicked or shown interest in what you sell.
- How to avoid common beginner mistakes that waste your ad budget.

See you inside the channels!
Josh`,
    });
    if (error) throw new Error("Email provider rejected delivery");
    await Invoice.updateOne({ _id: invoice._id }, { $set: { courseEmailId: emailResult?.id || "" } }).catch(() => {});
    return res.json({ message: "The video links has been sent to your email. Also check your spam folder too incase you can't find it in your inbox." });
  } catch (error) {
    if (claimedInvoice) {
      await Invoice.updateOne({ _id: claimedInvoice._id, courseEmailSentAt: claimedInvoice.courseEmailSentAt },
        { $unset: { courseEmailSentAt: 1 } }).catch(() => {});
    }
    return res.status(500).json({ message: "The email did not send. Please try again, or join the Telegram channels below." });
  }
};

exports.refreshInvoiceStatus = refreshInvoiceStatus;
