const VerificationClient = require("../models/VerificationClient");

exports.getVerificationClients = async (req, res) => {
  try {
    const clients = await VerificationClient.find().sort({ createdAt: -1 });

    res.json(clients);
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

    if (!name || !businessName || !clientLoginDetails || !amountPaid || !clientNumber) {
      return res.status(400).json({ message: "Please fill all required fields" });
    }

    if (!idCard?.data) {
      return res.status(400).json({ message: "Please upload the ID card" });
    }

    const client = await VerificationClient.create({
      name,
      businessName,
      clientLoginDetails,
      amountPaid: Number(amountPaid),
      clientNumber,
      idCard,
      createdBy: req.staff.staffId,
      updatedBy: req.staff.staffId,
    });

    res.status(201).json(client);
  } catch (error) {
    console.log("CREATE VERIFICATION CLIENT ERROR:", error);
    res.status(500).json({ message: "Unable to create verification client" });
  }
};

exports.updateVerificationClient = async (req, res) => {
  try {
    const update = { ...req.body, updatedBy: req.staff.staffId };

    if (Object.prototype.hasOwnProperty.call(update, "amountPaid")) {
      update.amountPaid = Number(update.amountPaid || 0);
    }

    const client = await VerificationClient.findByIdAndUpdate(req.params.id, update, {
      new: true,
      runValidators: true,
    });

    if (!client) {
      return res.status(404).json({ message: "Verification client not found" });
    }

    res.json(client);
  } catch (error) {
    console.log("UPDATE VERIFICATION CLIENT ERROR:", error);
    res.status(500).json({ message: "Unable to update verification client" });
  }
};
