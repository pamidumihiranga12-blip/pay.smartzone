const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

// Ensure db is initialized
require('./db');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/providers', require('./routes/providers'));
app.use('/api/wallet', require('./routes/wallet'));
app.use('/api/reload', require('./routes/reload'));
app.use('/api/admin', require('./routes/admin'));

// QuickPay Auto-response / Callback Webhook URL (`rurl`)
app.all('/api/quickpay/callback', (req, res) => {
  const params = { ...req.query, ...req.body };
  console.log('--- QuickPay Webhook Triggered ---', params);
  res.send('OK');
});

// Serve frontend static build in production
const clientDistPath = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDistPath));

// Fallback for single page application (SPA) routing
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    const indexPath = path.join(clientDistPath, 'index.html');
    return res.sendFile(indexPath, (err) => {
      if (err) {
        res.json({ status: 'QuickPay Reload Server Running', port: PORT });
      }
    });
  }
  next();
});

app.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(` QuickPay Reload & Cashback Server Started     `);
  console.log(` Running on: http://localhost:${PORT}          `);
  console.log(`===============================================`);
});
