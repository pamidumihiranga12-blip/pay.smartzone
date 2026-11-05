const express = require('express');
const router = express.Router();
const db = require('../db');
const { detectProviderFromNumber } = require('../quickpay');

// Get all active providers for users
router.get('/', (req, res) => {
  try {
    const providers = db.prepare(`
      SELECT code, name, category, quickpay_code, cashback_rate, min_amount, max_amount, icon 
      FROM providers 
      WHERE is_active = 1
      ORDER BY category ASC, name ASC
    `).all();

    res.json(providers);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch providers.' });
  }
});

// Auto detect provider by number prefix
router.get('/detect', (req, res) => {
  const { number } = req.query;
  if (!number) {
    return res.status(400).json({ error: 'Phone number is required.' });
  }

  const detectedCode = detectProviderFromNumber(number);
  if (!detectedCode) {
    return res.json({ detected: false, provider: null });
  }

  const provider = db.prepare(`
    SELECT code, name, category, cashback_rate, min_amount, max_amount, icon 
    FROM providers 
    WHERE code = ? AND is_active = 1
  `).get(detectedCode);

  res.json({
    detected: !!provider,
    provider: provider || null
  });
});

module.exports = router;

