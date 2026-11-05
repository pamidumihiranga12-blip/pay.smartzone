const express = require('express');
const router = express.Router();
const db = require('../db');
const { verifyToken } = require('../middleware/auth');
const { executeRecharge, checkRechargeStatus } = require('../quickpay');

// Process a Mobile / Bill Recharge
router.post('/process', verifyToken, async (req, res) => {
  try {
    const { providerCode, phoneNumber, amount } = req.body;
    const userId = req.user.id;
    const reloadAmount = parseFloat(amount);

    if (!providerCode || !phoneNumber || isNaN(reloadAmount) || reloadAmount <= 0) {
      return res.status(400).json({ error: 'Please provide provider, valid phone/account number, and amount.' });
    }

    // 1. Fetch current user data and check registration fee & status
    const user = db.prepare(`SELECT id, wallet_balance, reg_fee_paid, status FROM users WHERE id = ?`).get(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (user.status !== 'active') {
      return res.status(403).json({ 
        error: 'Your account is pending registration fee verification. Please complete registration fee to enable reloads.',
        status: user.status
      });
    }

    // 2. Fetch provider configuration
    const provider = db.prepare(`SELECT * FROM providers WHERE code = ? AND is_active = 1`).get(providerCode);
    if (!provider) {
      return res.status(400).json({ error: 'Selected provider is not available or inactive.' });
    }

    if (reloadAmount < provider.min_amount || reloadAmount > provider.max_amount) {
      return res.status(400).json({ 
        error: `Amount must be between LKR ${provider.min_amount.toFixed(2)} and LKR ${provider.max_amount.toFixed(2)}.` 
      });
    }

    // 3. Check wallet balance
    if (user.wallet_balance < reloadAmount) {
      return res.status(400).json({ 
        error: `Insufficient wallet balance. You have LKR ${user.wallet_balance.toFixed(2)}, but need LKR ${reloadAmount.toFixed(2)}.` 
      });
    }

    // 4. Generate reference number
    const refNo = `QP${Date.now()}${Math.floor(Math.random() * 1000)}`;

    // 5. Calculate cashback and platform net profit
    const cashbackAmount = parseFloat(((reloadAmount * provider.cashback_rate) / 100).toFixed(2));
    const incomingCommission = parseFloat(((reloadAmount * provider.quickpay_commission) / 100).toFixed(2));
    const profitAmount = parseFloat((incomingCommission - cashbackAmount).toFixed(2));

    // 6. Atomic Transaction: Deduct balance & record pending transaction
    const deductStmt = db.prepare(`UPDATE users SET wallet_balance = wallet_balance - ? WHERE id = ?`);
    const insertTxStmt = db.prepare(`
      INSERT INTO transactions (user_id, type, amount, net_amount, provider_code, phone_number, quickpay_refno, status, cashback_amount, profit_amount, remarks)
      VALUES (?, 'reload', ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `);

    let txId;
    const executeDeduction = db.transaction(() => {
      deductStmt.run(reloadAmount, userId);
      const result = insertTxStmt.run(
        userId,
        reloadAmount,
        reloadAmount - cashbackAmount,
        provider.code,
        phoneNumber,
        refNo,
        cashbackAmount,
        profitAmount,
        `Reload for ${phoneNumber} (${provider.name})`
      );
      txId = result.lastInsertRowid;
    });

    executeDeduction();

    // 7. Call QuickPay API
    const qpResult = await executeRecharge({
      number: phoneNumber,
      amount: reloadAmount,
      providerCode: provider.quickpay_code,
      refNo: refNo
    });

    if (qpResult.success) {
      // 8. On Success:
      // - Credit cashback directly to user wallet
      // - Record cashback transaction
      // - Mark reload transaction as success
      const updateSuccess = db.transaction(() => {
        // Update reload transaction
        db.prepare(`
          UPDATE transactions 
          SET status = 'success', quickpay_rid = ?, remarks = ?
          WHERE id = ?
        `).run(qpResult.rid || '', `Reload Successful [Ref: ${refNo}]`, txId);

        // Credit cashback if greater than 0
        if (cashbackAmount > 0) {
          db.prepare(`UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?`).run(cashbackAmount, userId);

          db.prepare(`
            INSERT INTO transactions (user_id, type, amount, provider_code, phone_number, quickpay_refno, status, remarks)
            VALUES (?, 'cashback', ?, ?, ?, ?, 'success', ?)
          `).run(userId, cashbackAmount, provider.code, phoneNumber, refNo, `Instant Cashback (${provider.cashback_rate}%) on ${provider.name} Reload`);
        }
      });

      updateSuccess();

      const updatedUser = db.prepare(`SELECT wallet_balance FROM users WHERE id = ?`).get(userId);

      return res.json({
        success: true,
        message: `Reload of LKR ${reloadAmount.toFixed(2)} was successful!`,
        refNo,
        quickpayRid: qpResult.rid,
        cashbackEarned: cashbackAmount,
        newBalance: updatedUser.wallet_balance
      });
    } else {
      // 9. On Failure:
      // Auto-refund deducted reload amount back to user's wallet immediately
      const handleFailure = db.transaction(() => {
        db.prepare(`UPDATE users SET wallet_balance = wallet_balance + ? WHERE id = ?`).run(reloadAmount, userId);
        
        db.prepare(`
          UPDATE transactions 
          SET status = 'failed', remarks = ?
          WHERE id = ?
        `).run(`Failed: ${qpResult.reason || 'Declined by Gateway'} (Amount Refunded)`, txId);
      });

      handleFailure();

      const refundedUser = db.prepare(`SELECT wallet_balance FROM users WHERE id = ?`).get(userId);

      return res.status(400).json({
        success: false,
        error: `Reload failed: ${qpResult.reason || 'Provider declined request'}. Your money (LKR ${reloadAmount.toFixed(2)}) has been refunded to your wallet.`,
        refunded: true,
        currentBalance: refundedUser.wallet_balance
      });
    }
  } catch (err) {
    console.error('Reload Execution Error:', err);
    res.status(500).json({ error: 'Server error processing reload. If funds were deducted, please contact support.' });
  }
});

// Check status of a specific recharge
router.get('/status/:refNo', verifyToken, async (req, res) => {
  try {
    const { refNo } = req.params;
    const tx = db.prepare(`SELECT * FROM transactions WHERE quickpay_refno = ? AND user_id = ?`).get(refNo, req.user.id);

    if (!tx) {
      return res.status(404).json({ error: 'Transaction record not found.' });
    }

    const qpStatus = await checkRechargeStatus({ refNo, rid: tx.quickpay_rid });
    res.json({ transaction: tx, liveStatus: qpStatus });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check status.' });
  }
});

module.exports = router;

