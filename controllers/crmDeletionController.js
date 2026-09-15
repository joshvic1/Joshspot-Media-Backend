const mongoose = require("mongoose");
const models = {
  clients: require("../models/Client"),
  "ads-clients": require("../models/AdsClient"),
  "verification-clients": require("../models/VerificationClient"),
};

module.exports = async (req, res) => {
  if (req.staff?.admin !== true) return res.status(403).json({ message: "Only administrators can delete clients" });
  const Model = models[req.params.kind];
  if (!Model) return res.status(404).json({ message: "Client category not found" });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: "Invalid client ID" });
  try {
    const client = await Model.findByIdAndDelete(req.params.id);
    if (!client) return res.status(404).json({ message: "Client not found" });
    return res.json({ message: "Client deleted" });
  } catch {
    return res.status(500).json({ message: "Unable to delete client" });
  }
};
