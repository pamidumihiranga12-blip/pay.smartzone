const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const config = {
  host: process.env.DB_HOST || 'sdb-84.hosting.stackcp.net',
  user: process.env.DB_USER || 'smartzonepay-35303936e725',
  password: process.env.DB_PASSWORD || 'smartzone12345',
  database: process.env.DB_NAME || 'smartzonepay-35303936e725',
  port: parseInt(process.env.DB_PORT || '3306'),
  connectTimeout: 10000
};

async function migrate() {
  console.log(`Connecting to MySQL at ${config.host} (DB: ${config.database})...`);
  let connection;

  try {
    connection = await mysql.createConnection(config);
    console.log('✓ Connected to MySQL database successfully!');

    // 1. Create settings table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS settings (
        \`key\` VARCHAR(191) PRIMARY KEY,
        \`value\` TEXT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 2. Create users table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(191) UNIQUE NOT NULL,
        phone VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(50) DEFAULT 'user',
        wallet_balance DECIMAL(12,2) DEFAULT 0.00,
        reg_fee_paid TINYINT(1) DEFAULT 0,
        status VARCHAR(50) DEFAULT 'pending_fee',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 3. Create providers table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS providers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        category VARCHAR(50) DEFAULT 'mobile',
        quickpay_code VARCHAR(50) NOT NULL,
        quickpay_commission DECIMAL(5,2) DEFAULT 5.00,
        cashback_rate DECIMAL(5,2) DEFAULT 2.00,
        is_active TINYINT(1) DEFAULT 1,
        min_amount DECIMAL(10,2) DEFAULT 50.00,
        max_amount DECIMAL(10,2) DEFAULT 10000.00,
        icon VARCHAR(255) DEFAULT ''
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 4. Create transactions table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        type VARCHAR(50) NOT NULL,
        amount DECIMAL(12,2) NOT NULL,
        net_amount DECIMAL(12,2) DEFAULT 0.00,
        provider_code VARCHAR(50),
        phone_number VARCHAR(100),
        quickpay_rid VARCHAR(100),
        quickpay_refno VARCHAR(100),
        status VARCHAR(50) DEFAULT 'pending',
        cashback_amount DECIMAL(10,2) DEFAULT 0.00,
        profit_amount DECIMAL(10,2) DEFAULT 0.00,
        remarks TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX(user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 5. Create topup_requests table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS topup_requests (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        amount DECIMAL(12,2) NOT NULL,
        payment_method VARCHAR(50) DEFAULT 'bank_transfer',
        reference_no VARCHAR(255),
        slip_url TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        admin_note TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX(user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // 6. Seed Admin
    const adminEmail = 'smartzonelk101@gmail.com';
    const adminPhone = '0786800086';
    const adminPass = 'Smartzoneadmin@123';
    const hashedPassword = bcrypt.hashSync(adminPass, 10);

    const [adminRows] = await connection.query(`SELECT id FROM users WHERE email = ?`, [adminEmail]);
    if (adminRows.length === 0) {
      await connection.query(`
        INSERT INTO users (name, email, phone, password, role, wallet_balance, reg_fee_paid, status)
        VALUES (?, ?, ?, ?, 'admin', 100000.00, 1, 'active')
      `, ['SMARTZONE LK Admin', adminEmail, adminPhone, hashedPassword]);
      console.log(`✓ Seeded Admin: ${adminEmail}`);
    } else {
      await connection.query(`
        UPDATE users SET password = ?, role = 'admin', status = 'active', phone = ? WHERE email = ?
      `, [hashedPassword, adminPhone, adminEmail]);
      console.log(`✓ Updated Admin: ${adminEmail}`);
    }

    console.log('🎉 MySQL schema migration completed successfully!');
  } catch (err) {
    console.error('Migration Error:', err.message);
  } finally {
    if (connection) await connection.end();
  }
}

migrate();

