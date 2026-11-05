const express = require('express');
const router = express.Router();
const db = require('../db');
const { verifyToken } = require('../middleware/auth');

// Get wallet details, balance, and transaction history
router.get('/', verifyToken, (req, res) => {
  try {
    const user = db.prepare(`SELECT id, wallet_balance, reg_fee_paid, status FROM users WHERE id = ?`).get(req.user.id);
    
    const transactions = db.prepare(`
      SELECT id, type, amount, net_amount, provider_code, phone_number, status, cashback_amount, remarks, created_at
      FROM transactions
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT 50
    `).all(req.user.id);

    // Summary stats for user
    const stats = db.prepare(`
      SELECT 
        COALESCE(SUM(CASE WHEN type = 'reload' AND status = 'success' THEN amount ELSE 0 END), 0) as total_reloaded,
        COALESCE(SUM(CASE WHEN type = 'cashback' AND status = 'success' THEN amount ELSE 0 END), 0) as total_cashback_earned
      FROM transactions
      WHERE user_id = ?
    `).get(req.user.id);

    res.json({
      balance: user.wallet_balance,
      regFeePaid: user.reg_fee_paid === 1,
      status: user.status,
      transactions,
      stats
    });
  } catch (err) {
    console.error('Wallet fetch error:', err);
    res.status(500).json({ error: 'Failed to retrieve wallet details.' });
  }
});

// Request top-up via bank transfer / slip
router.post('/topup-request', verifyToken, (req, res) => {
  try {
    const { amount, referenceNo, slipUrl, paymentMethod = 'bank_transfer' } = req.body;
    const topupAmount = parseFloat(amount);

    if (isNaN(topupAmount) || topupAmount <= 0) {
      return res.status(400).json({ error: 'Please enter a valid top-up amount.' });
    }

    if (topupAmount < 100) {
      return res.status(400).json({ error: 'Minimum top-up amount is LKR 100.00' });
    }

    const result = db.prepare(`
      INSERT INTO topup_requests (user_id, amount, payment_method, reference_no, slip_url, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `).run(req.user.id, topupAmount, paymentMethod, referenceNo || 'Direct Deposit', slipUrl || '');

    res.status(201).json({
      success: true,
      message: 'Top-up request submitted successfully! Your wallet balance will be updated once approved by admin.',
      requestId: result.lastInsertRowid
    });
  } catch (err) {
    console.error('Topup request error:', err);
    res.status(500).json({ error: 'Failed to submit top-up request.' });
  }
});

// Get Bank Account details for deposit
router.get('/bank-details', verifyToken, (req, res) => {
  try {
    const bankDetails = db.prepare(`SELECT value FROM settings WHERE key = 'bank_account_details'`).get();
    res.json(bankDetails ? JSON.parse(bankDetails.value) : {});
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch bank details.' });
  }
});

module.exports = router;

