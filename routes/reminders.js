const express = require("express");
const router = express.Router();
const pool = require("../db");

router.get("/reminders", async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT * FROM reminders ORDER BY reminder_month ASC, reminder_day ASC`);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/reminders", async (req, res) => {
  const { title, description, reminderType, reminderMonth, reminderDay, reminderWeekday, amount } = req.body;
  if (!title) return res.status(400).json({ success: false, error: "Title required" });
  try {
    const [result] = await pool.query(
      `INSERT INTO reminders (title, description, reminder_type, reminder_month, reminder_day, reminder_weekday, amount, status, created_date)
       VALUES (?,?,?,?,?,?,?,'active',CURDATE())`,
      [title.toUpperCase(), description || "", reminderType || "monthly", reminderMonth || 1, reminderDay || 1, reminderWeekday || 0, amount || 0]
    );
    res.json({ success: true, data: { id: result.insertId } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put("/reminders/:id", async (req, res) => {
  const { title, description, reminderType, reminderMonth, reminderDay, reminderWeekday, amount } = req.body;
  if (!title) return res.status(400).json({ success: false, error: "Title required" });
  try {
    await pool.query(
      `UPDATE reminders SET title=?, description=?, reminder_type=?, reminder_month=?, reminder_day=?, reminder_weekday=?, amount=? WHERE id=?`,
      [title.toUpperCase(), description || "", reminderType || "monthly", reminderMonth || 1, reminderDay || 1, reminderWeekday || 0, amount || 0, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/reminders/:id/complete", async (req, res) => {
  const { notes } = req.body;
  try {
    await pool.query(
      `UPDATE reminders SET status='completed', completed_date=CURDATE(), completed_notes=? WHERE id=?`,
      [notes || "", req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/reminders/:id/reset", async (req, res) => {
  try {
    await pool.query(
      `UPDATE reminders SET status='active', completed_date=NULL, completed_notes=NULL WHERE id=?`,
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete("/reminders/:id", async (req, res) => {
  try {
    await pool.query(`DELETE FROM reminders WHERE id=?`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
