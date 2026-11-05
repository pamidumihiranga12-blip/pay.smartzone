const crypto = require('crypto');
const axios = require('axios');
const db = require('./db');

function getSettings() {
  const rows = db.prepare(`SELECT key, value FROM settings`).all();
  const settings = {};
  for (const r of rows) {
    settings[r.key] = r.value;
  }
  return settings;
}

function sha512(data) {
  return crypto.createHash('sha512').update(data).digest('hex').toLowerCase();
}

/**
 * Fetch Live Merchant Balance from QuickPay
 */
async function getQuickPayBalance() {
  const settings = getSettings();
  const mid = settings.quickpay_mid || 'OTk0ODAw';
  const secretKey = settings.quickpay_secretkey || '5c83f283655d39ab8876';
  const apiUrl = settings.quickpay_api_url || 'http://secure.quickpay.lk/api/';
  const isSimulated = settings.simulation_mode === 'true';

  if (isSimulated) {
    return {
      success: true,
      simulated: true,
      purchased: 50000.0,
      utilized: 12450.0,
      hold: 0.0,
      balance: 37550.0,
      reason: 'Accepted (Simulation Mode)'
    };
  }

  const hashString = `${mid}|${secretKey}`;
  const hash = sha512(hashString);

  try {
    const url = `${apiUrl}?action=balance&format=JSON&mid=${encodeURIComponent(mid)}&hash=${hash}`;
    const response = await axios.get(url, { timeout: 8000 });
    const data = response.data;

    if (data && data.MerchantBalance) {
      const mb = data.MerchantBalance;
      return {
        success: mb.reasoncode === '000',
        purchased: parseFloat(mb.purchased || 0),
        utilized: parseFloat(mb.utilized || 0),
        hold: parseFloat(mb.hold || 0),
        balance: parseFloat(mb.balance || 0),
        reason: mb.reason || 'Accepted',
        reasoncode: mb.reasoncode
      };
    }

    return {
      success: false,
      balance: 0,
      raw: data,
      error: 'Invalid response format from QuickPay'
    };
  } catch (err) {
    console.error('QuickPay Balance API Error:', err.message);
    return {
      success: false,
      balance: 0,
      error: err.message
    };
  }
}

/**
 * Execute Mobile / Bill Recharge via QuickPay API
 */
async function executeRecharge({ number, amount, providerCode, refNo, callbackUrl = '' }) {
  const settings = getSettings();
  const mid = settings.quickpay_mid || 'OTk0ODAw';
  const secretKey = settings.quickpay_secretkey || '5c83f283655d39ab8876';
  const apiUrl = settings.quickpay_api_url || 'http://secure.quickpay.lk/api/';
  const isSimulated = settings.simulation_mode === 'true';

  // Format amount to 2 decimal places as required by gateway
  const formattedAmount = Number(amount).toFixed(2);

  if (isSimulated) {
    // Simulated instant success with realistic QuickPay response
    const mockRid = Math.floor(1000000 + Math.random() * 9000000).toString();
    return {
      success: true,
      simulated: true,
      rid: mockRid,
      refno: refNo,
      reason: 'Accepted',
      reasoncode: '000',
      status: 'Success'
    };
  }

  // Hash formula: mid|number|provider|amount|refno|rurl|secretkey
  const hashString = `${mid}|${number}|${providerCode}|${formattedAmount}|${refNo}|${callbackUrl}|${secretKey}`;
  const hash = sha512(hashString);

  try {
    const params = new URLSearchParams({
      action: 'recharge',
      format: 'JSON',
      mid,
      provider: providerCode,
      number,
      amount: formattedAmount,
      refno: refNo,
      rurl: callbackUrl,
      hash
    });

    const url = `${apiUrl}?${params.toString()}`;
    const response = await axios.get(url, { timeout: 15000 });
    const data = response.data;

    if (data && data.RechargeStatus) {
      const rs = data.RechargeStatus;
      const isAccepted = rs.reasoncode === '000';
      return {
        success: isAccepted,
        rid: rs.rid ? String(rs.rid) : '',
        refno: rs.refno || refNo,
        reason: rs.reason,
        reasoncode: rs.reasoncode,
        status: isAccepted ? 'Success' : 'Failed',
        raw: rs
      };
    }

    return {
      success: false,
      status: 'Failed',
      reason: 'Unexpected API response structure',
      raw: data
    };
  } catch (err) {
    console.error('QuickPay Recharge Error:', err.message);
    return {
      success: false,
      status: 'Failed',
      reason: err.response?.data?.message || err.message,
      error: err.message
    };
  }
}

/**
 * Check Recharge Status on Demand
 */
async function checkRechargeStatus({ rid, refNo }) {
  const settings = getSettings();
  const mid = settings.quickpay_mid || 'OTk0ODAw';
  const secretKey = settings.quickpay_secretkey || '5c83f283655d39ab8876';
  const apiUrl = settings.quickpay_api_url || 'http://secure.quickpay.lk/api/';

  const hashString = rid ? `${mid}|${rid}|${secretKey}` : `${mid}|${refNo}|${secretKey}`;
  const hash = sha512(hashString);

  try {
    const params = new URLSearchParams({
      action: 'rechargestatus',
      format: 'JSON',
      mid,
      hash,
      ...(rid ? { rid } : { refno: refNo })
    });

    const url = `${apiUrl}?${params.toString()}`;
    const response = await axios.get(url, { timeout: 10000 });
    return response.data;
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Auto-detect mobile provider from phone number prefix
 */
function detectProviderFromNumber(number) {
  const clean = number.replace(/[^0-9]/g, '');
  const prefix = clean.startsWith('94') ? clean.substring(2, 5) : clean.substring(0, 3);

  // Dialog: 077, 076, 074
  if (['077', '076', '074', '77', '76', '74'].includes(prefix)) {
    return 'DLG';
  }
  // Mobitel: 071, 070
  if (['071', '070', '71', '70'].includes(prefix)) {
    return 'MOB';
  }
  // Hutch: 078, 072
  if (['078', '072', '78', '72'].includes(prefix)) {
    return 'HTC';
  }
  // Airtel: 075
  if (['075', '75'].includes(prefix)) {
    return 'AIR';
  }

  return null;
}

module.exports = {
  getQuickPayBalance,
  executeRecharge,
  checkRechargeStatus,
  detectProviderFromNumber,
  sha512
};

