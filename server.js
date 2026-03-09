require("dotenv").config();

const express = require("express");
const cors = require("cors");

const connectDB = require("./config/db");
const paymentRoutes = require("./routes/paymentRoutes");
const bookingRoutes = require("./routes/bookingRoutes");
const adminRoutes = require("./routes/adminRoutes");

const app = express();

connectDB();

/* IMPORTANT: Middleware first */

app.use(cors());
app.use(express.json());

/* Routes after middleware */

app.use("/api/payment", paymentRoutes);
app.use("/api/booking", bookingRoutes);
app.use("/api/admin", adminRoutes);

app.get("/", (req, res) => {
  res.send("Joshspot Media API running");
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
