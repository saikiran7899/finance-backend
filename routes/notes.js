const express = require("express");
const router = express.Router();
const pool = require("../db");

router.get("/notes", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, `Date` as date, `Phrase` as phrase, `Notes` as notes, `Time` as time FROM daily_notes ORDER BY `Date` DESC, `Time` DESC"
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/notes", async (req, res) => {
  const { phrase, note, date } = req.body;
  if (!phrase || !note) return res.status(400).json({ success: false, error: "Phrase and note required" });
  try {
    const now = new Date();
    const timeStr = now.toTimeString().split(" ")[0];
    const [result] = await pool.query(
      "INSERT INTO daily_notes (`Date`, `Phrase`, `Notes`, `Time`) VALUES (?,?,?,?)",
      [date || now.toISOString().split("T")[0], phrase.toUpperCase(), note, timeStr]
    );
    res.json({ success: true, data: { id: result.insertId } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
