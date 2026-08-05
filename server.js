require("dotenv").config();
const express = require("express");
const cors = require("cors");
const requireApiKey = require("./middleware/auth");

const financeRoutes = require("./routes/finance");
const reminderRoutes = require("./routes/reminders");
const productRoutes = require("./routes/products");
const noteRoutes = require("./routes/notes");

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// Log every incoming request so Render's log tab actually shows activity —
// makes it possible to tell "request never arrived" apart from "request
// arrived and failed" when debugging from the dashboard.
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  next();
});

// Public health check - no auth needed, useful to confirm the server is up
app.get("/health", (req, res) => res.json({ ok: true }));

// Everything under /api requires the x-api-key header
app.use("/api", requireApiKey, financeRoutes);
app.use("/api", requireApiKey, reminderRoutes);
app.use("/api", requireApiKey, productRoutes);
app.use("/api", requireApiKey, noteRoutes);

// Catch-all error logger — without this, a thrown error inside a route's
// try/catch that still calls res.status(500) never prints anything to
// the Render log, so failures were invisible from the dashboard.
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ success: false, error: "Internal server error" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Finance Manager backend running on port ${PORT}`));
