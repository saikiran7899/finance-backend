require("dotenv").config();
const express = require("express");
const cors = require("cors");
const requireApiKey = require("./middleware/auth");

const financeRoutes = require("./routes/finance");
const reminderRoutes = require("./routes/reminders");
const productRoutes = require("./routes/products");
const noteRoutes = require("./routes/notes");
const rentRoutes = require("./routes/rent");
const placesRoutes = require("./routes/places");

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// Public health check - no auth needed, useful to confirm the server is up
app.get("/health", (req, res) => res.json({ ok: true }));

// Everything under /api requires the x-api-key header
app.use("/api", requireApiKey, financeRoutes);
app.use("/api", requireApiKey, reminderRoutes);
app.use("/api", requireApiKey, productRoutes);
app.use("/api", requireApiKey, noteRoutes);
app.use("/api", requireApiKey, rentRoutes);
app.use("/api", requireApiKey, placesRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Finance Manager backend running on port ${PORT}`));
