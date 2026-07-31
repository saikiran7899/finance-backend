const mysql = require("mysql2/promise");

// Points at your EXISTING Aiven MySQL database — same tables your
// original Apps Script used (credit_ledger, debit_ledger, reminders,
// products, service_history, daily_notes). No new schema needed.
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 15537,
  database: process.env.DB_NAME || "defaultdb",
  user: process.env.DB_USER || "avnadmin",
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false }, // Aiven requires SSL
  waitForConnections: true,
  connectionLimit: 5
});

module.exports = pool;
