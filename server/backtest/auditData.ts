// ─────────────────────────────────────────────────────────────────────────────
// Data-integrity audit: for each trading day, compare the embedded `spot` column
// against the put-call-parity-implied forward  F = Call − Put + Strike  (computed
// per strike at the entry-time bar).
//
// If the premium columns are internally consistent, every strike yields ~the same
// F (the forward), which should sit a few points ABOVE spot (cost of carry). A
// large gap between F and the `spot` column means premium/spot are misaligned.
//
//   run:  node --experimental-strip-types server/backtest/auditData.ts NIFTY 2026-05-01 2026-05-31 09:35
// ─────────────────────────────────────────────────────────────────────────────
import { resolveExpiry, getStrikeIndex, readContract, type Bar } from './dataLayer.ts';
import type { Underlying } from './types.ts';

const und = (process.argv[2] as Underlying) || 'NIFTY';
const from = process.argv[3] || '2026-05-01';
const to = process.argv[4] || '2026-05-31';
const entryTime = process.argv[5] || '09:35';
const FLAG_THRESHOLD = 40; // points: |median F − spot| above this = misaligned

function tradingDays(a: string, b: string): string[] {
  const out: string[] = [];
  const s = new Date(`${a}T12:00:00Z`), e = new Date(`${b}T12:00:00Z`);
  for (let d = s; d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
function firstBarFrom(bars: Bar[], hhmm: string): Bar | null {
  for (const b of bars) if (b.hhmm >= hhmm) return b;
  return null;
}
function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function dte(date: string, expiry: string): number {
  return Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000);
}

interface Row {
  date: string; expiry: string; dte: number; atm: number;
  spotCol: number; medianF: number; diff: number;
  fSpread: number; nStrikes: number; spotColVaries: boolean; flagged: boolean;
}

async function run() {
  const dates = tradingDays(from, to);
  const rows: Row[] = [];
  console.log(`\nAuditing ${und}  ${from} → ${to}  @ ${entryTime}  (flag if |medianF − spot| > ${FLAG_THRESHOLD})\n`);

  for (const date of dates) {
    const res = await resolveExpiry(und, 'WEEK', date, 0);
    if (!res) continue;
    const idx = await getStrikeIndex(und, res.expiry, res.flag);
    if (!idx.length) continue;

    // Collect per-strike call/put close + spot at the entry bar.
    const fVals: number[] = [];
    const spots = new Set<number>();
    let atm = 0, atmDist = Infinity;
    let spotRef = NaN;

    // first pass: find spot from any liquid strike to locate ATM
    for (const s of idx) {
      try {
        const c = await readContract(s.callPath, 'CALL');
        const cb = firstBarFrom(c.byDate.get(date) ?? [], entryTime);
        if (cb && Number.isFinite(cb.spot)) { spotRef = cb.spot; break; }
      } catch { /* skip */ }
    }
    if (!Number.isFinite(spotRef)) continue;

    // restrict to strikes within ±15 of ATM for parity (far wings illiquid)
    const near = idx
      .map((s) => ({ s, d: Math.abs(s.strike - spotRef) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 15)
      .map((x) => x.s);

    for (const s of near) {
      try {
        const c = await readContract(s.callPath, 'CALL');
        const p = await readContract(s.putPath, 'PUT');
        const cb = firstBarFrom(c.byDate.get(date) ?? [], entryTime);
        const pb = firstBarFrom(p.byDate.get(date) ?? [], entryTime);
        if (!cb || !pb || !Number.isFinite(cb.close) || !Number.isFinite(pb.close)) continue;
        if (cb.close <= 0 && pb.close <= 0) continue;
        fVals.push(cb.close - pb.close + s.strike);
        if (Number.isFinite(cb.spot)) spots.add(Math.round(cb.spot * 100) / 100);
        const dist = Math.abs(s.strike - spotRef);
        if (dist < atmDist) { atmDist = dist; atm = s.strike; }
      } catch { /* skip */ }
    }
    if (fVals.length < 3) continue;

    const medF = median(fVals);
    const spotCol = spotRef;
    const diff = medF - spotCol;
    const fSpread = Math.max(...fVals) - Math.min(...fVals);
    rows.push({
      date, expiry: res.expiry, dte: dte(date, res.expiry), atm,
      spotCol: Math.round(spotCol * 100) / 100,
      medianF: Math.round(medF * 100) / 100,
      diff: Math.round(diff * 100) / 100,
      fSpread: Math.round(fSpread * 100) / 100,
      nStrikes: fVals.length,
      spotColVaries: spots.size > 1,
      flagged: Math.abs(diff) > FLAG_THRESHOLD,
    });
  }

  // print table
  const hdr = 'date        expiry      dte  atm     spotCol   medianF   diff     F-spread  strikes  flag';
  console.log(hdr);
  console.log('-'.repeat(hdr.length));
  for (const r of rows) {
    console.log(
      `${r.date}  ${r.expiry}  ${String(r.dte).padStart(3)}  ${String(r.atm).padStart(6)}  ` +
      `${String(r.spotCol).padStart(8)}  ${String(r.medianF).padStart(8)}  ${String(r.diff).padStart(7)}  ` +
      `${String(r.fSpread).padStart(8)}  ${String(r.nStrikes).padStart(7)}  ${r.flagged ? '⚠ MISALIGNED' : 'ok'}`,
    );
  }

  const flagged = rows.filter((r) => r.flagged);
  const tightSpread = flagged.filter((r) => r.fSpread < 50); // premiums agree across strikes → spot col is the wrong one
  console.log('\n── summary ──');
  console.log(`days audited        : ${rows.length}`);
  console.log(`flagged misaligned  : ${flagged.length}  (${rows.length ? Math.round(flagged.length / rows.length * 100) : 0}%)`);
  console.log(`  of which premiums agree across strikes (F-spread<50) → spot column is the outlier: ${tightSpread.length}`);
  console.log(`avg |diff| flagged  : ${flagged.length ? Math.round(flagged.reduce((a, r) => a + Math.abs(r.diff), 0) / flagged.length) : 0} pts`);
  console.log(`median diff (all)   : ${Math.round(median(rows.map((r) => r.diff)))} pts  (small + = normal carry)`);
  if (flagged.length) console.log(`flagged dates       : ${flagged.map((r) => r.date).join(', ')}`);
}

run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
