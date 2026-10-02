const jwt = require("jsonwebtoken");

exports.adminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (typeof email !== 'string' || typeof password !== 'string') return res.status(400).json({ message: 'Email and password are required' });

    if (
      !process.env.ADMIN_EMAIL || email.trim().toLowerCase() !== process.env.ADMIN_EMAIL.trim().toLowerCase() ||
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
