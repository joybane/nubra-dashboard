// Quick probe: for ONE fixed contract (strike+expiry), print the 09:35 close and
// embedded spot for each date in the expiry week. If the premium is identical
// across dates while spot moves, the premium series is stale/duplicated.
import { getStrikeIndex, readContract, type Bar } from './dataLayer.ts';

const und = 'NIFTY';
const expiry = process.argv[2] || '2026-05-12';
const strike = Number(process.argv[3] || 24200);
const hhmm = '09:35';

function firstBarFrom(bars: Bar[], t: string): Bar | null {
  for (const b of bars) if (b.hhmm >= t) return b;
  return null;
}

const r = await getStrikeIndex(und, expiry, 'WEEK');
const sf = r.reduce((best, s) => Math.abs(s.strike - strike) < Math.abs(best.strike - strike) ? s : best, r[0]);
const call = await readContract(sf.callPath, 'CALL');
const put = await readContract(sf.putPath, 'PUT');

console.log(`\n${und} ${sf.strike} expiry ${expiry} @ ${hhmm}\n`);
console.log('date         callClose  putClose  spotCol');
console.log('-'.repeat(45));
const dates = [...call.byDate.keys()].sort();
for (const d of dates) {
  const cb = firstBarFrom(call.byDate.get(d) ?? [], hhmm);
  const pb = firstBarFrom(put.byDate.get(d) ?? [], hhmm);
  if (!cb) continue;
  console.log(
    `${d}   ${String(cb.close).padStart(8)}  ${String(pb?.close ?? '—').padStart(8)}  ${String(cb.spot).padStart(8)}`,
  );
}
process.exit(0);
