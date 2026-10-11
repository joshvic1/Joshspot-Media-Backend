const jwt = require("jsonwebtoken");

module.exports = async (req, res, next) => {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const decoded = jwt.verify(
      token.replace("Bearer ", ""),
      process.env.JWT_SECRET || "joshspotsecret",
    );

    if (decoded.admin === true) {
      req.staff = { role: "ADMIN", name: "Administrator", admin: true };
      return next();
    }

    if (!decoded.staffId || !decoded.role) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const staff = await require("../models/Staff").findById(decoded.staffId).select("name role permissions").lean();
    if (!staff) return res.status(401).json({ message: "Account no longer exists" });
    req.staff = { ...decoded, role: staff.role, name: staff.name, permissions: staff.permissions || {} };
    next();
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
};
