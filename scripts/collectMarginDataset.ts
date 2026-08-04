/**
 * Margin calibration harness.
 *
 * Asks the broker for the true margin on a grid of real positions across NSE and MCX,
 * runs the same legs through the local fallback engine, and reports the error. This is
 * what the parameters in server/marginEngine.ts were fitted to — re-run it when the
 * exchanges revise their scan ranges and the fallback starts drifting.
 *
 *   node --experimental-strip-types scripts/collectMarginDataset.ts            # compare
 *   node --experimental-strip-types scripts/collectMarginDataset.ts --dump out.json
 *
 * Requires the dashboard server to be running and logged in (it goes through
 * /paper/margin/basket, so it gets the broker's number and the same leg resolution the
 * app uses). Margins are quoted intraday, so run it during market hours — MCX quotes
 * until 23:30 IST, NSE until 15:30.
 */
import { writeFileSync } from 'fs';
import { calculateLocalBasketMargin } from '../server/marginEngine.ts';

const BASE = process.env.DASHBOARD_URL || 'http://localhost:3000';
const dumpIdx = process.argv.indexOf('--dump');
const DUMP_PATH = dumpIdx >= 0 ? process.argv[dumpIdx + 1] : null;

interface ChainRow {
  sp: number;
  ref_id: number;
  ls: number;
  ltp: number | null;
  iv: number | null;
}
interface Chain {
  cp: number;
  atm: number;
  expiry?: number;
  ce: ChainRow[];
  pe: ChainRow[];
}

const chainCache = new Map<string, Chain>();
async function getChain(asset: string, exchange: string, expiry: string): Promise<Chain> {
  const key = `${exchange}:${asset}:${expiry}`;
  const hit = chainCache.get(key);
  if (hit) return hit;
  const qs = `exchange=${exchange}${expiry ? `&expiry=${expiry}` : ''}`;
  const res = await fetch(`${BASE}/api/optionchain/${asset}?${qs}`);
  const json = (await res.json()) as { chain?: Chain };
  const chain = (json.chain || json) as Chain;
  chainCache.set(key, chain);
  return chain;
}

function listedStrikes(chain: Chain): number[] {
  return [...new Set(chain.ce.map((r) => r.sp / 100))].sort((a, b) => a - b);
}
function nearest(strikes: number[], target: number): number {
  return strikes.reduce((best, s) => (Math.abs(s - target) < Math.abs(best - target) ? s : best));
}
/** The modal gap between listed strikes, so offsets scale across assets. */
function strikeStep(chain: Chain): number {
  const s = listedStrikes(chain);
  const counts = new Map<number, number>();
  for (let i = 1; i < s.length; i++) {
    const d = Math.round((s[i] - s[i - 1]) * 100) / 100;
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

interface LegSpec {
  steps: number;
  type: 'CE' | 'PE';
  side: 'BUY' | 'SELL';
  lots?: number;
}

async function buildOrders(asset: string, exchange: string, expiry: string, legs: LegSpec[]) {
  const chain = await getChain(asset, exchange, expiry);
  const strikes = listedStrikes(chain);
  const step = strikeStep(chain);
  const atm = nearest(strikes, chain.atm / 100);
  const spot = chain.cp / 100;
  const lot = chain.ce[0]?.ls || 1;
  return legs.map((l) => {
    const strike = nearest(strikes, atm + l.steps * step);
    const row = (l.type === 'CE' ? chain.ce : chain.pe).find((r) => r.sp / 100 === strike);
    return {
      ref_id: row?.ref_id ?? 0,
      order_qty: lot * (l.lots ?? 1),
      order_side: l.side,
      order_type: 'MARKET',
      order_delivery_type: 'IDAY',
      strike,
      option_type: l.type,
      expiry,
      symbol: asset,
      lot_size: lot,
      ltp: row?.ltp != null ? row.ltp / 100 : 0,
      iv: row?.iv != null ? row.iv * 100 : 0,
      spot,
    };
  });
}

/** The broker's own figure, or 0 if the route fell back to the local engine. */
async function brokerMargin(exchange: string, orders: unknown[]): Promise<number> {
  const res = await fetch(`${BASE}/paper/margin/basket`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exchange, orders }),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (json.source) return 0;
  const mi = json.marginInfo as { totalMargin?: number } | undefined;
  return Number(mi?.totalMargin || 0);
}

const UNIVERSE: Array<{ asset: string; exchange: string; expiries: string[] }> = [
  { asset: 'NIFTY', exchange: 'NSE', expiries: [''] },
  { asset: 'BANKNIFTY', exchange: 'NSE', expiries: [''] },
  { asset: 'CRUDEOIL', exchange: 'MCX', expiries: [''] },
  { asset: 'CRUDEOILM', exchange: 'MCX', expiries: [''] },
  { asset: 'NATURALGAS', exchange: 'MCX', expiries: [''] },
  { asset: 'NATGASMINI', exchange: 'MCX', expiries: [''] },
  { asset: 'GOLD', exchange: 'MCX', expiries: [''] },
  { asset: 'GOLDM', exchange: 'MCX', expiries: [''] },
  { asset: 'SILVER', exchange: 'MCX', expiries: [''] },
  { asset: 'SILVERM', exchange: 'MCX', expiries: [''] },
  { asset: 'COPPER', exchange: 'MCX', expiries: [''] },
  { asset: 'ZINC', exchange: 'MCX', expiries: [''] },
];

const SHAPES: Array<{ name: string; legs: LegSpec[] }> = [
  { name: 'short ATM CE', legs: [{ steps: 0, type: 'CE', side: 'SELL' }] },
  { name: 'short ATM PE', legs: [{ steps: 0, type: 'PE', side: 'SELL' }] },
  { name: 'short CE +3', legs: [{ steps: 3, type: 'CE', side: 'SELL' }] },
  { name: 'short CE +6', legs: [{ steps: 6, type: 'CE', side: 'SELL' }] },
  { name: 'short CE +10', legs: [{ steps: 10, type: 'CE', side: 'SELL' }] },
  { name: 'short CE +20', legs: [{ steps: 20, type: 'CE', side: 'SELL' }] },
  { name: 'short PE -3', legs: [{ steps: -3, type: 'PE', side: 'SELL' }] },
  { name: 'short PE -6', legs: [{ steps: -6, type: 'PE', side: 'SELL' }] },
  { name: 'short PE -10', legs: [{ steps: -10, type: 'PE', side: 'SELL' }] },
  { name: 'short PE -20', legs: [{ steps: -20, type: 'PE', side: 'SELL' }] },
  { name: 'short ITM CE -6', legs: [{ steps: -6, type: 'CE', side: 'SELL' }] },
  { name: 'long ATM CE', legs: [{ steps: 0, type: 'CE', side: 'BUY' }] },
  { name: 'long ATM PE', legs: [{ steps: 0, type: 'PE', side: 'BUY' }] },
  {
    name: 'short straddle',
    legs: [
      { steps: 0, type: 'CE', side: 'SELL' },
      { steps: 0, type: 'PE', side: 'SELL' },
    ],
  },
  {
    name: 'short strangle 6',
    legs: [
      { steps: 6, type: 'CE', side: 'SELL' },
      { steps: -6, type: 'PE', side: 'SELL' },
    ],
  },
  {
    name: 'short strangle 12',
    legs: [
      { steps: 12, type: 'CE', side: 'SELL' },
      { steps: -12, type: 'PE', side: 'SELL' },
    ],
  },
  {
    name: 'call vertical',
    legs: [
      { steps: 0, type: 'CE', side: 'BUY' },
      { steps: 6, type: 'CE', side: 'SELL' },
    ],
  },
  {
    name: 'put vertical',
    legs: [
      { steps: 0, type: 'PE', side: 'BUY' },
      { steps: -6, type: 'PE', side: 'SELL' },
    ],
  },
  {
    name: 'iron condor',
    legs: [
      { steps: 6, type: 'CE', side: 'SELL' },
      { steps: 12, type: 'CE', side: 'BUY' },
      { steps: -6, type: 'PE', side: 'SELL' },
      { steps: -12, type: 'PE', side: 'BUY' },
    ],
  },
  {
    name: 'short straddle x3',
    legs: [
      { steps: 0, type: 'CE', side: 'SELL', lots: 3 },
      { steps: 0, type: 'PE', side: 'SELL', lots: 3 },
    ],
  },
  {
    name: 'ratio 1x2',
    legs: [
      { steps: 0, type: 'CE', side: 'BUY' },
      { steps: 6, type: 'CE', side: 'SELL', lots: 2 },
    ],
  },
];

const dataset: Array<Record<string, unknown>> = [];
const errors: Array<{ exchange: string; err: number }> = [];

for (const u of UNIVERSE) {
  for (const expRaw of u.expiries) {
    let chain: Chain;
    try {
      chain = await getChain(u.asset, u.exchange, expRaw);
      if (!chain?.ce?.length) throw new Error('empty chain');
    } catch (e) {
      console.log(`${u.asset}: chain unavailable (${(e as Error).message})`);
      continue;
    }
    const expiry = expRaw || String(chain.expiry || '');

    for (const shape of SHAPES) {
      try {
        const orders = await buildOrders(u.asset, u.exchange, expiry, shape.legs);
        if (orders.some((o) => !o.ltp)) continue; // illiquid strike — no basis for a comparison
        const broker = await brokerMargin(u.exchange, orders);
        if (!broker) {
          console.log(`${u.asset.padEnd(11)} ${shape.name.padEnd(18)} broker declined`);
          continue;
        }
        const local = calculateLocalBasketMargin(orders, u.asset, new Date(), u.exchange);
        const err = (((local?.total_margin || 0) - broker) / broker) * 100;
        errors.push({ exchange: u.exchange, err });
        dataset.push({
          asset: u.asset,
          exchange: u.exchange,
          expiry,
          shape: shape.name,
          spot: orders[0].spot,
          lot: orders[0].lot_size,
          brokerMargin: broker,
          localMargin: local?.total_margin || 0,
          orders,
        });
        console.log(
          `${u.asset.padEnd(11)} ${shape.name.padEnd(18)} broker ${String(Math.round(broker / 100)).padStart(9)}  local ${String(Math.round((local?.total_margin || 0) / 100)).padStart(9)}  ${err >= 0 ? '+' : ''}${err.toFixed(1)}%`,
        );
      } catch (e) {
        console.log(`${u.asset} ${shape.name}: ${(e as Error).message}`);
      }
    }
  }
}

function report(label: string, sub: number[]) {
  if (!sub.length) return;
  const abs = sub.map(Math.abs).sort((a, b) => a - b);
  console.log(
    `${label.padEnd(6)} n=${String(abs.length).padStart(3)}  mean|err| ${(abs.reduce((a, b) => a + b, 0) / abs.length).toFixed(2)}%  median ${abs[Math.floor(abs.length / 2)].toFixed(2)}%  p90 ${abs[Math.floor(abs.length * 0.9)].toFixed(2)}%  max ${abs[abs.length - 1].toFixed(2)}%`,
  );
}
console.log('');
report(
  'ALL',
  errors.map((e) => e.err),
);
report(
  'NSE',
  errors.filter((e) => e.exchange === 'NSE').map((e) => e.err),
);
report(
  'MCX',
  errors.filter((e) => e.exchange === 'MCX').map((e) => e.err),
);

if (DUMP_PATH) {
  writeFileSync(DUMP_PATH, JSON.stringify(dataset, null, 2));
  console.log(`\n${dataset.length} observations → ${DUMP_PATH}`);
}
