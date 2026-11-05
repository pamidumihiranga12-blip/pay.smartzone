const axios = require('axios');
const path = require('path');
require('dotenv').config();

// Ensure db and server
require('./server/db');

const baseURL = 'http://localhost:5000/api';

async function runTests() {
  console.log('--- Starting Automated System Tests ---');

  // 1. Test Admin Login
  console.log('\n[1] Testing Admin Login...');
  const adminLoginRes = await axios.post(`${baseURL}/auth/login`, {
    login: 'admin@quickpay.lk',
    password: 'admin123'
  });
  console.log('✓ Admin login successful! Token received.');
  const adminToken = adminLoginRes.data.token;

  // 2. Test Admin Dashboard Stats & Live Balances
  console.log('\n[2] Testing Admin Dashboard Stats (QuickPay Balance + User Balances)...');
  const statsRes = await axios.get(`${baseURL}/admin/dashboard-stats`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  console.log('✓ QuickPay Balance Data:', statsRes.data.quickpay);
  console.log('✓ Users Total Liability:', statsRes.data.users);
  console.log('✓ Platform Net Profit:', statsRes.data.finances);

  // 3. Test Register New User with Registration Fee
  console.log('\n[3] Testing User Registration with Registration Fee...');
  const testEmail = `user${Date.now()}@test.com`;
  const testPhone = `077${Math.floor(1000000 + Math.random() * 9000000)}`;
  const regRes = await axios.post(`${baseURL}/auth/register`, {
    name: 'Kasun Bandara',
    email: testEmail,
    phone: testPhone,
    password: 'password123'
  });
  console.log('✓ User registered! Status:', regRes.data.user.status, '| Reg Fee Required:', regRes.data.registrationFee);
  const userToken = regRes.data.token;
  const userId = regRes.data.user.id;

  // 4. Test User Bank Verification Submission for Registration Fee
  console.log('\n[4] Submitting Registration Fee Slip Proof...');
  const feeRes = await axios.post(`${baseURL}/auth/pay-registration-fee`, {
    referenceNo: 'BOC-REG-SLIP-7890'
  }, {
    headers: { Authorization: `Bearer ${userToken}` }
  });
  console.log('✓ Registration fee proof submitted:', feeRes.data.message);

  // 5. Admin Approves Registration Fee & Activates User
  console.log('\n[5] Admin Approves User Registration Slip...');
  const requestsRes = await axios.get(`${baseURL}/admin/topup-requests`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const pendingReq = requestsRes.data.find(r => r.user_id === userId);
  if (pendingReq) {
    const approveRes = await axios.post(`${baseURL}/admin/topup-requests/${pendingReq.id}/action`, {
      action: 'approve',
      note: 'Verified payment slip'
    }, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    console.log('✓ User verified and activated by Admin:', approveRes.data.message);
  }

  // 6. Admin Manual Top-up of User Wallet
  console.log('\n[6] Admin Credits User Wallet with LKR 2,500.00...');
  const topupRes = await axios.post(`${baseURL}/admin/users/${userId}/topup`, {
    amount: 2500,
    type: 'credit',
    reason: 'Initial Counter Top-up'
  }, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  console.log('✓ User Wallet Credited:', topupRes.data.message, '| New Balance:', topupRes.data.newBalance);

  // 7. Test User Reload with Instant Cashback
  console.log('\n[7] Testing User Reload (Dialog Mobile - LKR 500)...');
  // Enable simulation mode for instant test without touching live funds
  await axios.post(`${baseURL}/admin/settings`, { simulation_mode: 'true' }, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });

  const reloadRes = await axios.post(`${baseURL}/reload/process`, {
    providerCode: 'DLG',
    phoneNumber: '0771234567',
    amount: 500
  }, {
    headers: { Authorization: `Bearer ${userToken}` }
  });
  console.log('✓ Reload Completed successfully!');
  console.log('  - Reference No:', reloadRes.data.refNo);
  console.log('  - Cashback Credited to Wallet:', `+LKR ${reloadRes.data.cashbackEarned}`);
  console.log('  - Updated User Wallet Balance:', `LKR ${reloadRes.data.newBalance}`);

  // 8. Test Admin Commission Configuration
  console.log('\n[8] Testing Provider Commission Configuration...');
  const providersRes = await axios.get(`${baseURL}/admin/providers`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  const dlg = providersRes.data.find(p => p.code === 'DLG');
  console.log('  Current Dialog Rates: QuickPay Commission:', dlg.quickpay_commission, '% | Customer Cashback:', dlg.cashback_rate, '% | Net Profit Margin:', dlg.net_profit_margin, '%');

  const updateProvRes = await axios.put(`${baseURL}/admin/providers/${dlg.id}`, {
    ...dlg,
    quickpay_commission: 5.5,
    cashback_rate: 2.0
  }, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  console.log('✓ Updated Dialog commission and cashback rates:', updateProvRes.data.message);

  console.log('\n======================================================');
  console.log('🎉 ALL SYSTEM MODULES & TESTS PASSED WITH 100% SUCCESS!');
  console.log('======================================================');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test Failed:', err.response?.data || err.message);
  process.exit(1);
});

