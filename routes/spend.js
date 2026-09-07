const express = require("express");
const router = express.Router();
const pool = require("../db");

// Quick Spend stores each entry as a JSON blob keyed by the id the phone
// already generated locally (never a server-assigned id — see the app's
// own "assign ids on-device" rule, this avoids any create/sync round trip).
// These tables don't exist in the original Apps Script schema, so they're
// created here on first use rather than requiring a manual migration step.
let tablesReady = null;
function ensureTables() {
  if (!tablesReady) {
    tablesReady = (async () => {
      await pool.query(`CREATE TABLE IF NOT EXISTS spend_expenses (
        id VARCHAR(64) PRIMARY KEY,
        data JSON NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
      await pool.query(`CREATE TABLE IF NOT EXISTS spend_payments (
        id VARCHAR(64) PRIMARY KEY,
        data JSON NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
    })();
  }
  return tablesReady;
}
router.use(async (req, res, next) => {
  try { await ensureTables(); next(); }
  catch (err) { res.status(500).json({ success: false, error: "Database not ready: " + err.message }); }
});

// ---------- expenses ----------
router.get("/spend/expenses", async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT id, data FROM spend_expenses`);
    res.json({ success: true, data: rows.map(r => ({ id: r.id, ...JSON.parse(r.data) })) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
router.post("/spend/expenses", async (req, res) => {
  const { id, ...rest } = req.body;
  if (!id) return res.status(400).json({ success: false, error: "id required" });
  try {
    await pool.query(
      `INSERT INTO spend_expenses (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)`,
      [id, JSON.stringify(rest)]
    );
    res.json({ success: true, data: { id } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
router.put("/spend/expenses/:id", async (req, res) => {
  const { id: _drop, ...rest } = req.body;
  try {
    await pool.query(
      `INSERT INTO spend_expenses (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)`,
      [req.params.id, JSON.stringify(rest)]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
router.delete("/spend/expenses/:id", async (req, res) => {
  try {
    await pool.query(`DELETE FROM spend_expenses WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- person payments ----------
router.get("/spend/payments", async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT id, data FROM spend_payments`);
    res.json({ success: true, data: rows.map(r => ({ id: r.id, ...JSON.parse(r.data) })) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
router.post("/spend/payments", async (req, res) => {
  const { id, ...rest } = req.body;
  if (!id) return res.status(400).json({ success: false, error: "id required" });
  try {
    await pool.query(
      `INSERT INTO spend_payments (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)`,
      [id, JSON.stringify(rest)]
    );
    res.json({ success: true, data: { id } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
router.put("/spend/payments/:id", async (req, res) => {
  const { id: _drop, ...rest } = req.body;
  try {
    await pool.query(
      `INSERT INTO spend_payments (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)`,
      [req.params.id, JSON.stringify(rest)]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
router.delete("/spend/payments/:id", async (req, res) => {
  try {
    await pool.query(`DELETE FROM spend_payments WHERE id = ?`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
