const VerificationClient = require("../models/VerificationClient");
const {
  getVerificationIdCard,
  uploadVerificationIdCard,
} = require("../utils/r2Storage");

const MASK = "******";

const maskVerificationClientForRole = (client, role) => {
  const data = client.toObject ? client.toObject() : client;

  if (role !== "SS") {
    data.amountPaid = MASK;
  }

  return data;
};

exports.getVerificationClients = async (req, res) => {
  try {
    const clients = await VerificationClient.find().sort({ createdAt: -1 });

    res.json(clients.map((client) => maskVerificationClientForRole(client, req.staff.role)));
  } catch (error) {
    console.log("GET VERIFICATION CLIENTS ERROR:", error);
    res.status(500).json({ message: "Unable to fetch verification clients" });
  }
};

exports.createVerificationClient = async (req, res) => {
  try {
    const {
      amountPaid,
      businessName,
      clientLoginDetails,
      clientNumber,
      idCard,
      name,
    } = req.body;

    if (!name || !businessName || !clientLoginDetails || !clientNumber) {
      return res.status(400).json({ message: "Please fill all required fields" });
    }

    if (req.staff.role === "SS" && !amountPaid) {
      return res.status(400).json({ message: "Amount paid is required" });
    }

    if (!idCard?.data) {
      return res.status(400).json({ message: "Please upload the ID card" });
    }

    const uploadedIdCard = await uploadVerificationIdCard(idCard);

    const client = await VerificationClient.create({
      name,
      businessName,
      clientLoginDetails,
      amountPaid: req.staff.role === "SS" ? Number(amountPaid) : 0,
      clientNumber,
      idCard: uploadedIdCard,
      createdBy: req.staff.staffId,
      updatedBy: req.staff.staffId,
    });

    res.status(201).json(maskVerificationClientForRole(client, req.staff.role));
  } catch (error) {
    console.log("CREATE VERIFICATION CLIENT ERROR:", error);
    res.status(500).json({ message: "Unable to create verification client" });
  }
};

exports.updateVerificationClient = async (req, res) => {
  try {
    const update = { ...req.body, updatedBy: req.staff.staffId };

    if (update.idCard?.data) {
      update.idCard = await uploadVerificationIdCard(update.idCard);
    }

    if (Object.prototype.hasOwnProperty.call(update, "amountPaid")) {
      if (req.staff.role !== "SS") {
        delete update.amountPaid;
      } else {
        update.amountPaid = Number(update.amountPaid || 0);
      }
    }

    const client = await VerificationClient.findByIdAndUpdate(req.params.id, update, {
      new: true,
      runValidators: true,
    });

    if (!client) {
      return res.status(404).json({ message: "Verification client not found" });
    }

    res.json(maskVerificationClientForRole(client, req.staff.role));
  } catch (error) {
    console.log("UPDATE VERIFICATION CLIENT ERROR:", error);
    res.status(500).json({ message: "Unable to update verification client" });
  }
};

exports.downloadVerificationIdCard = async (req, res) => {
  try {
    const client = await VerificationClient.findById(req.params.id);

    if (!client?.idCard?.key) {
      return res.status(404).json({ message: "ID card not found" });
    }

    const file = await getVerificationIdCard(client.idCard.key);

    res.setHeader(
      "Content-Type",
      client.idCard.mimeType || file.ContentType || "application/octet-stream",
    );
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${client.idCard.fileName || "verification-id-card"}"`,
    );

    file.Body.pipe(res);
  } catch (error) {
    console.log("DOWNLOAD VERIFICATION ID CARD ERROR:", error);
    res.status(500).json({ message: "Unable to download ID card" });
  }
};
