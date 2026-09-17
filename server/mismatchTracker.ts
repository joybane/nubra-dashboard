/**
 * Live profit-mismatch tracker for one open CE + PE strategy.
 *
 * The live twin of server/analysis/caseFinder.ts. A case is an earlier minute and a live tick where
 * the underlying (the index, or for MCX the future the options are written on) is back at the same
 * close (±1 point), at least 30 minutes later, and the two legs' P&L
 * changed in ways that disagree: opposite directions, or one leg at least twice the other. The
 * numbers are the Analysis defaults, but on the strategy's real strikes, quantities and entry.
 *
 * Ticks arrive every second, and NIFTY drifts in and out of a one-point band constantly, so a case
 * is not frozen at its first tick. A later match that is a near-copy of a case (earlier minute
 * within 30 minutes of the case's, tick within 30 minutes of the case's latest version) either
 * becomes a new version, when its CE-vs-PE gap is wider, or is ignored. Every version is kept, so
 * the exact reading a trader acted on can still be looked at after it has been superseded. Once a
 * case's latest version is 30 minutes old nothing can be a near-copy of it any more: it is frozen
 * by construction, with no timer. A match that is a near-copy of two cases at once is ignored, so
 * no case is ever pulled onto another.
 *
 * Pure: no I/O, no clock. server/mismatchRoutes.ts feeds it ticks and broker minute closes.
 */

export const MISMATCH_PARAMS = {
  /** Largest gap, in index points, between the earlier close and NIFTY now. */
  closeTolerance: 1,
  /** Earliest the "now" tick may be after the earlier minute. */
  minGapMinutes: 30,
  /** |ΔCE − ΔPE| must be at least this % of the bigger leg's change. */
  legMismatchPct: 50,
  /** Two matches this close at both ends are the same case. */
  nearCopyMinutes: 30,
};

const IST_OFFSET_MS = 19_800_000;
const MINUTE_MS = 60_000;
/** Session in IST minutes past midnight, first and last minute inclusive. */
export function sessionMinutes(exchange: string): { open: number; last: number } {
  // MCX runs 09:00–23:30; its options are written on futures, so the "same level" price is the
  // future's (measured 2026-09-16: the CRUDEOIL chain's price equalled FUT_CRUDEOIL_20260921's
  // 23:29 close, ₹9,815.00).
  return exchange === 'MCX'
    ? { open: 9 * 60, last: 23 * 60 + 29 }
    : { open: 9 * 60 + 15, last: 15 * 60 + 29 };
}

export interface MismatchLeg {
  refId: number;
  nubraName: string;
  /** Signed units: negative = short. */
  qty: number;
}

export interface MismatchVersion {
  /** Start of the earlier minute, epoch ns. */
  t1Ns: number;
  /** The live tick, epoch ns. */
  t2Ns: number;
  spot1: number;
  spot2: number;
  ce1: number;
  ce2: number;
  pe1: number;
  pe2: number;
  /** ₹ change in each leg's P&L between the two moments. */
  ceDelta: number;
  peDelta: number;
  /** |ceDelta − peDelta|. */
  gap: number;
}

export interface MismatchCase {
  caseNo: number;
  colorIdx: number;
  /** Oldest first. The last one is the strongest and defines the case. */
  versions: MismatchVersion[];
}

export interface StrategyLegs {
  basketGroupId: string;
  asset: string;
  exchange: 'NSE' | 'BSE' | 'MCX';
  /** Timeseries type of the underlying. MCX options are written on a future. */
  underlyingType: 'INDEX' | 'STOCK' | 'FUT';
  /** Earliest option expiry, YYYYMMDD, when the names carry it (MCX): picks the underlying future. */
  optionExpiry?: string;
  ce: MismatchLeg;
  pe: MismatchLeg;
  /** Epoch ns of the later leg's entry. */
  entryNs: number;
}

interface PositionLike {
  ref_id: number;
  nubraName: string;
  qty: number;
  basket_group_id?: string;
  entry_time?: number;
}

const INDEX_ASSETS = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX']);
const BSE_ASSETS = new Set(['SENSEX', 'BANKEX']);

/** `OPT_CRUDEOIL_20260917_CE_870000` → asset, expiry and side. */
const MCX_OPTION = /^OPT_([A-Z0-9]+)_(\d{8})_(CE|PE)_/;

/**
 * The strategy's CE and PE, or why it cannot be tracked. `today` (YYYY-MM-DD, IST) refuses MCX
 * series that have already expired, whose names no longer exist upstream.
 */
export function strategyLegs(
  positions: PositionLike[],
  basketGroupId: string,
  today?: string,
): { ok: true; legs: StrategyLegs } | { ok: false; reason: string } {
  const open = positions.filter((p) => p.qty !== 0 && (p.basket_group_id || '') === basketGroupId);
  if (!basketGroupId || open.length === 0) {
    return { ok: false, reason: 'no open strategy with this id' };
  }
  const parsed = open.map((p) => {
    const name = p.nubraName.toUpperCase();
    const mcx = MCX_OPTION.exec(name);
    if (mcx) return { p, asset: mcx[1], expiry: mcx[2], side: mcx[3], mcx: true };
    const side = /(CE|PE)$/.exec(name)?.[1] ?? '';
    return { p, asset: /^([A-Z&]+)\d/.exec(name)?.[1] ?? '', expiry: '', side, mcx: false };
  });
  const ces = parsed.filter((x) => x.side === 'CE');
  const pes = parsed.filter((x) => x.side === 'PE');
  if (open.length !== 2 || ces.length !== 1 || pes.length !== 1) {
    return { ok: false, reason: 'the strategy must be exactly one CE and one PE' };
  }
  const [ce, pe] = [ces[0], pes[0]];
  if (!ce.asset || ce.asset !== pe.asset || ce.mcx !== pe.mcx) {
    return { ok: false, reason: 'the CE and PE must be on the same underlying' };
  }
  const leg = (p: PositionLike): MismatchLeg => ({
    refId: p.ref_id,
    nubraName: p.nubraName,
    qty: p.qty,
  });
  const asset = ce.asset;
  const mcx = ce.mcx;
  const optionExpiry = [ce.expiry, pe.expiry].sort()[0];
  if (mcx && today && optionExpiry < today.replace(/-/g, '')) {
    return { ok: false, reason: `the options expired on ${optionExpiry}` };
  }
  return {
    ok: true,
    legs: {
      basketGroupId,
      asset,
      exchange: mcx ? 'MCX' : BSE_ASSETS.has(asset) ? 'BSE' : 'NSE',
      underlyingType: mcx ? 'FUT' : INDEX_ASSETS.has(asset) ? 'INDEX' : 'STOCK',
      ...(mcx ? { optionExpiry } : {}),
      ce: leg(ce.p),
      pe: leg(pe.p),
      entryNs: Math.max(ce.p.entry_time ?? 0, pe.p.entry_time ?? 0),
    },
  };
}

export function istDate(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** IST minutes past midnight. */
export function istMinute(ms: number): number {
  return Math.floor((ms + IST_OFFSET_MS) / MINUTE_MS) % 1440;
}

/** Epoch ms of an IST minute of an IST date. */
export function istMinuteToMs(date: string, minute: number): number {
  return Date.parse(`${date}T00:00:00Z`) - IST_OFFSET_MS + minute * MINUTE_MS;
}

type Kind = 'spot' | 'ce' | 'pe';
type Closes = Record<Kind, Map<number, number>>;
const emptyCloses = (): Closes => ({ spot: new Map(), ce: new Map(), pe: new Map() });

const round2 = (n: number) => Math.round(n * 100) / 100;

export class StrategyMismatchTracker {
  readonly legs: StrategyLegs;
  readonly cases: MismatchCase[];
  private date = '';
  /** Minute closes built from ticks. */
  private tickCloses = emptyCloses();
  /** Minute closes from the broker's 1m candles. They win over tick closes. */
  private brokerCloses = emptyCloses();
  private last: Partial<Record<Kind, number>> = {};

  constructor(legs: StrategyLegs, cases: MismatchCase[] = []) {
    this.legs = legs;
    this.cases = cases.map((c) => ({ ...c, versions: [...c.versions] }));
  }

  /** Replace one series' closes for `date` with the broker's. */
  setBrokerCloses(
    date: string,
    kind: Kind,
    closes: Array<{ minute: number; close: number }>,
  ): void {
    this.rollDate(date);
    const map = this.brokerCloses[kind];
    for (const { minute, close } of closes) {
      if (Number.isFinite(close) && close > 0) map.set(minute, close);
    }
  }

  closeAt(kind: Kind, minute: number): number | undefined {
    return this.brokerCloses[kind].get(minute) ?? this.tickCloses[kind].get(minute);
  }

  /**
   * One live update. Any of the three prices may be missing (a feed message carries only what
   * changed); the last known value stands in. Returns the cases that were created or gained a
   * version.
   */
  onTick(prices: Partial<Record<Kind, number>>, nowMs: number): MismatchCase[] {
    const date = istDate(nowMs);
    this.rollDate(date);
    const now = istMinute(nowMs);
    const session = sessionMinutes(this.legs.exchange);
    const inSession = now >= session.open && now <= session.last;
    for (const kind of ['spot', 'ce', 'pe'] as const) {
      const v = prices[kind];
      if (v != null && Number.isFinite(v) && v > 0) this.last[kind] = v;
      // Carried forward: a minute in which one leg did not tick still closed at its last price.
      const last = this.last[kind];
      if (inSession && last != null) this.tickCloses[kind].set(now, last);
    }
    const { spot, ce, pe } = this.last;
    if (spot == null || ce == null || pe == null || !inSession) return [];

    const p = MISMATCH_PARAMS;
    const entryMs = this.legs.entryNs / 1_000_000;
    const first =
      istDate(entryMs) === date ? Math.max(session.open, istMinute(entryMs)) : session.open;
    const ratio = p.legMismatchPct / 100;

    const candidates: MismatchVersion[] = [];
    for (let m = first; m <= now - p.minGapMinutes; m++) {
      const spot1 = this.closeAt('spot', m);
      if (spot1 == null || Math.abs(spot - spot1) > p.closeTolerance) continue;
      const ce1 = this.closeAt('ce', m);
      const pe1 = this.closeAt('pe', m);
      if (ce1 == null || pe1 == null) continue;
      const ceDelta = round2((ce - ce1) * this.legs.ce.qty);
      const peDelta = round2((pe - pe1) * this.legs.pe.qty);
      const gap = round2(Math.abs(ceDelta - peDelta));
      if (gap === 0 || gap < ratio * Math.max(Math.abs(ceDelta), Math.abs(peDelta))) continue;
      candidates.push({
        t1Ns: istMinuteToMs(date, m) * 1_000_000,
        t2Ns: nowMs * 1_000_000,
        spot1,
        spot2: spot,
        ce1,
        ce2: ce,
        pe1,
        pe2: pe,
        ceDelta,
        peDelta,
        gap,
      });
    }
    candidates.sort((a, b) => b.gap - a.gap || a.t1Ns - b.t1Ns);

    const nearNs = p.nearCopyMinutes * MINUTE_MS * 1_000_000;
    const isNear = (c: MismatchCase, v: MismatchVersion) => {
      const top = c.versions[c.versions.length - 1];
      return Math.abs(v.t1Ns - top.t1Ns) < nearNs && Math.abs(v.t2Ns - top.t2Ns) < nearNs;
    };
    const changed = new Set<MismatchCase>();
    for (const cand of candidates) {
      const near = this.cases.filter((c) => isNear(c, cand));
      if (near.length === 1) {
        const [match] = near;
        if (cand.gap > match.versions[match.versions.length - 1].gap) {
          match.versions.push(cand);
          changed.add(match);
        }
        continue;
      }
      // Near two cases at once: it belongs to neither. Giving it to one would pull that case onto
      // the other — on the 2026-09-16 replay that left 5 pairs of cases ending as the same
      // 09:55→afternoon moment. Skipping keeps every case distinct from every other.
      if (near.length > 1) continue;
      const caseNo = this.cases.length + 1;
      const created: MismatchCase = { caseNo, colorIdx: caseNo - 1, versions: [cand] };
      this.cases.push(created);
      changed.add(created);
    }
    return [...changed];
  }

  private rollDate(date: string): void {
    if (date === this.date) return;
    this.date = date;
    this.tickCloses = emptyCloses();
    this.brokerCloses = emptyCloses();
    this.last = {};
  }
}
