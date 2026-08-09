const express = require("express");
const router = express.Router();
const pool = require("../db");

const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function fmtDateISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── DASHBOARD — the core dues engine ─────────────────────────────────────
// Ported directly from the original getSystemData(): rent cycles are
// anchored to each tenant's move-in DAY (not the calendar month), rent
// revisions apply per-cycle based on rent_history, and payments are
// credited against the oldest unpaid cycle first.
router.get("/rent/dashboard", async (req, res) => {
  try {
    const [rollRows] = await pool.query("SELECT * FROM rent_roll ORDER BY property, room");
    const [historyRows] = await pool.query("SELECT * FROM rent_history");

    const rentTimeline = {}; // tenant_id -> [{effDate, amount}]
    historyRows.forEach(h => {
      const tId = String(h.tenant_id).trim();
      if (!rentTimeline[tId]) rentTimeline[tId] = [];
      rentTimeline[tId].push({ effDate: new Date(h.effective_date), amount: Number(h.new_rent) });
    });

    const today = new Date();
    let stats = { filled: 0, vacant: 0, totalDue: 0 };
    const rooms = [];

    rollRows.forEach(r => {
      const isOccupied = r.status === "Occupied" && r.occ_date;
      let unpaidMonths = [];
      let balance = 0;

      if (isOccupied) {
        stats.filled++;
        const occDate = new Date(r.occ_date);
        const startYear = occDate.getFullYear();
        const startMonth = occDate.getMonth();
        const cycleDay = occDate.getDate();
        const dd = String(cycleDay).padStart(2, "0");

        let totalM = (today.getFullYear() - startYear) * 12 + (today.getMonth() - startMonth);
        if (today.getDate() < cycleDay) totalM -= 1;
        if (totalM < 0) totalM = 0;

        let credit = Number(r.paid) || 0;
        const baseRent = Number(r.base_rent) || 0;
        const tId = String(r.tenant_id || "").trim();

        for (let i = 0; i < totalM; i++) {
          const cycleStart = new Date(startYear, startMonth + i, cycleDay);
          let ar = baseRent;
          if (rentTimeline[tId]) {
            const cur = new Date(cycleStart.getFullYear(), cycleStart.getMonth(), 1);
            const applicable = rentTimeline[tId]
              .filter(h => new Date(h.effDate.getFullYear(), h.effDate.getMonth(), 1) <= cur)
              .sort((a, b) => b.effDate - a.effDate);
            if (applicable.length > 0) ar = applicable[0].amount;
          }
          const label = `${dd} ${MONTH_ABBR[cycleStart.getMonth()]} ${cycleStart.getFullYear()}`;
          if (credit >= ar && ar > 0) {
            credit -= ar;
          } else {
            const due = ar - credit;
            unpaidMonths.push(`${label} - ₹${due}`);
            balance += due;
            credit = 0;
          }
        }
        stats.totalDue += balance;
      } else {
        stats.vacant++;
      }

      rooms.push({
        property: r.property, room: r.room, status: r.status,
        tenantId: r.tenant_id, tenantName: r.tenant_name, mobile: r.mobile,
        age: r.age, idProofLinks: r.id_proof_links, address: r.address,
        rent: Number(r.base_rent) || 0,
        occDate: r.occ_date ? fmtDateISO(new Date(r.occ_date)) : null,
        paid: Number(r.paid) || 0, advance: Number(r.advance) || 0,
        balance, unpaidMonths
      });
    });

    const [propRows] = await pool.query("SELECT name, rooms FROM rent_properties ORDER BY name");
    const properties = propRows.map(p => ({ name: p.name, rooms: (p.rooms || "").split(",").map(r => r.trim()).filter(Boolean) }));

    res.json({ success: true, data: { stats, rooms, properties } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── PROPERTIES ────────────────────────────────────────────────────────────
router.post("/rent/properties", async (req, res) => {
  const { name, rooms } = req.body; // rooms: array of room numbers
  if (!name || !Array.isArray(rooms) || rooms.length === 0) {
    return res.status(400).json({ success: false, error: "Property name and at least one room required" });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const roomsStr = rooms.join(",");
    await conn.query(
      "INSERT INTO rent_properties (name, rooms) VALUES (?, ?) ON DUPLICATE KEY UPDATE rooms = VALUES(rooms)",
      [name.trim(), roomsStr]
    );
    // Every room needs a rent_roll row so it shows up (Vacant by default)
    // even if it's never had a tenant yet.
    for (const room of rooms) {
      await conn.query(
        "INSERT IGNORE INTO rent_roll (property, room, status) VALUES (?, ?, 'Vacant')",
        [name.trim(), room.trim()]
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

// ── NEXT TENANT ID (live check — mirrors Finance's serial number pattern) ──
router.get("/rent/next-tenant-id", async (req, res) => {
  try {
    let maxId = 0;
    const [a] = await pool.query("SELECT tenant_id FROM rent_roll WHERE tenant_id IS NOT NULL");
    const [b] = await pool.query("SELECT tenant_id FROM rent_tenants_history");
    [...a, ...b].forEach(row => {
      const idStr = String(row.tenant_id || "");
      if (idStr.includes("-")) {
        const n = parseInt(idStr.split("-")[1], 10);
        if (!isNaN(n) && n > maxId) maxId = n;
      }
    });
    res.json({ success: true, data: { nextId: "T-" + String(maxId + 1).padStart(4, "0") } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── REGISTER TENANT ──────────────────────────────────────────────────────
router.post("/rent/tenants", async (req, res) => {
  const { tenantId, property, room, name, mobile, age, address, idProofUrl, rent, advanceMonths, occDate, payMode, enteredBy } = req.body;
  if (!tenantId || !property || !room || !name || !occDate || !rent) {
    return res.status(400).json({ success: false, error: "Missing required tenant fields" });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [existingRows] = await conn.query(
      "SELECT status FROM rent_roll WHERE property = ? AND room = ? FOR UPDATE", [property, room]
    );
    if (existingRows.length > 0 && existingRows[0].status === "Occupied") {
      await conn.rollback();
      return res.status(400).json({ success: false, error: `Room ${room} is already occupied.` });
    }

    const advance = Number(rent) * Number(advanceMonths || 0);
    const nameUpper = name.trim().toUpperCase();

    await conn.query(
      `INSERT INTO rent_roll (property, room, status, tenant_id, tenant_name, mobile, age, id_proof_links, address, base_rent, occ_date, paid, advance, entered_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE status=VALUES(status), tenant_id=VALUES(tenant_id), tenant_name=VALUES(tenant_name),
         mobile=VALUES(mobile), age=VALUES(age), id_proof_links=VALUES(id_proof_links), address=VALUES(address),
         base_rent=VALUES(base_rent), occ_date=VALUES(occ_date), paid=0, advance=VALUES(advance), entered_by=VALUES(entered_by)`,
      [property, room, "Occupied", tenantId, nameUpper, mobile || "", age || "", idProofUrl || "", address || "",
       Number(rent), occDate, 0, advance, enteredBy || "Unknown"]
    );

    await conn.query(
      `INSERT INTO rent_transactions (date, tenant_id, tenant_name, property, room, type, amount, mode, month_label, entered_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [occDate, tenantId, nameUpper, property, room, "Security Deposit", advance, payMode || "Cash", "Occupied", enteredBy || "Unknown"]
    );

    await conn.commit();
    res.json({ success: true, data: { tenantId } });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, error: err.message });
  } finally {
    conn.release();
  }
});

// ── UPDATE TENANT DETAILS ────────────────────────────────────────────────
router.put("/rent/tenants/:tenantId", async (req, res) => {
  const { name, mobile, age, address, idProofUrl } = req.body;
  try {
    const fields = ["tenant_name = ?", "mobile = ?", "age = ?", "address = ?"];
    const params = [(name || "").toUpperCase(), mobile || "", age || "", address || ""];
    if (idProofUrl !== undefined) {
      fields.push("id_proof_links = ?");
      params.push(idProofUrl);
    }
    params.push(req.params.tenantId);
    await pool.query(`UPDATE rent_roll SET ${fields.join(", ")} WHERE tenant_id = ?`, params);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── PROCESS PAYMENT ───────────────────────────────────────────────────────
router.post("/rent/payments", async (req, res) => {
  const { property, room, amount, date, mode, monthLabel, enteredBy } = req.body;
  if (!property || !room || !amount) return res.status(400).json({ success: false, error: "Missing payment fields" });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      "SELECT tenant_id, tenant_name, paid FROM rent_roll WHERE property = ? AND room = ? FOR UPDATE", [property, room]
    );
    if (rows.length === 0) { await conn.rollback(); return res.status(400).json({ success: false, error: "Room not found" }); }
    const { tenant_id, tenant_name, paid } = rows[0];
    await conn.query("UPDATE rent_roll SET paid = ? WHERE property = ? AND room = ?", [Number(paid) + Number(amount), property, room]);

    const payDate = date || fmtDateISO(new Date());
    await conn.query(
      `INSERT INTO rent_transactions (date, tenant_id, tenant_name, property, room, type, amount, mode, month_label, entered_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [payDate, tenant_id, tenant_name, property, room, "Rent Payment", Number(amount), mode || "Cash", monthLabel || "Rent", enteredBy || "Unknown"]
    );
    await conn.commit();
    res.json({ success: true });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, error: err.message });
  } finally {
    conn.release();
  }
});

// ── VACATE ─────────────────────────────────────────────────────────────
router.post("/rent/vacate", async (req, res) => {
  const { property, room, enteredBy } = req.body;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query("SELECT * FROM rent_roll WHERE property = ? AND room = ? FOR UPDATE", [property, room]);
    if (rows.length === 0 || rows[0].status !== "Occupied") {
      await conn.rollback();
      return res.status(400).json({ success: false, error: "No active tenant in this room" });
    }
    const r = rows[0];
    const today = fmtDateISO(new Date());

    await conn.query(
      `INSERT INTO rent_tenants_history (tenant_id, property, room, name, mobile, move_in, move_out, total_paid)
       VALUES (?,?,?,?,?,?,?,?)`,
      [r.tenant_id, property, room, r.tenant_name, r.mobile, r.occ_date, today, r.paid]
    );
    await conn.query(
      `INSERT INTO rent_transactions (date, tenant_id, tenant_name, property, room, type, amount, mode, month_label, entered_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [today, r.tenant_id, r.tenant_name, property, room, "Vacate / Final Settlement", 0, "", "", enteredBy || "Unknown"]
    );
    await conn.query(
      `UPDATE rent_roll SET status='Vacant', tenant_id=NULL, tenant_name=NULL, mobile=NULL, age=NULL,
       id_proof_links=NULL, address=NULL, base_rent=0, occ_date=NULL, paid=0, advance=0 WHERE property=? AND room=?`,
      [property, room]
    );
    await conn.commit();
    res.json({ success: true, data: { tenantName: r.tenant_name } });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ success: false, error: err.message });
  } finally {
    conn.release();
  }
});

// ── BULK RENT REVISION ────────────────────────────────────────────────────
router.post("/rent/rent-history", async (req, res) => {
  const { updates } = req.body; // [{tenantId, property, room, effDate, newRent}]
  if (!Array.isArray(updates) || updates.length === 0) return res.status(400).json({ success: false, error: "No updates provided" });
  try {
    for (const u of updates) {
      await pool.query(
        "INSERT INTO rent_history (tenant_id, property, room, effective_date, new_rent) VALUES (?,?,?,?,?)",
        [u.tenantId, u.property, u.room, u.effDate, Number(u.newRent)]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── TRANSACTIONS (history) ────────────────────────────────────────────────
router.get("/rent/transactions", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM rent_transactions ORDER BY date DESC, id DESC");
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── MAINTENANCE ────────────────────────────────────────────────────────────
router.post("/rent/maintenance", async (req, res) => {
  const { date, property, room, category, description, amount, mode, billLink, enteredBy } = req.body;
  if (!date || !property || !amount) return res.status(400).json({ success: false, error: "Missing maintenance fields" });
  try {
    await pool.query(
      `INSERT INTO rent_maintenance (date, property, room, category, description, amount, mode, bill_link, entered_by)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [date, property, room || "Common", category, description || "", Number(amount), mode || "Cash", billLink || "", enteredBy || "Unknown"]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/rent/maintenance", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM rent_maintenance ORDER BY date DESC, id DESC");
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── UTILITY METERS ─────────────────────────────────────────────────────────
router.post("/rent/utility-meters", async (req, res) => {
  const { type, property, rooms, usc, serviceNo, refNo, lastAmount, notes } = req.body;
  if (!type || !property) return res.status(400).json({ success: false, error: "Missing meter fields" });
  const isElec = type === "Electricity";
  const lookupKey = (isElec ? usc : refNo || "").trim();
  if (!lookupKey) return res.status(400).json({ success: false, error: "Meter/account number required" });
  try {
    const [existing] = await pool.query(
      `SELECT id FROM rent_utility_meters WHERE type=? AND property=? AND ${isElec ? "usc" : "ref_no"} = ?`,
      [type, property, lookupKey]
    );
    if (existing.length > 0) {
      await pool.query(
        "UPDATE rent_utility_meters SET rooms=?, last_amount=?, notes=? WHERE id=?",
        [rooms || "", Number(lastAmount) || 0, notes || "", existing[0].id]
      );
    } else {
      await pool.query(
        `INSERT INTO rent_utility_meters (type, property, rooms, usc, service_no, ref_no, last_amount, notes)
         VALUES (?,?,?,?,?,?,?,?)`,
        [type, property, rooms || "", isElec ? usc : "", isElec ? (serviceNo || "") : "", !isElec ? refNo : "", Number(lastAmount) || 0, notes || ""]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/rent/utility-meters", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM rent_utility_meters ORDER BY property, type");
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── BILL STATUS ────────────────────────────────────────────────────────────
router.post("/rent/bill-status", async (req, res) => {
  const { meterKey, month, year, amount, status, updatedBy } = req.body;
  if (!meterKey || !month || !year || !status) return res.status(400).json({ success: false, error: "Missing bill status fields" });
  try {
    const mm = String(month).padStart(2, "0");
    const amt = status === "Not Paid" ? (Number(amount) || 0) : 0;
    await pool.query(
      `INSERT INTO rent_bill_history (meter_key, month, year, amount, status, updated_by)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE amount=VALUES(amount), status=VALUES(status), updated_by=VALUES(updated_by), updated_at=CURRENT_TIMESTAMP`,
      [meterKey, mm, String(year), amt, status, updatedBy || "Unknown"]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/rent/bill-history", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM rent_bill_history");
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
