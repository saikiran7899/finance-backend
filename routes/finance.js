const express = require("express");
const router = express.Router();
const pool = require("../db");

// GET /api/entries?fromDate=&toDate=&keyword=
router.get("/entries", async (req, res) => {
  const { fromDate = "1970-01-01", toDate = "2099-12-31", keyword = "" } = req.query;
  try {
    const [credit] = await pool.query(
      `SELECT id, date, name, place, amount, 'CREDIT' as type, mode, purpose, sent_by, bank_name, note,
              available_balance as status_or_balance, drive_link
       FROM credit_ledger WHERE date BETWEEN ? AND ? ORDER BY date DESC`,
      [fromDate, toDate]
    );
    const [debit] = await pool.query(
      `SELECT id, date, name, place, amount, 'DEBIT' as type, mode, purpose, sent_by, bank_name, note,
              status as status_or_balance, drive_link
       FROM debit_ledger WHERE date BETWEEN ? AND ? ORDER BY date DESC`,
      [fromDate, toDate]
    );
    let all = [...credit, ...debit];
    if (keyword) {
      const kw = keyword.toUpperCase();
      all = all.filter(r => `${r.name} ${r.place} ${r.purpose} ${r.mode}`.toUpperCase().includes(kw));
    }
    all.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json({ success: true, data: all });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/entries  { date, name, place, amount, type, mode, purpose, notes, sentBy, bankAccount }
router.post("/entries", async (req, res) => {
  const { date, name, place, amount, type, mode, purpose, notes, sentBy, bankAccount } = req.body;
  if (!date || !name || !amount || !type) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }
  const table = type.toUpperCase() === "CREDIT" ? "credit_ledger" : "debit_ledger";
  const lastCol = type.toUpperCase() === "CREDIT" ? "available_balance" : "status";
  const lastVal = type.toUpperCase() === "CREDIT" ? amount : "OWN ACCOUNT";
  try {
    const [result] = await pool.query(
      `INSERT INTO ${table} (date, name, place, amount, mode, purpose, sent_by, bank_name, note, timestamp, ${lastCol})
       VALUES (?,?,?,?,?,?,?,?,?,NOW(),?)`,
      [date, (name || "").toUpperCase(), (place || "").toUpperCase(), amount, (mode || "").toUpperCase(),
       (purpose || "").toUpperCase(), (sentBy || "").toUpperCase(), (bankAccount || "").toUpperCase(),
       (notes || "").toUpperCase(), lastVal]
    );
    res.json({ success: true, data: { id: result.insertId } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/monthly-report", async (req, res) => {
  const { month, year } = req.query;
  try {
    const [credit] = await pool.query(
      `SELECT * FROM credit_ledger WHERE MONTH(date) = ? AND YEAR(date) = ? ORDER BY date ASC`, [month, year]
    );
    const [debit] = await pool.query(
      `SELECT * FROM debit_ledger WHERE MONTH(date) = ? AND YEAR(date) = ? ORDER BY date ASC`, [month, year]
    );
    const creditTotal = credit.reduce((s, r) => s + Number(r.amount), 0);
    const debitTotal = debit.reduce((s, r) => s + Number(r.amount), 0);
    res.json({ success: true, data: { creditData: credit, debitData: debit, creditTotal, debitTotal } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
