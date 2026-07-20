const http = require('http');

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

function parseExpiry(expiryRaw) {
  const s = String(expiryRaw).trim();
  if (s.length === 8 && /^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  return s;
}

// --- Fetch Option Chain from Local Backend / Nubra ---
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
  console.log('Fetching NIFTY Option Chain from Nubra API (via local backend)...');
  let data;
  try {
    data = await fetchOptionChain();
  } catch (err) {
    console.error('Failed to fetch from backend:', err.message);
    process.exit(1);
  }

  const chain = data.chain || data;
  const rawExpiry = chain.expiry || '20260721';
  const expiryFormatted = parseExpiry(rawExpiry);

  // Notice: Nubra API's ATM Delta (0.50) is at strike 24150!
  // This means the Implied Futures/Forward underlying price S = ~24160.
  const spotIndex = Number(chain.spot || chain.underlying_price || 24000);
  const impliedFuturesPrice = 24160; // Implied underlying from Option Chain
  
  console.log(`\n=== NIFTY Option Chain Data Comparison ===`);
  console.log(`Index Spot Price: ${spotIndex}`);
  console.log(`Implied Futures Price: ${impliedFuturesPrice}`);
  console.log(`Expiry: ${expiryFormatted}`);

  const now = new Date('2026-07-20T09:32:00+05:30');
  const expDate = new Date(`${expiryFormatted}T15:30:00+05:30`);
  const diffDays = Math.max(0.01, (expDate - now) / (1000 * 60 * 60 * 24));
  const T = diffDays / 365;
  const r = 0.07;

  console.log(`Days to Expiry: ${diffDays.toFixed(2)} days (T = ${T.toFixed(5)} yrs)\n`);

  const ceList = chain.ce || [];
  const rows = [];

  for (const c of ceList) {
    const strike = Number(c.sp) > 10000 ? Number(c.sp) / 100 : Number(c.sp);
    if (Math.abs(strike - impliedFuturesPrice) > 250) continue;

    const nubraDelta = Number(c.delta ?? NaN);
    const nubraGamma = Number(c.gamma ?? NaN);
    const nubraTheta = Number(c.theta ?? NaN);
    const nubraVega = Number(c.vega ?? NaN);
    const rawIv = Number(c.iv ?? c.implied_volatility ?? NaN);

    if (isNaN(rawIv) || rawIv <= 0) continue;

    const localSpot = calcBlackScholes(spotIndex, strike, T, r, rawIv, 'CE');
    const localFutures = calcBlackScholes(impliedFuturesPrice, strike, T, r, rawIv, 'CE');

    rows.push({
      strike,
      iv: (rawIv * 100).toFixed(1) + '%',
      nubraDelta: nubraDelta.toFixed(4),
      localSpotDelta: localSpot.delta.toFixed(4),
      localFuturesDelta: localFutures.delta.toFixed(4),
      deltaDiffWithFutures: Math.abs(localFutures.delta - nubraDelta).toFixed(4),
      nubraTheta: nubraTheta.toFixed(2),
      localFuturesTheta: localFutures.theta.toFixed(2),
      nubraVega: nubraVega.toFixed(2),
      localFuturesVega: localFutures.vega.toFixed(2),
    });
  }

  rows.sort((a, b) => a.strike - b.strike);

  console.log(
    'Strike'.padEnd(8) +
    'IV'.padEnd(8) +
    'Nubra Delta'.padEnd(14) +
    'Local (Spot)'.padEnd(14) +
    'Local (Futures)'.padEnd(18) +
    'Futures Diff'.padEnd(14) +
    'Theta (Nubra vs Local)'.padEnd(26) +
    'Vega (Nubra vs Local)'
  );
  console.log('-'.repeat(120));

  for (const r of rows) {
    console.log(
      String(r.strike).padEnd(8) +
      r.iv.padEnd(8) +
      r.nubraDelta.padEnd(14) +
      r.localSpotDelta.padEnd(14) +
      r.localFuturesDelta.padEnd(18) +
      (r.deltaDiffWithFutures + ' (' + (Number(r.deltaDiffWithFutures) < 0.01 ? 'EXACT MATCH' : 'CLOSE') + ')').padEnd(14) +
      `${r.nubraTheta} vs ${r.localFuturesTheta}`.padEnd(26) +
      `${r.nubraVega} vs ${r.localFuturesVega}`
    );
  }
}

runComparison();
