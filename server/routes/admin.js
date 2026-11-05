const express = require('express');
const router = express.Router();
const db = require('../db');
const { verifyToken, isAdmin } = require('../middleware/auth');
const { getQuickPayBalance } = require('../quickpay');

// Apply admin verification middleware to all routes here
router.use(verifyToken, isAdmin);

/**
 * 1. Admin Dashboard Statistics
 * Returns QuickPay live balance, user total balances, profit, today's transactions
 */
router.get('/dashboard-stats', async (req, res) => {
  try {
    // 1. Fetch live balance from QuickPay API
    const quickpayBalanceData = await getQuickPayBalance();

    // 2. Fetch User Balances (Total liability)
    const userWalletStats = db.prepare(`
      SELECT 
        COUNT(id) as total_users,
        COALESCE(SUM(wallet_balance), 0) as total_user_balances,
        COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) as active_users,
        COALESCE(SUM(CASE WHEN status = 'pending_fee' THEN 1 ELSE 0 END), 0) as pending_fee_users
      FROM users 
      WHERE role = 'user'
    `).get();

    // 3. Financial & Reload Metrics
    const financialStats = db.prepare(`
      SELECT 
        COALESCE(SUM(CASE WHEN type = 'reload' AND status = 'success' THEN amount ELSE 0 END), 0) as total_reloaded_volume,
        COALESCE(SUM(CASE WHEN type = 'reload' AND status = 'success' THEN profit_amount ELSE 0 END), 0) as total_net_profit,
        COALESCE(SUM(CASE WHEN type = 'cashback' AND status = 'success' THEN amount ELSE 0 END), 0) as total_cashback_given,
        COALESCE(SUM(CASE WHEN type = 'fee' AND status = 'success' THEN amount ELSE 0 END), 0) as total_reg_fees_collected,
        COUNT(CASE WHEN type = 'reload' AND status = 'success' THEN 1 END) as total_successful_reloads,
        COUNT(CASE WHEN type = 'reload' AND status = 'failed' THEN 1 END) as total_failed_reloads
      FROM transactions
    `).get();

    // 4. Pending Top-up Requests count
    const pendingTopupsCount = db.prepare(`
      SELECT COUNT(id) as count FROM topup_requests WHERE status = 'pending'
    `).get();

    // 5. Recent 10 Transactions
    const recentTransactions = db.prepare(`
      SELECT t.id, t.type, t.amount, t.provider_code, t.phone_number, t.status, t.cashback_amount, t.profit_amount, t.created_at, u.name as user_name, u.phone as user_phone
      FROM transactions t
      JOIN users u ON t.user_id = u.id
      ORDER BY t.id DESC
      LIMIT 10
    `).all();

    res.json({
      quickpay: quickpayBalanceData,
      users: userWalletStats,
      finances: financialStats,
      pendingTopupsCount: pendingTopupsCount.count,
      recentTransactions
    });
  } catch (err) {
    console.error('Admin Dashboard Stats Error:', err);
    res.status(500).json({ error: 'Failed to compute admin dashboard statistics.' });
  }
});

/**
 * 2. Provider Management (Commissions & Cashbacks)
 */
router.get('/providers', (req, res) => {
  try {
    const providers = db.prepare(`
      SELECT id, code, name, category, quickpay_code, quickpay_commission, cashback_rate, 
             ROUND(quickpay_commission - cashback_rate, 2) as net_profit_margin,
             is_active, min_amount, max_amount
      FROM providers
      ORDER BY category ASC, name ASC
    `).all();

    res.json(providers);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch providers for admin.' });
  }
});

// Update Provider Commissions, Cashback rates, or Status
router.put('/providers/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { quickpay_commission, cashback_rate, is_active, min_amount, max_amount, quickpay_code } = req.body;

    const comm = parseFloat(quickpay_commission);
    const cb = parseFloat(cashback_rate);

    if (isNaN(comm) || isNaN(cb) || comm < 0 || cb < 0) {
      return res.status(400).json({ error: 'Invalid commission or cashback rate.' });
    }

    if (cb > comm) {
      return res.status(400).json({ 
        error: `Customer cashback (${cb}%) cannot exceed incoming QuickPay commission (${comm}%). Otherwise you will incur a loss.` 
      });
    }

    db.prepare(`
      UPDATE providers 
      SET quickpay_commission = ?, cashback_rate = ?, is_active = ?, min_amount = ?, max_amount = ?, quickpay_code = ?
      WHERE id = ?
    `).run(comm, cb, is_active ? 1 : 0, parseFloat(min_amount || 50), parseFloat(max_amount || 10000), quickpay_code || '', id);

    res.json({ success: true, message: 'Provider rates updated successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update provider rates.' });
  }
});

/**
 * 3. User Management
 */
router.get('/users', (req, res) => {
  try {
    const { search = '', status = 'all' } = req.query;
    
    let query = `
      SELECT id, name, email, phone, role, wallet_balance, reg_fee_paid, status, created_at,
        (SELECT COUNT(id) FROM transactions WHERE user_id = users.id AND type = 'reload' AND status = 'success') as reloads_count,
        (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE user_id = users.id AND type = 'reload' AND status = 'success') as total_spent
      FROM users
      WHERE role = 'user'
    `;
    const params = [];

    if (search) {
      query += ` AND (name LIKE ? OR email LIKE ? OR phone LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (status !== 'all') {
      query += ` AND status = ?`;
      params.push(status);
    }

    query += ` ORDER BY id DESC`;

    const users = db.prepare(query).all(...params);
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch users list.' });
  }
});

// Manual Wallet Top-up / Adjustment by Admin
router.post('/users/:id/topup', (req, res) => {
  try {
    const { id } = req.params;
    const { amount, type = 'credit', reason = 'Admin Top-up' } = req.body;
    const topupAmount = parseFloat(amount);

    if (isNaN(topupAmount) || topupAmount <= 0) {
      return res.status(400).json({ error: 'Please enter a valid amount.' });
    }

    const user = db.prepare(`SELECT id, name, wallet_balance FROM users WHERE id = ?`).get(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (type === 'debit' && user.wallet_balance < topupAmount) {
      return res.status(400).json({ error: `Cannot debit. User only has LKR ${user.wallet_balance.toFixed(2)}.` });
    }

    const newBalance = type === 'credit' ? user.wallet_balance + topupAmount : user.wallet_balance - topupAmount;

    db.transaction(() => {
      db.prepare(`UPDATE users SET wallet_balance = ? WHERE id = ?`).run(newBalance, id);

      db.prepare(`
        INSERT INTO transactions (user_id, type, amount, status, remarks)
        VALUES (?, ?, ?, 'success', ?)
      `).run(id, type === 'credit' ? 'topup' : 'fee', topupAmount, `${reason} (Processed by Admin)`);
    })();

    res.json({
      success: true,
      message: `Successfully ${type === 'credit' ? 'credited' : 'debited'} LKR ${topupAmount.toFixed(2)} to ${user.name}'s wallet.`,
      newBalance
    });
  } catch (err) {
    console.error('Admin Topup Error:', err);
    res.status(500).json({ error: 'Failed to adjust user wallet.' });
  }
});

// Update Full User Details (Name, Phone, Email, Direct Balance, Status, Fee)
router.put('/users/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, phone, wallet_balance, status, reg_fee_paid } = req.body;

    const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    db.prepare(`
      UPDATE users 
      SET name = COALESCE(?, name),
          email = COALESCE(?, email),
          phone = COALESCE(?, phone),
          wallet_balance = COALESCE(?, wallet_balance),
          status = COALESCE(?, status),
          reg_fee_paid = COALESCE(?, reg_fee_paid)
      WHERE id = ?
    `).run(
      name !== undefined ? name : null, 
      email !== undefined ? email : null, 
      phone !== undefined ? phone : null, 
      wallet_balance !== undefined ? parseFloat(wallet_balance) : null,
      status !== undefined ? status : null, 
      reg_fee_paid !== undefined ? (reg_fee_paid ? 1 : 0) : null, 
      id
    );

    res.json({ success: true, message: 'User details updated successfully!' });
  } catch (err) {
    console.error('Update user error:', err);
    res.status(500).json({ error: 'Failed to update user details.' });
  }
});

// Get User Specific Transactions
router.get('/users/:id/transactions', (req, res) => {
  try {
    const { id } = req.params;
    const transactions = db.prepare(`
      SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC
    `).all(id);
    res.json(transactions);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user transactions.' });
  }
});

// Edit Transaction Record (Status, Amount, Cashback, Remarks)
router.put('/transactions/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { status, amount, cashback_amount, profit_amount, remarks } = req.body;

    db.prepare(`
      UPDATE transactions
      SET status = COALESCE(?, status),
          amount = COALESCE(?, amount),
          cashback_amount = COALESCE(?, cashback_amount),
          profit_amount = COALESCE(?, profit_amount),
          remarks = COALESCE(?, remarks)
      WHERE id = ?
    `).run(
      status !== undefined ? status : null, 
      amount !== undefined ? parseFloat(amount) : null,
      cashback_amount !== undefined ? parseFloat(cashback_amount) : null,
      profit_amount !== undefined ? parseFloat(profit_amount) : null,
      remarks !== undefined ? remarks : null, 
      id
    );

    res.json({ success: true, message: 'Transaction record updated successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update transaction.' });
  }
});

// Delete Transaction Record
router.delete('/transactions/:id', (req, res) => {
  try {
    const { id } = req.params;
    db.prepare(`DELETE FROM transactions WHERE id = ?`).run(id);
    res.json({ success: true, message: 'Transaction record deleted.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete transaction.' });
  }
});

// Update User Status (Activate, Suspend, Mark Fee Paid)
router.put('/users/:id/status', (req, res) => {
  try {
    const { id } = req.params;
    const { status, reg_fee_paid } = req.body;

    const user = db.prepare(`SELECT id FROM users WHERE id = ?`).get(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    db.prepare(`
      UPDATE users 
      SET status = COALESCE(?, status), 
          reg_fee_paid = COALESCE(?, reg_fee_paid)
      WHERE id = ?
    `).run(status, reg_fee_paid !== undefined ? (reg_fee_paid ? 1 : 0) : null, id);

    res.json({ success: true, message: 'User status updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update user status.' });
  }
});

/**
 * 4. Top-up Slip Requests
 */
router.get('/topup-requests', (req, res) => {
  try {
    const requests = db.prepare(`
      SELECT r.id, r.amount, r.payment_method, r.reference_no, r.slip_url, r.status, r.admin_note, r.created_at,
             u.id as user_id, u.name as user_name, u.phone as user_phone, u.wallet_balance
      FROM topup_requests r
      JOIN users u ON r.user_id = u.id
      ORDER BY CASE WHEN r.status = 'pending' THEN 1 ELSE 2 END, r.id DESC
      LIMIT 100
    `).all();

    res.json(requests);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch top-up requests.' });
  }
});

// Approve or Reject Top-up Request
router.post('/topup-requests/:id/action', (req, res) => {
  try {
    const { id } = req.params;
    const { action, note = '' } = req.body; // 'approve' or 'reject'

    const request = db.prepare(`SELECT * FROM topup_requests WHERE id = ?`).get(id);
    if (!request) {
      return res.status(404).json({ error: 'Top-up request not found.' });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({ error: `Request is already ${request.status}.` });
    }

    if (action === 'approve') {
      db.transaction(() => {
        // Check if this was a registration fee payment or regular wallet top-up
        if (request.payment_method === 'reg_fee_bank') {
          db.prepare(`UPDATE users SET reg_fee_paid = 1, status = 'active' WHERE id = ?`).run(request.user_id);
          db.prepare(`
            INSERT INTO transactions (user_id, type, amount, status, remarks)
            VALUES (?, 'fee', ?, 'success', 'Registration Fee Verified via Bank Slip')
          `).run(request.user_id, request.amount);
        } else {
          // Normal wallet top-up
          db.prepare(`UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?`).run(request.amount, request.user_id);
          db.prepare(`
            INSERT INTO transactions (user_id, type, amount, status, remarks)
            VALUES (?, 'topup', ?, 'success', ?)
          `).run(request.user_id, request.amount, `Bank Transfer Top-up [Ref: ${request.reference_no}]`);
        }

        db.prepare(`
          UPDATE topup_requests 
          SET status = 'approved', admin_note = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(note || 'Approved by Admin', id);
      })();

      return res.json({ success: true, message: 'Top-up request approved and wallet balance updated!' });
    } else if (action === 'reject') {
      db.prepare(`
        UPDATE topup_requests 
        SET status = 'rejected', admin_note = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(note || 'Rejected by Admin', id);

      return res.json({ success: true, message: 'Top-up request rejected.' });
    } else {
      return res.status(400).json({ error: 'Invalid action. Must be approve or reject.' });
    }
  } catch (err) {
    console.error('Topup Action Error:', err);
    res.status(500).json({ error: 'Failed to process top-up action.' });
  }
});

/**
 * 5. All Transactions Audit Log
 */
router.get('/transactions', (req, res) => {
  try {
    const { page = 1, limit = 50, type = 'all', status = 'all' } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT t.*, u.name as user_name, u.phone as user_phone
      FROM transactions t
      JOIN users u ON t.user_id = u.id
      WHERE 1=1
    `;
    const params = [];

    if (type !== 'all') {
      query += ` AND t.type = ?`;
      params.push(type);
    }
    if (status !== 'all') {
      query += ` AND t.status = ?`;
      params.push(status);
    }

    query += ` ORDER BY t.id DESC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), parseInt(offset));

    const transactions = db.prepare(query).all(...params);
    res.json(transactions);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch transaction logs.' });
  }
});

/**
 * 6. System Settings & Credentials
 */
router.get('/settings', (req, res) => {
  try {
    const rows = db.prepare(`SELECT key, value FROM settings`).all();
    const settings = {};
    for (const r of rows) {
      if (r.key === 'bank_account_details') {
        try { settings[r.key] = JSON.parse(r.value); } catch(e) { settings[r.key] = r.value; }
      } else {
        settings[r.key] = r.value;
      }
    }
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch settings.' });
  }
});

router.post('/settings', (req, res) => {
  try {
    const { 
      registration_fee, 
      require_registration_fee, 
      quickpay_mid, 
      quickpay_secretkey, 
      quickpay_api_url, 
      simulation_mode, 
      bank_account_details 
    } = req.body;

    const upsert = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`);

    db.transaction(() => {
      if (registration_fee !== undefined) upsert.run('registration_fee', String(registration_fee));
      if (require_registration_fee !== undefined) upsert.run('require_registration_fee', String(require_registration_fee));
      if (quickpay_mid !== undefined) upsert.run('quickpay_mid', String(quickpay_mid));
      if (quickpay_secretkey !== undefined) upsert.run('quickpay_secretkey', String(quickpay_secretkey));
      if (quickpay_api_url !== undefined) upsert.run('quickpay_api_url', String(quickpay_api_url));
      if (simulation_mode !== undefined) upsert.run('simulation_mode', String(simulation_mode));
      if (bank_account_details !== undefined) upsert.run('bank_account_details', JSON.stringify(bank_account_details));
    })();

    res.json({ success: true, message: 'Settings saved successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save settings.' });
  }
});

module.exports = router;

