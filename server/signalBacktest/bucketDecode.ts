/**
 * Decoding of one parquet bucket file into the six columns a price needs.
 *
 * Shared by the loader (in-process fallback) and the worker threads that normally do this work, so
 * both produce exactly the same arrays.
 */
import { readFile } from 'fs/promises';
import { parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';

/** The six columns of a bucket file that a price needs, one entry per row. */
export interface BucketColumns {
  /** Epoch seconds. */
  ts: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  strike: Float64Array;
}

const REQUIRED = ['timestamp', 'open', 'high', 'low', 'close', 'strike'];

const toNumber = (v: unknown): number => {
  if (typeof v === 'bigint') return Number(v);
  return typeof v === 'number' ? v : NaN;
};

/** Throws on an unreadable or corrupt file; the caller decides to skip it. */
export async function decodeBucket(file: string): Promise<BucketColumns> {
  // One read per file. hyparquet's own file helper opens a stream for every column slice, which on
  // Windows (every open is scanned) costs more than decoding the file.
  const bytes = await readFile(file);
  const rows = await parquetReadObjects({
    file: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    compressors,
    columns: REQUIRED,
  });
  const n = rows.length;
  const cols: BucketColumns = {
    ts: new Float64Array(n),
    open: new Float64Array(n),
    high: new Float64Array(n),
    low: new Float64Array(n),
    close: new Float64Array(n),
    strike: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    cols.ts[i] = toNumber(r.timestamp);
    cols.open[i] = toNumber(r.open);
    cols.high[i] = toNumber(r.high);
    cols.low[i] = toNumber(r.low);
    cols.close[i] = toNumber(r.close);
    cols.strike[i] = toNumber(r.strike);
  }
  return cols;
}
