require("dotenv").config();

const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const Staff = require("../models/Staff");

const staffUsers = [
  {
    name: "Customer Support Staff",
    email: "css@joshspotmedia.com",
    password: "Css@12345",
    role: "CSS",
  },
  {
    name: "Sales Staff",
    email: "sales@joshspotmedia.com",
    password: "Sales@12345",
    role: "SS",
  },
  {
    name: "Setup Staff",
    email: "setup@joshspotmedia.com",
    password: "Setup@12345",
    role: "SES",
  },
];

const seedCrmUsers = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);

    for (const user of staffUsers) {
      const hashedPassword = await bcrypt.hash(user.password, 10);

      await Staff.findOneAndUpdate(
        { email: user.email },
        {
          name: user.name,
          email: user.email,
          password: hashedPassword,
          role: user.role,
        },
        { upsert: true, new: true },
      );

      console.log(`${user.role} user ready: ${user.email}`);
    }

    console.log("CRM staff seed completed");
    process.exit(0);
  } catch (error) {
    console.error("CRM staff seed failed:", error);
    process.exit(1);
  }
};

seedCrmUsers();
