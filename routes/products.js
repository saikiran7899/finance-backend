const express = require("express");
const router = express.Router();
const pool = require("../db");

router.get("/products", async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT * FROM products ORDER BY purchase_date DESC`);
    const data = rows.map(p => ({
      ...p,
      isWarrantyValid: p.warranty_expiry ? new Date(p.warranty_expiry) > new Date() : false
    }));
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/products", async (req, res) => {
  const { productName, brand, purchaseDate, amount, mode, warrantyExpiry, notes, billImageUrl } = req.body;
  if (!productName) return res.status(400).json({ success: false, error: "Product name required" });
  try {
    const [result] = await pool.query(
      `INSERT INTO products (product_name, brand, purchase_date, amount, mode, warranty_expiry, notes, bill_link)
       VALUES (?,?,?,?,?,?,?,?)`,
      [productName.toUpperCase(), (brand || "").toUpperCase(), purchaseDate || null, amount || 0, mode || "", warrantyExpiry || null, notes || "", billImageUrl || ""]
    );
    res.json({ success: true, data: { id: result.insertId } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete("/products/:id", async (req, res) => {
  try {
    await pool.query(`DELETE FROM service_history WHERE product_id=?`, [req.params.id]);
    await pool.query(`DELETE FROM products WHERE id=?`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/products/:id/service-history", async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT * FROM service_history WHERE product_id=? ORDER BY service_date DESC`, [req.params.id]);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/products/:id/service-history", async (req, res) => {
  const { serviceDate, description, mode, amount, warrantyPeriod, notes, billImageUrl } = req.body;
  if (!description) return res.status(400).json({ success: false, error: "Description required" });
  try {
    const [result] = await pool.query(
      `INSERT INTO service_history (product_id, service_date, description, mode, amount, warranty_period, notes, bill_link)
       VALUES (?,?,?,?,?,?,?,?)`,
      [req.params.id, serviceDate || null, description, mode || "", amount || 0, warrantyPeriod || "", notes || "", billImageUrl || ""]
    );
    res.json({ success: true, data: { id: result.insertId } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete("/products/:productId/service-history/:id", async (req, res) => {
  try {
    await pool.query(`DELETE FROM service_history WHERE id=?`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;

