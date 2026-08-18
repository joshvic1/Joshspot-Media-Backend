const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const Invoice = require("../models/Invoice");

const PAYSTACK_BASE_URL = "https://api.paystack.co";
const INVOICE_LIFETIME_HOURS = 8;

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
});

const refreshInvoiceStatus = async (invoice) => {
  if (invoice.status === "paid") return invoice;

  if (invoice.expiresAt && new Date(invoice.expiresAt) < new Date()) {
    invoice.status = "expired";
    await invoice.save();
    return invoice;
  }

  if (!invoice.reference) return invoice;

  try {
    const response = await axios.get(
      `${PAYSTACK_BASE_URL}/transaction/verify/${invoice.reference}`,
      { headers: paystackHeaders() },
    );

    const transaction = response.data.data;
    invoice.paystackStatus = transaction.status;

    if (transaction.status === "success") {
      invoice.status = "paid";
      invoice.paidAt = transaction.paid_at || new Date();
    }

    await invoice.save();
  } catch (error) {
    console.log("PAYSTACK VERIFY ERROR:", error.response?.data || error.message);
  }

  return invoice;
};

exports.createInvoice = async (req, res) => {
  try {
    const amount = Number(req.body.amount);

    if (!amount || amount < 100) {
      return res.status(400).json({ message: "Please enter a valid amount." });
    }

    const invoice = await Invoice.create({
      token: uuidv4(),
      amount,
      customerName: req.body.customerName || "",
      customerEmail: req.body.customerEmail || "",
      note: req.body.note || "",
      expiresAt: new Date(Date.now() + INVOICE_LIFETIME_HOURS * 60 * 60 * 1000),
    });

    const clientUrl =
      process.env.CLIENT_URL || req.headers.origin || "http://localhost:3000";

    res.status(201).json({
      invoice: getPublicInvoice(invoice),
      invoiceUrl: `${clientUrl}/pay-invoice/${invoice.token}`,
    });
  } catch (error) {
    console.log("CREATE INVOICE ERROR:", error);
    res.status(500).json({ message: "Unable to create invoice" });
  }
};

exports.getInvoice = async (req, res) => {
  try {
    const invoice = await Invoice.findOne({ token: req.params.token });

    if (!invoice) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    const refreshedInvoice = await refreshInvoiceStatus(invoice);

    res.json(getPublicInvoice(refreshedInvoice));
  } catch (error) {
    console.log("GET INVOICE ERROR:", error);
    res.status(500).json({ message: "Unable to fetch invoice" });
  }
};

exports.startInvoiceTransfer = async (req, res) => {
  try {
    const invoice = await Invoice.findOne({ token: req.params.token });

    if (!invoice) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    const refreshedInvoice = await refreshInvoiceStatus(invoice);

    if (refreshedInvoice.status === "paid") {
      return res.json(getPublicInvoice(refreshedInvoice));
    }

    if (refreshedInvoice.status === "expired") {
      return res.status(410).json({ message: "This invoice has expired." });
    }

    if (refreshedInvoice.accountNumber && refreshedInvoice.status === "pending") {
      return res.json(getPublicInvoice(refreshedInvoice));
    }

    const reference = `invoice-${Date.now()}-${uuidv4().slice(0, 8)}`;
    const expiresAt = new Date(
      Date.now() + INVOICE_LIFETIME_HOURS * 60 * 60 * 1000,
    );
    const email =
      refreshedInvoice.customerEmail ||
      `invoice-${refreshedInvoice.token}@joshspotmedia.com`;

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

    res.json(getPublicInvoice(refreshedInvoice));
  } catch (error) {
    console.log("START INVOICE TRANSFER ERROR:", error.response?.data || error);
    res.status(500).json({ message: "Unable to generate payment account" });
  }
};

exports.listInvoices = async (req, res) => {
  try {
    const invoices = await Invoice.find().sort({ createdAt: -1 });
    res.json(invoices);
  } catch (error) {
    console.log("LIST INVOICES ERROR:", error);
    res.status(500).json({ message: "Unable to fetch invoices" });
  }
};
