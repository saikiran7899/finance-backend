const express = require("express");
const router = express.Router();
const pool = require("../db");

// ── TEMPORARY diagnostic routes ──────────────────────────────────────────
// Purpose: let you check your live database and test the Quick Spend insert
// path directly from a browser URL, without needing Render's Shell (which
// needs a paid plan). Auth here is a simple ?key= query param (not the
// x-api-key header) specifically so you can just paste a URL into a browser
// address bar and see the result.
//
// DELETE THIS FILE (and its require/app.use lines in server.js) once you're
// done debugging — it's not something that should stay in a real deployment.

const DEBUG_KEY = process.env.API_KEY;

function checkKey(req, res) {
  if (!DEBUG_KEY || req.query.key !== DEBUG_KEY) {
    res.status(401).json({ success: false, error: "Unauthorized — add ?key=YOUR_API_KEY to the URL" });
    return false;
  }
  return true;
}

// Visit: /api/debug/tables?key=YOUR_API_KEY
// Lists every table that actually exists in your database right now.
router.get("/debug/tables", async (req, res) => {
  if (!checkKey(req, res)) return;
  try {
    const [rows] = await pool.query("SHOW TABLES");
    const tables = rows.map(r => Object.values(r)[0]);
    res.json({ success: true, data: tables });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Visit: /api/debug/test-spend?key=YOUR_API_KEY
// Runs the EXACT same steps the Quick Spend POST route runs: create the
// table if missing, insert one test row, then read it back.
router.get("/debug/test-spend", async (req, res) => {
  if (!checkKey(req, res)) return;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS spend_expenses (
      id VARCHAR(64) PRIMARY KEY,
      data JSON NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
    await pool.query(
      `INSERT INTO spend_expenses (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)`,
      ["debug-test-1", JSON.stringify({ amount: 1, note: "debug test row — safe to ignore/delete" })]
    );
    const [rows] = await pool.query("SELECT id, data, updated_at FROM spend_expenses WHERE id = ?", ["debug-test-1"]);
    res.json({ success: true, message: "Table created/verified and test row inserted successfully.", data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, code: err.code || null });
  }
});

// Visit: /api/debug/spend-data?key=YOUR_API_KEY
// Shows every real row currently stored in spend_expenses and spend_payments —
// this is the one to use to actually see your data, not just confirm the
// tables exist.
router.get("/debug/spend-data", async (req, res) => {
  if (!checkKey(req, res)) return;
  try {
    const [expenseRows] = await pool.query(
      "SELECT id, data, updated_at FROM spend_expenses ORDER BY updated_at DESC"
    );
    const [paymentRows] = await pool.query(
      "SELECT id, data, updated_at FROM spend_payments ORDER BY updated_at DESC"
    ).catch(() => [[]]); // table may not exist yet if you've never logged a person payment

    res.json({
      success: true,
      data: {
        expenses: expenseRows.map(r => ({ id: r.id, ...JSON.parse(r.data), updated_at: r.updated_at })),
        payments: paymentRows.map(r => ({ id: r.id, ...JSON.parse(r.data), updated_at: r.updated_at }))
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
