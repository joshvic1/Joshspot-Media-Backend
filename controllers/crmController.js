const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Client = require("../models/Client");
const Staff = require("../models/Staff");

const MASK = "******";

const rolePermissions = {
  SS: {
    canCreate: true,
    fields: [
      "businessName",
      "amountPaid",
      "servicePaidFor",
      "clientLoginDetails",
      "landingPageLogins",
      "landingPageLink",
      "clientNumber",
    ],
  },
  CSS: {
    canCreate: true,
    fields: [
      "businessName",
      "servicePaidFor",
      "clientLoginDetails",
      "landingPageLogins",
      "landingPageLink",
      "clientNumber",
    ],
  },
  SES: {
    canCreate: false,
    fields: [
      "businessName",
      "servicePaidFor",
      "clientLoginDetails",
      "landingPageLogins",
      "landingPageLink",
    ],
  },
};

const allClientFields = [
  "businessName",
  "amountPaid",
  "servicePaidFor",
  "clientLoginDetails",
  "landingPageLogins",
  "landingPageLink",
  "clientNumber",
];

const getPermissions = (role) => rolePermissions[role] || rolePermissions.SES;

const maskClientForRole = (client, role) => {
  const allowedFields = getPermissions(role).fields;
  const data = client.toObject ? client.toObject() : client;

  allClientFields.forEach((field) => {
    if (!allowedFields.includes(field)) {
      data[field] = MASK;
    }
  });

  return data;
};

const pickAllowedFields = (body, role) => {
  const allowedFields = getPermissions(role).fields;
  const update = {};

  allowedFields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      update[field] = body[field];
    }
  });

  return update;
};

exports.crmLogin = async (req, res) => {
  try {
    const { email, password } = req.body;
    const staff = await Staff.findOne({ email });

    if (!staff) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const passwordMatches = await bcrypt.compare(password, staff.password);

    if (!passwordMatches) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign(
      {
        staffId: staff._id,
        role: staff.role,
        name: staff.name,
      },
      process.env.JWT_SECRET || "joshspotsecret",
      { expiresIn: "7d" },
    );

    res.json({
      token,
      staff: {
        id: staff._id,
        name: staff.name,
        email: staff.email,
        role: staff.role,
      },
    });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.getClients = async (req, res) => {
  try {
    const clients = await Client.find().sort({ createdAt: -1 });

    res.json({
      staff: req.staff,
      permissions: getPermissions(req.staff.role),
      clients: clients.map((client) => maskClientForRole(client, req.staff.role)),
    });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.createClient = async (req, res) => {
  try {
    const permissions = getPermissions(req.staff.role);

    if (!permissions.canCreate) {
      return res.status(403).json({ message: "You cannot create clients" });
    }

    const payload = pickAllowedFields(req.body, req.staff.role);

    if (!payload.businessName || !payload.servicePaidFor) {
      return res.status(400).json({
        message: "Business name and service paid for are required",
      });
    }

    const client = await Client.create({
      ...payload,
      createdBy: req.staff.staffId,
      updatedBy: req.staff.staffId,
    });

    res.status(201).json(maskClientForRole(client, req.staff.role));
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

exports.updateClient = async (req, res) => {
  try {
    const update = pickAllowedFields(req.body, req.staff.role);

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ message: "No allowed fields to update" });
    }

    update.updatedBy = req.staff.staffId;

    const client = await Client.findByIdAndUpdate(req.params.id, update, {
      new: true,
      runValidators: true,
    });

    if (!client) {
      return res.status(404).json({ message: "Client not found" });
    }

    res.json(maskClientForRole(client, req.staff.role));
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};
