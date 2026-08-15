const express = require("express");
const router = express.Router();
const pool = require("../db");

router.get("/notes", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, `Date` as date, `Phrase` as phrase, `Notes` as note, `Time` as time, `Drive_Link` as drive_link FROM daily_notes ORDER BY `Date` DESC, `Time` DESC"
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// mysql2 returns DATE columns as JS Date objects by default (no
// dateStrings option set on the pool). When a note gets pulled from the
// server, cached locally, then edited and sent back, JSON.stringify
// silently turns that Date object into a full ISO string
// ("2026-08-15T00:00:00.000Z") — which MySQL's DATE column rejects,
// since it only accepts "YYYY-MM-DD". Always strip to the date portion
// before it reaches a query, regardless of which shape it arrives in.
function toDateOnly(d) {
  if (!d) return new Date().toISOString().split("T")[0];
  return String(d).split("T")[0];
}

router.post("/notes", async (req, res) => {
  const { phrase, note, date, billImageUrl } = req.body;
  if (!phrase || !note) return res.status(400).json({ success: false, error: "Phrase and note required" });
  try {
    const now = new Date();
    const timeStr = now.toTimeString().split(" ")[0];
    const [result] = await pool.query(
      "INSERT INTO daily_notes (`Date`, `Phrase`, `Notes`, `Time`, `Drive_Link`) VALUES (?,?,?,?,?)",
      [toDateOnly(date), phrase.toUpperCase(), note, timeStr, billImageUrl || ""]
    );
    res.json({ success: true, data: { id: result.insertId } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put("/notes/:id", async (req, res) => {
  const { phrase, note, date, billImageUrl } = req.body;
  if (!phrase || !note) return res.status(400).json({ success: false, error: "Phrase and note required" });
  try {
    const params = [phrase.toUpperCase(), note, toDateOnly(date)];
    let sql = "UPDATE daily_notes SET `Phrase`=?, `Notes`=?, `Date`=?";
    if (billImageUrl !== undefined) {
      sql += ", `Drive_Link`=?";
      params.push(billImageUrl || "");
    }
    sql += " WHERE id=?";
    params.push(req.params.id);
    await pool.query(sql, params);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete("/notes/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM daily_notes WHERE id=?", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
