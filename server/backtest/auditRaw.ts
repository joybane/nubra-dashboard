// Dump raw parquet rows for one ATM-relative bucket to see whether `strike`
// is FIXED or FLOATING within a single file (the crux of the misalignment).
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';

const file = process.argv[2]
  || 'E:/Derivativesproject/ATM Wise data/NIFTY/2026-05-12/ATM+2/WEEK/NIFTY_2026-05-12_WEEK_CALL.parquet';

const buf = await asyncBufferFromFile(file);
const rows = await parquetReadObjects({ file: buf, compressors });
console.log(`file: ${file}`);
console.log(`rows: ${rows.length}`);
console.log(`columns: ${Object.keys(rows[0] ?? {}).join(', ')}\n`);

function ist(ts: number): string {
  const d = new Date((ts + 5.5 * 3600) * 1000);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

// distinct strikes present in the file
const strikes = new Set(rows.map((r) => Number(r.strike)));
console.log(`distinct strike values in file: ${[...strikes].sort((a, b) => a - b).join(', ')}\n`);

// sample: first bar of each date
const seen = new Set<string>();
console.log('first bar per date:  date/time          strike   atmStrike   spot     close');
for (const r of rows) {
  let ts = Number(r.timestamp);
  if (ts > 1e12) ts = Math.floor(ts / 1e9); // ns → s if needed
  const stamp = ist(ts);
  const day = stamp.slice(0, 10);
  if (seen.has(day)) continue;
  seen.add(day);
  console.log(
    `                     ${stamp}   ${String(r.strike).padStart(6)}   ${String(r.atmStrike ?? '—').padStart(8)}   ${String(r.spot).padStart(7)}  ${String(r.close).padStart(7)}`,
  );
}
process.exit(0);
