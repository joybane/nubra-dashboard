/**
 * A compact on-disk copy of one stitched parquet day, under `.signal-cache/<UND>/parquet/<date>.ohlc.gz`.
 *
 * Stitching a day means reading and decoding every bucket file of its expiry (~40 files, 10 – 50 MB
 * of parquet on a hard disk, most of a multi-year run's time). The result for one date is small — a
 * few dozen strikes of four 375-minute rows — so it is kept here and the parquet tree is only read
 * for a date the first time. Past dates never change; the loader does not store a day built while
 * a bucket file was unreadable, so repairing the file later takes effect.
 *
 * File: gzip( uint32 headerLength | header JSON | padding to 8 bytes | float64 blocks ). A block is
 * one strike's open, high, low and close rows back to back (NaN = no price); the header lists the
 * strikes of each side in the order their blocks follow (calls first).
 */
import { promises as fs } from 'fs';
import path from 'path';
import { promisify } from 'util';
import { gunzip, gzip } from 'zlib';
import { SESSION_BARS } from '../analysis/daySeries.ts';
import type { ExpiryFlag } from '../backtest/types.ts';
import type { OptionKind } from './trade.ts';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** Values in one strike's block: open, high, low, close rows of SESSION_BARS minutes. */
export const BLOCK = 4 * SESSION_BARS;

/** A stitched day: per side the strikes seen and, aligned with them, each strike's block. */
export interface StitchedDay {
  expiry: string;
  flag: ExpiryFlag;
  strikes: Record<OptionKind, number[]>;
  blocks: Record<OptionKind, Float64Array[]>;
}

export interface OhlcDayStore {
  read(underlying: string, date: string): Promise<StitchedDay | null>;
  write(underlying: string, date: string, day: StitchedDay): Promise<void>;
}

interface Header {
  v: 1;
  expiry: string;
  flag: ExpiryFlag;
  CE: number[];
  PE: number[];
}

const align8 = (n: number) => Math.ceil(n / 8) * 8;

export function encodeDay(day: StitchedDay): Buffer {
  const header: Header = {
    v: 1,
    expiry: day.expiry,
    flag: day.flag,
    CE: day.strikes.CE,
    PE: day.strikes.PE,
  };
  const head = Buffer.from(JSON.stringify(header), 'utf8');
  const dataAt = align8(4 + head.length);
  const count = day.blocks.CE.length + day.blocks.PE.length;
  const out = Buffer.alloc(dataAt + count * BLOCK * 8);
  out.writeUInt32LE(head.length, 0);
  head.copy(out, 4);
  // Written through a Float64Array over a private copy so the data starts on an 8-byte boundary.
  const data = new Float64Array(count * BLOCK);
  let at = 0;
  for (const kind of ['CE', 'PE'] as const) {
    for (const block of day.blocks[kind]) {
      data.set(block, at);
      at += BLOCK;
    }
  }
  Buffer.from(data.buffer).copy(out, dataAt);
  return out;
}

/** Null for anything that is not a day written by this version, so it is simply rebuilt. */
export function decodeDay(buf: Buffer): StitchedDay | null {
  if (buf.length < 4) return null;
  const headLen = buf.readUInt32LE(0);
  if (4 + headLen > buf.length) return null;
  let header: Header;
  try {
    header = JSON.parse(buf.toString('utf8', 4, 4 + headLen)) as Header;
  } catch {
    return null;
  }
  if (
    header?.v !== 1 ||
    typeof header.expiry !== 'string' ||
    (header.flag !== 'WEEK' && header.flag !== 'MONTH') ||
    !Array.isArray(header.CE) ||
    !Array.isArray(header.PE)
  ) {
    return null;
  }
  const dataAt = align8(4 + headLen);
  const count = header.CE.length + header.PE.length;
  if (buf.length !== dataAt + count * BLOCK * 8) return null;
  // A private, aligned copy: a Buffer from a read can sit at any offset in a shared pool.
  const ab = buf.buffer.slice(buf.byteOffset + dataAt, buf.byteOffset + buf.length);
  const data = new Float64Array(ab);
  const take = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => data.subarray((from + i) * BLOCK, (from + i + 1) * BLOCK));
  return {
    expiry: header.expiry,
    flag: header.flag,
    strikes: { CE: header.CE, PE: header.PE },
    blocks: { CE: take(0, header.CE.length), PE: take(header.CE.length, header.PE.length) },
  };
}

export function createOhlcDayStore(rootDir: string): OhlcDayStore {
  const file = (u: string, date: string) => path.join(rootDir, u, 'parquet', `${date}.ohlc.gz`);
  return {
    async read(underlying, date) {
      try {
        return decodeDay(await gunzipAsync(await fs.readFile(file(underlying, date))));
      } catch {
        return null;
      }
    },
    async write(underlying, date, day) {
      const f = file(underlying, date);
      await fs.mkdir(path.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.tmp`;
      await fs.writeFile(tmp, await gzipAsync(encodeDay(day)));
      await fs.rename(tmp, f);
    },
  };
}
