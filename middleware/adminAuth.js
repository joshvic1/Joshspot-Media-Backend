const jwt = require("jsonwebtoken");

module.exports = (req, res, next) => {
  // Existing admin pages send the raw JWT, while newer proxied pages use the
  // standard "Bearer <JWT>" form. Both represent the same authenticated
  // session, so normalize before verification instead of rejecting one form.
  const authorization = String(req.headers.authorization || "").trim();
  const token = authorization.replace(/^Bearer\s+/i, "");

  if (!token) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "joshspotsecret",
    );

    if (!decoded.admin) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    next();
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
};
