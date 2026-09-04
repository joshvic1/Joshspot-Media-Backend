const AdsClient = require("../models/AdsClient");

const MASK = "******";

const rolePermissions = {
  SS: {
    canCreate: true,
    fields: [
      "businessName",
      "amountPaid",
      "clientLoginDetails",
      "videoLinks",
      "servicePaidFor",
      "note",
    ],
  },
  CSS: {
    canCreate: true,
    fields: [
      "businessName",
      "amountPaid",
      "clientLoginDetails",
      "videoLinks",
      "servicePaidFor",
      "note",
    ],
  },
  SES: {
    canCreate: false,
    fields: ["businessName", "clientLoginDetails", "videoLinks", "servicePaidFor", "note"],
  },
};

const allAdsFields = [
  "businessName",
  "amountPaid",
  "clientLoginDetails",
  "videoLinks",
  "servicePaidFor",
  "note",
];

const getPermissions = (role) => rolePermissions[role] || rolePermissions.SES;

const maskAdsClientForRole = (client, role) => {
  const allowedFields = getPermissions(role).fields;
  const data = client.toObject ? client.toObject() : client;

  allAdsFields.forEach((field) => {
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
      update[field] = field === "amountPaid" ? Number(body[field] || 0) : body[field];
    }
  });

  return update;
};

const pickAdsPublishStatus = (body) => {
  if (!Object.prototype.hasOwnProperty.call(body, "adsPublished")) {
    return {};
  }

  return { adsPublished: Boolean(body.adsPublished) };
};

exports.getAdsClients = async (req, res) => {
  try {
    const clients = await AdsClient.find().sort({ createdAt: -1 });

    res.json({
      staff: req.staff,
      permissions: getPermissions(req.staff.role),
      clients: clients.map((client) => maskAdsClientForRole(client, req.staff.role)),
    });
  } catch (error) {
    console.log("GET ADS CLIENTS ERROR:", error);
    res.status(500).json({ message: "Unable to fetch ads clients" });
  }
};

exports.createAdsClient = async (req, res) => {
  try {
    const permissions = getPermissions(req.staff.role);

    if (!permissions.canCreate) {
      return res.status(403).json({ message: "You cannot create ads clients" });
    }

    const payload = pickAllowedFields(req.body, req.staff.role);

    if (!payload.businessName || !payload.videoLinks || !payload.servicePaidFor) {
      return res.status(400).json({
        message: "Business name, video links, and service paid for are required",
      });
    }

    const client = await AdsClient.create({
      ...payload,
      createdBy: req.staff.staffId,
      updatedBy: req.staff.staffId,
    });

    res.status(201).json(maskAdsClientForRole(client, req.staff.role));
  } catch (error) {
    console.log("CREATE ADS CLIENT ERROR:", error);
    res.status(500).json({ message: "Unable to create ads client" });
  }
};

exports.updateAdsClient = async (req, res) => {
  try {
    const update = {
      ...pickAllowedFields(req.body, req.staff.role),
      ...pickAdsPublishStatus(req.body),
    };

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ message: "No allowed fields to update" });
    }

    update.updatedBy = req.staff.staffId;

    const client = await AdsClient.findByIdAndUpdate(req.params.id, update, {
      new: true,
      runValidators: true,
    });

    if (!client) {
      return res.status(404).json({ message: "Ads client not found" });
    }

    res.json(maskAdsClientForRole(client, req.staff.role));
  } catch (error) {
    console.log("UPDATE ADS CLIENT ERROR:", error);
    res.status(500).json({ message: "Unable to update ads client" });
  }
};
