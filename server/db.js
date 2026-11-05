const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.join(__dirname, '..', 'data.sqlite');
const db = new DatabaseSync(dbPath);

// Transaction helper for DatabaseSync
db.transaction = function(fn) {
  return function(...args) {
    db.exec('BEGIN TRANSACTION');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      throw err;
    }
  };
};

function initDatabase() {
  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      wallet_balance REAL DEFAULT 0.0,
      reg_fee_paid INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending_fee',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      category TEXT DEFAULT 'mobile',
      quickpay_code TEXT NOT NULL,
      quickpay_commission REAL DEFAULT 5.0,
      cashback_rate REAL DEFAULT 2.0,
      is_active INTEGER DEFAULT 1,
      min_amount REAL DEFAULT 50.0,
      max_amount REAL DEFAULT 10000.0,
      icon TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL, -- 'reload', 'cashback', 'topup', 'fee', 'refund'
      amount REAL NOT NULL,
      net_amount REAL DEFAULT 0.0,
      provider_code TEXT,
      phone_number TEXT,
      quickpay_rid TEXT,
      quickpay_refno TEXT,
      status TEXT DEFAULT 'pending', -- 'success', 'pending', 'failed'
      cashback_amount REAL DEFAULT 0.0,
      profit_amount REAL DEFAULT 0.0,
      remarks TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS topup_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      payment_method TEXT DEFAULT 'bank_transfer',
      reference_no TEXT,
      slip_url TEXT,
      status TEXT DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
      admin_note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
  `);

  // Default settings
  const insertSetting = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
  insertSetting.run('registration_fee', '500');
  insertSetting.run('require_registration_fee', 'true');
  insertSetting.run('admin_whatsapp', '0786800086');
  insertSetting.run('quickpay_mid', 'OTk0ODAw');
  insertSetting.run('quickpay_secretkey', '5c83f283655d39ab8876');
  insertSetting.run('quickpay_api_url', 'http://secure.quickpay.lk/api/');
  insertSetting.run('simulation_mode', 'false');
  insertSetting.run('bank_account_details', JSON.stringify({
    bank: "Bank of Ceylon (BOC)",
    account_name: "SMARTZONE LK",
    account_number: "8934521782",
    branch: "Colombo Fort",
    whatsapp: "0786800086"
  }));

  // Clean old demo admin if any
  db.prepare(`DELETE FROM users WHERE email = 'admin@quickpay.lk'`).run();

  // Seed / Update Official Admin User requested by USER
  const adminEmail = 'smartzonelk101@gmail.com';
  const adminPhone = '0786800086';
  const adminPass = 'Smartzoneadmin@123';
  const salt = bcrypt.genSaltSync(10);
  const hashedPassword = bcrypt.hashSync(adminPass, salt);

  const adminExists = db.prepare(`SELECT id FROM users WHERE email = ?`).get(adminEmail);
  if (!adminExists) {
    db.prepare(`
      INSERT INTO users (name, email, phone, password, role, wallet_balance, reg_fee_paid, status)
      VALUES (?, ?, ?, ?, 'admin', 100000.0, 1, 'active')
    `).run('SMARTZONE LK Admin', adminEmail, adminPhone, hashedPassword);
    console.log(`Seeded Official Admin: ${adminEmail}`);
  } else {
    db.prepare(`UPDATE users SET password = ?, role = 'admin', status = 'active', phone = ? WHERE email = ?`)
      .run(hashedPassword, adminPhone, adminEmail);
    console.log(`Updated Official Admin credentials for: ${adminEmail}`);
  }

  // Seed default providers in Sri Lanka
  const defaultProviders = [
    { code: 'DLG', name: 'Dialog Mobile', category: 'mobile', quickpay_code: 'RA', comm: 5.5, cashback: 2.0 },
    { code: 'MOB', name: 'Mobitel', category: 'mobile', quickpay_code: 'RM', comm: 6.0, cashback: 2.5 },
    { code: 'HTC', name: 'Hutch', category: 'mobile', quickpay_code: 'RH', comm: 7.0, cashback: 3.0 },
    { code: 'AIR', name: 'Airtel', category: 'mobile', quickpay_code: 'RAI', comm: 6.5, cashback: 2.5 },
    { code: 'DTV', name: 'Dialog Television', category: 'tv', quickpay_code: 'RDTV', comm: 3.0, cashback: 1.0 },
    { code: 'SLT', name: 'SLT Broadband/PeoTV', category: 'utility', quickpay_code: 'RSLT', comm: 2.0, cashback: 0.5 },
    { code: 'CEB', name: 'CEB Electricity Bill', category: 'utility', quickpay_code: 'RCEB', comm: 1.5, cashback: 0.5 },
    { code: 'WTR', name: 'National Water Board', category: 'utility', quickpay_code: 'RWTR', comm: 1.5, cashback: 0.5 },
  ];

  const insertProvider = db.prepare(`
    INSERT OR IGNORE INTO providers (code, name, category, quickpay_code, quickpay_commission, cashback_rate, is_active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `);

  for (const p of defaultProviders) {
    const existing = db.prepare(`SELECT id FROM providers WHERE code = ?`).get(p.code);
    if (!existing) {
      insertProvider.run(p.code, p.name, p.category, p.quickpay_code, p.comm, p.cashback);
    }
  }

  console.log('Database initialized successfully with SmartZone admin and settings.');
}

initDatabase();

module.exports = db;
