const express = require("express");
const router = express.Router();
const pool = require("../db");

// ═══════════════════════════════════════════════════════════════════════
// LEDGER ENGINE
// Mirrors the (now-fixed) logic from the Rent module:
//  - `principal` on the loans row is the ORIGINAL amount and is NEVER
//    written to again — it's the fallback rate basis for every month
//    before the first part-payment/rate-revision took effect.
//  - Interest rate is resolved per-month from loan_rate_history (most
//    recent effective_date <= that month), falling back to the loan's
//    original interest_rate.
//  - Each payment is matched to the exact month it was recorded for
//    (month_label). Only unlabeled/generic payments pool together and
//    get applied oldest-unpaid-month-first — this is what stops a
//    skipped month from being silently absorbed by a later payment.
// ═══════════════════════════════════════════════════════════════════════

function monthKey(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
}
function monthLabel(key) {
  if (!key) return "";
  const MN = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const [y, m] = key.split("-");
  return `${MN[Number(m) - 1]} ${y}`;
}
function addMonths(date, n) {
  const d = new Date(date);
  return new Date(d.getFullYear(), d.getMonth() + n, d.getDate());
}
function truncMonth(date) {
  const d = new Date(date);
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

async function buildLoanLedger(loanId) {
  const [[loan]] = await pool.query(`SELECT * FROM loans WHERE id = ?`, [loanId]);
  if (!loan) return null;

  const [rateRows] = await pool.query(
    `SELECT effective_date, rate FROM loan_rate_history WHERE loan_id = ? ORDER BY effective_date ASC`, [loanId]
  );
  const [principalRows] = await pool.query(
    `SELECT date, amount, mode FROM loan_principal_payments WHERE loan_id = ? ORDER BY date ASC`, [loanId]
  );
  const [interestRows] = await pool.query(
    `SELECT date, amount, mode, month_label, note FROM loan_interest_payments WHERE loan_id = ? ORDER BY date ASC`, [loanId]
  );

  const disburseDate = new Date(loan.disburse_date);
  const originalPrincipal = Number(loan.principal);
  const originalRate = Number(loan.interest_rate);
  const today = new Date();
  const isClosed = loan.status === "CLOSED";
  const effectiveEnd = isClosed && loan.closed_date ? new Date(loan.closed_date) : today;

  const totalPartPaid = principalRows.reduce((s, r) => s + Number(r.amount), 0);
  const currentPrincipal = Math.max(originalPrincipal - totalPartPaid, 0);

  const currentRateEntry = rateRows.filter(r => new Date(r.effective_date) <= today).slice(-1)[0];
  const currentRate = currentRateEntry ? Number(currentRateEntry.rate) : originalRate;

  // Rate applicable for a given cycle's month (month-truncated comparison,
  // same convention as Rent's rentTimeline lookup).
  function rateForCycle(cycleStart) {
    const cur = truncMonth(cycleStart);
    const applicable = rateRows.filter(r => truncMonth(r.effective_date) <= cur);
    return applicable.length ? Number(applicable[applicable.length - 1].rate) : originalRate;
  }
  // Principal outstanding as of a given date (reducing-balance: interest
  // each month is charged on whatever's left after part-payments so far).
  function principalAsOf(date) {
    const paid = principalRows.filter(r => new Date(r.date) <= date).reduce((s, r) => s + Number(r.amount), 0);
    return Math.max(originalPrincipal - paid, 0);
  }

  // Split payments into label-matched vs generic pool, per month key.
  const paidByLabel = {};
  let genericCredit = 0;
  interestRows.forEach(r => {
    const amt = Number(r.amount);
    if (r.month_label && r.month_label.trim()) {
      paidByLabel[r.month_label] = (paidByLabel[r.month_label] || 0) + amt;
    } else {
      genericCredit += amt;
    }
  });

  const cycleDay = disburseDate.getDate();
  let totalM = (effectiveEnd.getFullYear() - disburseDate.getFullYear()) * 12 + (effectiveEnd.getMonth() - disburseDate.getMonth());
  if (effectiveEnd.getDate() < cycleDay) totalM -= 1;
  if (totalM < 0) totalM = 0;

  let credit = genericCredit;
  const unpaidMonths = [];
  const paidMonthKeys = [];
  const partialMonths = {};
  let totalInterestGenerated = 0;

  for (let i = 0; i < totalM; i++) {
    const cycleStart = new Date(disburseDate.getFullYear(), disburseDate.getMonth() + i, cycleDay);
    const cycleEnd = new Date(disburseDate.getFullYear(), disburseDate.getMonth() + i + 1, cycleDay);
    const rate = rateForCycle(cycleStart);
    const principalAtPoint = principalAsOf(cycleEnd);
    const cycleInterest = Math.floor(principalAtPoint * (rate / 100));
    if (cycleInterest <= 0) continue;
    totalInterestGenerated += cycleInterest;

    const key = monthKey(cycleStart);
    const labeledPaid = paidByLabel[key] || 0;

    if (labeledPaid >= cycleInterest) {
      credit += (labeledPaid - cycleInterest);
      paidMonthKeys.push(key);
    } else {
      const remaining = cycleInterest - labeledPaid;
      if (credit >= remaining) {
        credit -= remaining;
        paidMonthKeys.push(key);
      } else {
        const due = remaining - credit;
        credit = 0;
        unpaidMonths.push({ key, label: monthLabel(key), amount: due, rate, cycleStart: cycleStart.toISOString().slice(0, 10), cycleEnd: cycleEnd.toISOString().slice(0, 10) });
        if (labeledPaid > 0 || due < cycleInterest) partialMonths[key] = labeledPaid;
      }
    }
  }

  const pendingInterest = unpaidMonths.reduce((s, m) => s + m.amount, 0);
  const totalInterestPaid = interestRows.reduce((s, r) => s + Number(r.amount), 0);

  return {
    id: loan.id, loanCode: loan.loan_code, borrowerName: loan.borrower_name, borrowerMobile: loan.borrower_mobile,
    disburseDate: loan.disburse_date, originalPrincipal, currentPrincipal, originalRate, currentRate,
    mode: loan.mode, purpose: loan.purpose, suretyName: loan.surety_name, notes: loan.notes,
    status: loan.status, closedDate: loan.closed_date,
    unpaidMonths, paidMonthKeys, partialMonths, pendingInterest,
    totalOutstanding: currentPrincipal + pendingInterest,
    totalInterestGenerated, totalInterestPaid, totalPartPaid,
    rateHistory: rateRows, principalPayments: principalRows, interestPayments: interestRows
  };
}

// ── LIST / SEARCH ──────────────────────────────────────────────────────
router.get("/loans", async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, loan_code, borrower_name, borrower_mobile, principal, interest_rate, disburse_date, status FROM loans ORDER BY created_at DESC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/loans/next-code", async (req, res) => {
  try {
    const [[row]] = await pool.query(`SELECT loan_code FROM loans ORDER BY id DESC LIMIT 1`);
    let next = 1;
    if (row && row.loan_code) {
      const m = row.loan_code.match(/\d+/);
      if (m) next = parseInt(m[0]) + 1;
    }
    res.json({ success: true, data: { loanCode: "L" + String(next).padStart(4, "0") } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── DASHBOARD ───────────────────────────────────────────────────────────
router.get("/loans/dashboard", async (req, res) => {
  try {
    const [loans] = await pool.query(`SELECT * FROM loans`);
    let totalPrincipal = 0, activeCount = 0, closedCount = 0, monthlyInterestIncome = 0, totalInterestCollected = 0;
    const dueList = [];

    for (const loan of loans) {
      const ledger = await buildLoanLedger(loan.id);
      if (loan.status === "ACTIVE") {
        totalPrincipal += ledger.currentPrincipal;
        activeCount++;
        monthlyInterestIncome += Math.floor(ledger.currentPrincipal * (ledger.currentRate / 100));
        if (ledger.pendingInterest > 0) {
          dueList.push({
            id: loan.id, loanCode: loan.loan_code, borrowerName: loan.borrower_name,
            monthsPending: ledger.unpaidMonths.length,
            monthlyAmount: Math.floor(ledger.currentPrincipal * (ledger.currentRate / 100)),
            totalDue: ledger.pendingInterest
          });
        }
      } else {
        closedCount++;
      }
      totalInterestCollected += ledger.totalInterestPaid;
    }

    res.json({
      success: true,
      data: { totalPrincipal, activeCount, closedCount, monthlyInterestIncome, totalInterestCollected, dueList }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── LOAN DETAILS (ledger) ──────────────────────────────────────────────
router.get("/loans/:id", async (req, res) => {
  try {
    const ledger = await buildLoanLedger(req.params.id);
    if (!ledger) return res.status(404).json({ success: false, error: "Loan not found" });
    res.json({ success: true, data: ledger });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── STATEMENT (chronological transaction list) ─────────────────────────
router.get("/loans/:id/statement", async (req, res) => {
  try {
    const ledger = await buildLoanLedger(req.params.id);
    if (!ledger) return res.status(404).json({ success: false, error: "Loan not found" });

    let txns = [];
    txns.push({ date: ledger.disburseDate, type: "Disbursement", debit: ledger.originalPrincipal, credit: 0 });
    ledger.rateHistory.forEach(r => txns.push({ date: r.effective_date, type: "Rate Revision", debit: 0, credit: 0, note: `Rate changed to ${r.rate}%` }));
    ledger.principalPayments.forEach(p => txns.push({ date: p.date, type: "Part Payment", debit: 0, credit: Number(p.amount), mode: p.mode }));
    ledger.interestPayments.forEach(p => txns.push({ date: p.date, type: "Interest Payment", debit: 0, credit: Number(p.amount), mode: p.mode, monthLabel: monthLabel(p.month_label), note: p.note }));
    // Show generated monthly interest charges too, for a full running balance
    ledger.unpaidMonths.forEach(m => txns.push({ date: m.cycleEnd, type: "Interest Charged", debit: m.amount, credit: 0, note: m.label + " (unpaid)" }));

    txns.sort((a, b) => new Date(a.date) - new Date(b.date));
    let running = 0;
    txns = txns.map(t => {
      running += (t.debit || 0) - (t.credit || 0);
      return { ...t, outstanding: Math.max(running, 0) };
    });

    res.json({ success: true, data: { loanCode: ledger.loanCode, borrowerName: ledger.borrowerName, transactions: txns } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── DISBURSE NEW LOAN ───────────────────────────────────────────────────
router.post("/loans", async (req, res) => {
  const { loanCode, borrowerName, borrowerMobile, principal, interestRate, disburseDate, mode, purpose, suretyName, notes } = req.body;
  if (!loanCode || !borrowerName || !principal || !interestRate || !disburseDate) {
    return res.status(400).json({ success: false, error: "Missing required fields" });
  }
  try {
    const [result] = await pool.query(
      `INSERT INTO loans (loan_code, borrower_name, borrower_mobile, principal, interest_rate, disburse_date, mode, purpose, surety_name, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [loanCode, borrowerName.toUpperCase(), borrowerMobile || "", Number(principal), Number(interestRate), disburseDate,
       (mode || "CASH").toUpperCase(), (purpose || "").toUpperCase(), (suretyName || "").toUpperCase(), (notes || "").toUpperCase()]
    );
    res.json({ success: true, data: { id: result.insertId, loanCode } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── REVISE INTEREST RATE ────────────────────────────────────────────────
router.post("/loans/:id/rate-revision", async (req, res) => {
  const { effectiveDate, rate } = req.body;
  if (!effectiveDate || rate === undefined || rate === null || rate === "") {
    return res.status(400).json({ success: false, error: "Effective date and new rate are required" });
  }
  try {
    await pool.query(
      `INSERT INTO loan_rate_history (loan_id, effective_date, rate) VALUES (?,?,?)`,
      [req.params.id, effectiveDate, Number(rate)]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── COLLECT INTEREST PAYMENT (one or more months in one call) ──────────
// body: { date, mode, note, items: [{ monthKey, amount }] }
router.post("/loans/:id/interest-payment", async (req, res) => {
  const { date, mode, note, items } = req.body;
  if (!date || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, error: "Date and at least one month/amount are required" });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const item of items) {
      const amt = Number(item.amount);
      if (amt <= 0) continue;
      await conn.query(
        `INSERT INTO loan_interest_payments (loan_id, date, amount, mode, month_label, note) VALUES (?,?,?,?,?,?)`,
        [req.params.id, date, amt, (mode || "CASH").toUpperCase(), item.monthKey || null, (note || "").toUpperCase()]
      );
    }
    await conn.commit();
    res.json({ success: true });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, error: err.message });
  } finally {
    conn.release();
  }
});

// ── PART PAYMENT (principal reduction) ──────────────────────────────────
router.post("/loans/:id/principal-payment", async (req, res) => {
  const { date, amount, mode } = req.body;
  if (!date || !amount || Number(amount) <= 0) {
    return res.status(400).json({ success: false, error: "Date and a valid amount are required" });
  }
  try {
    const ledger = await buildLoanLedger(req.params.id);
    if (!ledger) return res.status(404).json({ success: false, error: "Loan not found" });
    if (ledger.pendingInterest > 0) {
      return res.status(400).json({ success: false, error: `Clear pending interest of ₹${ledger.pendingInterest} first` });
    }
    if (Number(amount) > ledger.currentPrincipal) {
      return res.status(400).json({ success: false, error: "Amount exceeds outstanding principal" });
    }
    await pool.query(
      `INSERT INTO loan_principal_payments (loan_id, date, amount, mode) VALUES (?,?,?,?)`,
      [req.params.id, date, Number(amount), (mode || "CASH").toUpperCase()]
    );
    const updated = await buildLoanLedger(req.params.id);
    res.json({ success: true, data: { newBalance: updated.currentPrincipal } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── CLOSE LOAN ───────────────────────────────────────────────────────────
router.post("/loans/:id/close", async (req, res) => {
  try {
    const ledger = await buildLoanLedger(req.params.id);
    if (!ledger) return res.status(404).json({ success: false, error: "Loan not found" });
    if (ledger.totalOutstanding > 0) {
      return res.status(400).json({ success: false, error: `Cannot close — ₹${ledger.totalOutstanding} still outstanding` });
    }
    await pool.query(`UPDATE loans SET status='CLOSED', closed_date=CURDATE() WHERE id=?`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
