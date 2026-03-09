const jwt = require("jsonwebtoken");

module.exports = (req, res, next) => {
  const token = req.headers.authorization;

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
