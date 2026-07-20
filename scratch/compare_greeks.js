const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// --- Black-Scholes Implementation ---
const SQRT_2PI = Math.sqrt(2 * Math.PI);
const INV_SQRT_2 = 1 / Math.sqrt(2);

function normalPDF(x) {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

function normalCDF(x) {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x) * INV_SQRT_2;
  const t = 1 / (1 + 0.3275911 * absX);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-absX * absX);
  return 0.5 * (1 + sign * y);
}

function calcBlackScholes(S, K, T, r, sigma, type) {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) {
    return { delta: type === 'CE' ? 1 : -1, gamma: 0, theta: 0, vega: 0 };
  }

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  const Nd1 = normalCDF(d1);
  const Nd2 = normalCDF(d2);
  const Nnd1 = normalCDF(-d1);
  const Nnd2 = normalCDF(-d2);
  const nd1 = normalPDF(d1);
  const ert = Math.exp(-r * T);

  const delta = type === 'CE' ? Nd1 : Nd1 - 1;
  const gamma = nd1 / (S * sigma * sqrtT);
  const theta = type === 'CE'
    ? (-(S * nd1 * sigma) / (2 * sqrtT) - r * K * ert * Nd2) / 365
    : (-(S * nd1 * sigma) / (2 * sqrtT) + r * K * ert * Nnd2) / 365;
  const vega = (S * nd1 * sqrtT) / 100;

  return { delta, gamma, theta, vega };
}

// --- Fetch Option Chain from Nubra API / Local Server ---
async function fetchOptionChain() {
  return new Promise((resolve, reject) => {
    const req = http.get('http://localhost:3000/api/optionchain/NIFTY', (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(json);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
  });
}

async function runComparison() {
  console.log('Fetching NIFTY Option Chain from Nubra API (via backend)...');
  let data;
  try {
    data = await fetchOptionChain();
  } catch (err) {
    console.error('Failed to fetch from backend:', err.message);
    process.exit(1);
  }

  const chain = data.chain || data;
  if (!chain || (!chain.ce && !chain.pe)) {
    console.log('Response returned no chain data. Raw response:', JSON.stringify(data).slice(0, 300));
    process.exit(1);
  }

  const spot = Number(chain.spot || chain.underlying_price || 24000);
  const expiryStr = chain.expiry || '2026-07-23';
  console.log(`\n=== NIFTY Option Chain Data ===`);
  console.log(`Spot Price: ${spot}`);
  console.log(`Expiry: ${expiryStr}`);

  // Time to expiry in years
  const now = new Date();
  const expDate = new Date(`${expiryStr}T15:30:00+05:30`);
  const diffDays = Math.max(0.1, (expDate - now) / (1000 * 60 * 60 * 24));
  const T = diffDays / 365;
  const r = 0.07; // 7% risk-free rate

  console.log(`Days to Expiry: ${diffDays.toFixed(2)} days (T = ${T.toFixed(4)} yrs)`);
  console.log(`Risk-free rate assumed: 7%\n`);

  const ceList = chain.ce || [];
  const peList = chain.pe || [];

  // Filter strikes close to spot (ATM +/- 500 points)
  const rows = [];

  for (const c of ceList) {
    const strike = Number(c.sp) > 10000 ? Number(c.sp) / 100 : Number(c.sp);
    if (Math.abs(strike - spot) > 400) continue;

    const nubraDelta = Number(c.delta ?? NaN);
    const nubraGamma = Number(c.gamma ?? NaN);
    const nubraTheta = Number(c.theta ?? NaN);
    const nubraVega = Number(c.vega ?? NaN);
    const iv = Number(c.iv ?? c.implied_volatility ?? NaN);

    if (isNaN(iv) || iv <= 0) continue;

    const local = calcBlackScholes(spot, strike, T, r, iv / 100, 'CE');

    rows.push({
      strike,
      type: 'CE',
      ltp: c.ltp ? Number(c.ltp) / 100 : NaN,
      iv: iv.toFixed(2) + '%',
      delta: { nubra: nubraDelta.toFixed(4), local: local.delta.toFixed(4), diff: (local.delta - nubraDelta).toFixed(4) },
      gamma: { nubra: nubraGamma.toFixed(6), local: local.gamma.toFixed(6), diff: (local.gamma - nubraGamma).toFixed(6) },
      theta: { nubra: nubraTheta.toFixed(2), local: local.theta.toFixed(2), diff: (local.theta - nubraTheta).toFixed(2) },
      vega: { nubra: nubraVega.toFixed(2), local: local.vega.toFixed(2), diff: (local.vega - nubraVega).toFixed(2) },
    });
  }

  for (const p of peList) {
    const strike = Number(p.sp) > 10000 ? Number(p.sp) / 100 : Number(p.sp);
    if (Math.abs(strike - spot) > 400) continue;

    const nubraDelta = Number(p.delta ?? NaN);
    const nubraGamma = Number(p.gamma ?? NaN);
    const nubraTheta = Number(p.theta ?? NaN);
    const nubraVega = Number(p.vega ?? NaN);
    const iv = Number(p.iv ?? p.implied_volatility ?? NaN);

    if (isNaN(iv) || iv <= 0) continue;

    const local = calcBlackScholes(spot, strike, T, r, iv / 100, 'PE');

    rows.push({
      strike,
      type: 'PE',
      ltp: p.ltp ? Number(p.ltp) / 100 : NaN,
      iv: iv.toFixed(2) + '%',
      delta: { nubra: nubraDelta.toFixed(4), local: local.delta.toFixed(4), diff: (local.delta - nubraDelta).toFixed(4) },
      gamma: { nubra: nubraGamma.toFixed(6), local: local.gamma.toFixed(6), diff: (local.gamma - nubraGamma).toFixed(6) },
      theta: { nubra: nubraTheta.toFixed(2), local: local.theta.toFixed(2), diff: (local.theta - nubraTheta).toFixed(2) },
      vega: { nubra: nubraVega.toFixed(2), local: local.vega.toFixed(2), diff: (local.vega - nubraVega).toFixed(2) },
    });
  }

  rows.sort((a, b) => a.strike - b.strike || a.type.localeCompare(b.type));

  console.log('=== COMPARISON: Nubra API vs Local Black-Scholes ===\n');
  console.log(
    'Strike'.padEnd(8) +
    'Type'.padEnd(6) +
    'IV'.padEnd(8) +
    'Delta (Nubra vs Local | Diff)'.padEnd(32) +
    'Theta (Nubra vs Local | Diff)'.padEnd(30) +
    'Vega (Nubra vs Local | Diff)'
  );
  console.log('-'.repeat(110));

  for (const r of rows) {
    const dStr = `${r.delta.nubra} vs ${r.delta.local} (${r.delta.diff >= 0 ? '+' : ''}${r.delta.diff})`;
    const tStr = `${r.theta.nubra} vs ${r.theta.local} (${r.theta.diff >= 0 ? '+' : ''}${r.theta.diff})`;
    const vStr = `${r.vega.nubra} vs ${r.vega.local} (${r.vega.diff >= 0 ? '+' : ''}${r.vega.diff})`;

    console.log(
      String(r.strike).padEnd(8) +
      r.type.padEnd(6) +
      r.iv.padEnd(8) +
      dStr.padEnd(32) +
      tStr.padEnd(30) +
      vStr
    );
  }
}

runComparison();
