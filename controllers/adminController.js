const jwt = require("jsonwebtoken");

exports.adminLogin = async (req, res) => {
  try {
    console.log("EMAIL:", process.env.ADMIN_EMAIL);
    console.log("PASSWORD:", process.env.ADMIN_PASSWORD);
    console.log("SECRET:", process.env.JWT_SECRET);

    const { email, password } = req.body;

    if (
      email !== process.env.ADMIN_EMAIL ||
      password !== process.env.ADMIN_PASSWORD
    ) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign({ admin: true }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    res.json({ token });
  } catch (error) {
    console.log("ADMIN LOGIN ERROR:", error);

    res.status(500).json({ message: "Server error" });
  }
};
