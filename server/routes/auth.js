const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { verifyToken, JWT_SECRET } = require('../middleware/auth');

// Register a new user
router.post('/register', async (req, res) => {
  try {
    const name = (req.body.name || '').toString().trim();
    const email = (req.body.email || '').toString().trim().toLowerCase();
    const phone = (req.body.phone || '').toString().trim();
    const password = req.body.password ? req.body.password.toString() : '';

    if (!name || !email || !phone || !password) {
      return res.status(400).json({ error: 'Please provide all required fields (name, email, phone, password).' });
    }

    // Check unique email and phone
    const existing = db.prepare(`SELECT id, email, phone FROM users WHERE LOWER(email) = LOWER(?) OR phone = ?`).get(email, phone);
    if (existing) {
      if (existing.email.toLowerCase() === email) {
        return res.status(400).json({ error: 'An account with this email already exists.' });
      }
      return res.status(400).json({ error: 'An account with this phone number already exists.' });
    }

    // Check registration fee requirement
    const requireFeeSetting = db.prepare(`SELECT value FROM settings WHERE key = 'require_registration_fee'`).get();
    const feeSetting = db.prepare(`SELECT value FROM settings WHERE key = 'registration_fee'`).get();
    const regFeeAmount = parseFloat(feeSetting?.value || '500');
    const requireFee = requireFeeSetting?.value === 'true';

    const salt = bcrypt.genSaltSync(10);
    const hashedPassword = bcrypt.hashSync(password, salt);

    const initialStatus = requireFee ? 'pending_fee' : 'active';
    const regFeePaid = requireFee ? 0 : 1;

    const result = db.prepare(`
      INSERT INTO users (name, email, phone, password, role, wallet_balance, reg_fee_paid, status)
      VALUES (?, ?, ?, ?, 'user', 0.0, ?, ?)
    `).run(name, email, phone, hashedPassword, regFeePaid, initialStatus);

    const newUser = db.prepare(`SELECT id, name, email, phone, role, wallet_balance, reg_fee_paid, status FROM users WHERE id = ?`).get(result.lastInsertRowid);

    const token = jwt.sign({ id: newUser.id, role: newUser.role }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({
      message: 'Account created successfully!',
      token,
      user: newUser,
      registrationFee: {
        required: requireFee,
        amount: regFeeAmount,
        status: newUser.status
      }
    });
  } catch (err) {
    console.error('Registration Error:', err);
    res.status(500).json({ error: 'Internal server error during registration.' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const rawLogin = req.body.login || req.body.email || req.body.phone || req.body.username || '';
    const login = rawLogin.toString().trim();
    const password = req.body.password ? req.body.password.toString() : '';

    if (!login || !password) {
      return res.status(400).json({ error: 'Please provide email/phone and password.' });
    }

    const user = db.prepare(`SELECT * FROM users WHERE LOWER(email) = LOWER(?) OR phone = ?`).get(login, login);
    if (!user) {
      return res.status(401).json({ error: 'Invalid login credentials.' });
    }

    const isMatch = bcrypt.compareSync(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid login credentials.' });
    }

    if (user.status === 'suspended') {
      return res.status(403).json({ error: 'Your account has been suspended by the administrator.' });
    }

    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });

    // Clean user object
    delete user.password;

    res.json({
      message: 'Logged in successfully',
      token,
      user
    });
  } catch (err) {
    console.error('Login Error:', err);
    res.status(500).json({ error: 'Internal server error during login.' });
  }
});

// Get current logged-in user profile
router.get('/me', verifyToken, (req, res) => {
  const feeSetting = db.prepare(`SELECT value FROM settings WHERE key = 'registration_fee'`).get();
  const bankDetails = db.prepare(`SELECT value FROM settings WHERE key = 'bank_account_details'`).get();

  res.json({
    user: req.user,
    registrationFeeAmount: parseFloat(feeSetting?.value || '500'),
    bankDetails: bankDetails ? JSON.parse(bankDetails.value) : null
  });
});

// Pay Registration Fee (Direct or Slip upload)
router.post('/pay-registration-fee', verifyToken, (req, res) => {
  try {
    const { referenceNo, slipUrl, method } = req.body;
    const user = req.user;

    if (user.reg_fee_paid === 1 && user.status === 'active') {
      return res.status(400).json({ message: 'Registration fee is already paid.' });
    }

    const feeSetting = db.prepare(`SELECT value FROM settings WHERE key = 'registration_fee'`).get();
    const feeAmount = parseFloat(feeSetting?.value || '500');

    // If method is 'instant_wallet' and user has balance
    if (method === 'wallet') {
      if (user.wallet_balance < feeAmount) {
        return res.status(400).json({ error: 'Insufficient wallet balance to pay registration fee.' });
      }

      // Deduct from wallet and activate
      db.prepare(`UPDATE users SET wallet_balance = wallet_balance - ?, reg_fee_paid = 1, status = 'active' WHERE id = ?`).run(feeAmount, user.id);

      db.prepare(`
        INSERT INTO transactions (user_id, type, amount, status, remarks)
        VALUES (?, 'fee', ?, 'success', 'One-time Account Registration Fee')
      `).run(user.id, feeAmount);

      return res.json({
        success: true,
        message: 'Registration fee paid successfully! Your account is now active.',
        status: 'active'
      });
    }

    // Otherwise record bank slip upload request for admin verification
    db.prepare(`
      INSERT INTO topup_requests (user_id, amount, payment_method, reference_no, slip_url, status, admin_note)
      VALUES (?, ?, 'reg_fee_bank', ?, ?, 'pending', 'User submitted registration fee verification')
    `).run(user.id, feeAmount, referenceNo || 'N/A', slipUrl || '');

    res.json({
      success: true,
      message: 'Your registration payment slip has been submitted for admin approval. Your account will be activated shortly!',
      status: 'pending_verification'
    });
  } catch (err) {
    console.error('Pay Reg Fee Error:', err);
    res.status(500).json({ error: 'Failed to process registration fee payment.' });
  }
});

module.exports = router;

