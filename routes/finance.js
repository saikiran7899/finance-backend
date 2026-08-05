const express = require("express");
const router = express.Router();
const pool = require("../db");

// GET /api/entries?fromDate=&toDate=&keyword=
router.get("/entries", async (req, res) => {
  const { fromDate = "1970-01-01", toDate = "2099-12-31", keyword = "" } = req.query;
  try {
    const [credit] = await pool.query(
      `SELECT id, date, name, place, amount, 'CREDIT' as type, mode, purpose, sent_by, bank_name, note,
              available_balance as status_or_balance, drive_link, serial_no
       FROM credit_ledger WHERE date BETWEEN ? AND ? ORDER BY date DESC`,
      [fromDate, toDate]
    );
    const [debit] = await pool.query(
      `SELECT id, date, name, place, amount, 'DEBIT' as type, mode, purpose, sent_by, bank_name, note,
              status as status_or_balance, drive_link, serial_no
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

// GET /api/fund-sources — active credit entries with balance left, for the Debit fund-source picker
router.get("/fund-sources", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT serial_no, name, available_balance, purpose, date FROM credit_ledger WHERE available_balance > 0 ORDER BY date DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/entries
// { date, name, place, amount, type, mode, purpose, notes, sentBy, bankAccount, fundSourceId, billImageUrl }
// fundSourceId: "OWN" | credit_ledger id | array of ids — same as your original Apps Script logic
// billImageUrl: comma-separated Cloudinary URL(s), already uploaded by the app before this call
router.post("/entries", async (req, res) => {
  const { date, name, place, amount, type, mode, purpose, notes, sentBy, bankAccount, fundSourceId, billImageUrl } = req.body;
  if (!date || !name || !amount || !type) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const isCredit = type.toUpperCase() === "CREDIT";
    let finalSourceInfo = "OWN ACCOUNT";

    if (!isCredit && fundSourceId && fundSourceId !== "OWN") {
      // Same deduction logic as your original addEntry(): spend down selected
      // credit sources in order, spill over to the next if one runs short.
      let remainingToDeduct = Number(amount);
      let sourcesUsed = [];
      const sourceIds = Array.isArray(fundSourceId) ? fundSourceId : [fundSourceId];

      for (const rowId of sourceIds) {
        if (rowId === "OWN" || remainingToDeduct <= 0) continue;

        const [rows] = await conn.query(
          `SELECT name, available_balance, date FROM credit_ledger WHERE serial_no = ? FOR UPDATE`,
          [rowId]
        );
        if (rows.length === 0) continue;
        const { name: sName, available_balance: availBal, date: sDate } = rows[0];

        if (Number(availBal) > 0) {
          const deduction = Math.min(remainingToDeduct, Number(availBal));
          const newBalance = Number(availBal) - deduction;

          await conn.query(`UPDATE credit_ledger SET available_balance = ? WHERE serial_no = ?`, [newBalance, rowId]);

          const d = new Date(sDate);
          const localDateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          sourcesUsed.push(`${sName} (₹${deduction} on ${localDateStr} #${rowId})`);
          remainingToDeduct -= deduction;
        }
      }

      if (remainingToDeduct > 0.01) {
        await conn.rollback();
        return res.status(400).json({ success: false, error: "Insufficient balance in selected fund source(s)" });
      }
      finalSourceInfo = sourcesUsed.length === 1 ? "LINKED: " + sourcesUsed[0] : "LINKED: COMBINED- " + sourcesUsed.join(", ");
    }

    const table = isCredit ? "credit_ledger" : "debit_ledger";
    const lastCol = isCredit ? "available_balance" : "status";
    const lastVal = isCredit ? amount : finalSourceInfo;

    // Assign the next gap-free serial number for this table (separate from
    // the permanent, never-reused `id` used for linking).
    const [serialRows] = await conn.query(
      `SELECT COALESCE(MAX(serial_no), 0) + 1 AS nextSerial FROM ${table}`
    );
    const nextSerial = serialRows[0].nextSerial;

    const [result] = await conn.query(
      `INSERT INTO ${table} (date, name, place, amount, mode, purpose, sent_by, bank_name, note, timestamp, ${lastCol}, drive_link, serial_no)
       VALUES (?,?,?,?,?,?,?,?,?,NOW(),?,?,?)`,
      [date, (name || "").toUpperCase(), (place || "").toUpperCase(), amount, (mode || "").toUpperCase(),
       (purpose || "").toUpperCase(), (sentBy || "").toUpperCase(), (bankAccount || "").toUpperCase(),
       (notes || "").toUpperCase(), lastVal, billImageUrl || "", nextSerial]
    );

    await conn.commit();
    res.json({ success: true, data: { id: result.insertId, serialNo: nextSerial, sourceInfo: finalSourceInfo } });
  } catch (err) {
    console.error("POST /api/entries failed:", err);
    await conn.rollback();
    res.status(500).json({ success: false, error: err.message });
  } finally {
    conn.release();
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

// PUT /api/entries/:type/:id — edits an existing entry's basic fields.
// Note: this does NOT recompute fund-source balances if you change the
// amount on a linked debit — that linkage is only calculated at creation.
router.put("/entries/:type/:id", async (req, res) => {
  const { type, id } = req.params;
  const { date, name, place, amount, mode, purpose, notes, sentBy, bankAccount } = req.body;
  const table = type.toUpperCase() === "CREDIT" ? "credit_ledger" : "debit_ledger";
  try {
    await pool.query(
      `UPDATE ${table} SET date=?, name=?, place=?, amount=?, mode=?, purpose=?, sent_by=?, bank_name=?, note=? WHERE id=?`,
      [date, (name || "").toUpperCase(), (place || "").toUpperCase(), amount, (mode || "").toUpperCase(),
       (purpose || "").toUpperCase(), (sentBy || "").toUpperCase(), (bankAccount || "").toUpperCase(),
       (notes || "").toUpperCase(), id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/entries/:type/:id  — type is "CREDIT" or "DEBIT"
router.delete("/entries/:type/:id", async (req, res) => {
  const { type, id } = req.params;
  const table = type.toUpperCase() === "CREDIT" ? "credit_ledger" : "debit_ledger";
  try {
    await pool.query(`DELETE FROM ${table} WHERE id = ?`, [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
