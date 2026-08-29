import type {
  AggLeg,
  ChainSnapshot,
  GreekName,
  OptionType,
  SeriesPoint,
} from './greekAggregator.ts';
import { IST_OFFSET, chartTimeDayKey } from './utils.ts';

export const BAND_DELTA_MIN = 0.05;
export const BAND_DELTA_MAX = 0.6;
export const BAND_ATM_CANDIDATE_WIDTH = 2;
export const BAND_ITM_FETCH_STRIKES = 2;
export const BAND_WIDE_OTM_FETCH_STRIKES = 24;
export const BAND_NARROW_OTM_FETCH_STRIKES = 16;

export interface ReferenceBandPoint {
  ts: number;
  spot: number;
  forward: number;
  atmStrike: number;
  rolled: boolean;
  callVegaChange: number;
  putVegaChange: number;
  callThetaChange: number;
  putThetaChange: number;
  callVegaTotal: number;
  putVegaTotal: number;
  callThetaTotal: number;
  putThetaTotal: number;
  callCount: number;
  putCount: number;
}

export interface BandContractMeta {
  name: string;
  strike: number;
  side: OptionType;
  expiry: string;
  refId?: number;
  lotSize?: number;
}

interface CarriedLeg extends AggLeg {
  key: string;
}

interface SideAggregate {
  vegaChange: number;
  thetaChange: number;
  vegaTotal: number;
  thetaTotal: number;
  count: number;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function normalizeBandDelta(delta: number | undefined): number | undefined {
  if (!finite(delta)) return undefined;
  return Math.abs(delta) > 1 ? delta / 100 : delta;
}

export function isBandMember(delta: number | undefined): boolean {
  const normalized = normalizeBandDelta(delta);
  return (
    normalized !== undefined &&
    Math.abs(normalized) >= BAND_DELTA_MIN &&
    Math.abs(normalized) <= BAND_DELTA_MAX
  );
}

function contractKey(leg: AggLeg, side: OptionType): string {
  return leg.key || `${side}:${leg.sp}:${leg.exp || ''}`;
}

/** Most frequent positive listed-strike difference; smaller difference wins a tie. */
export function inferBandStrikeStep(strikes: ReadonlyArray<number>): number {
  const unique = [...new Set(strikes.filter((value) => finite(value)))].sort((a, b) => a - b);
  const counts = new Map<number, number>();
  for (let i = 1; i < unique.length; i++) {
    const difference = unique[i] - unique[i - 1];
    if (difference > 0) counts.set(difference, (counts.get(difference) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = 0;
  for (const [difference, count] of counts) {
    if (count > bestCount || (count === bestCount && (!best || difference < best))) {
      best = difference;
      bestCount = count;
    }
  }
  return best;
}

function nearestStrikeIndex(strikes: ReadonlyArray<number>, anchor: number): number {
  let bestIndex = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < strikes.length; i++) {
    const distance = Math.abs(strikes[i] - anchor);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex;
}

function carryLeg(previous: CarriedLeg | undefined, update: AggLeg, side: OptionType): CarriedLeg {
  const next: CarriedLeg = previous
    ? { ...previous, key: previous.key }
    : { sp: update.sp, exp: update.exp, key: contractKey(update, side) };
  if (update.key) next.key = update.key;
  if (finite(update.sp)) next.sp = update.sp;
  if (update.exp) next.exp = update.exp;
  for (const field of ['bid', 'ask', 'delta', 'vega', 'theta', 'oi', 'iv'] as const) {
    const value = update[field];
    if (finite(value)) next[field] = value;
  }
  return next;
}

/**
 * Exact per-contract entry-baseline engine used by the default raw/floating/session Band view.
 * It jointly computes Vega and Theta so both Greeks observe the same membership transitions.
 */
export class ReferenceBandMachine {
  private day: string | null = null;
  private anchorForward: number | undefined;
  private previousAtm: number | undefined;
  private calls = new Map<string, CarriedLeg>();
  private puts = new Map<string, CarriedLeg>();
  private callEntryVega = new Map<string, number>();
  private callEntryTheta = new Map<string, number>();
  private putEntryVega = new Map<string, number>();
  private putEntryTheta = new Map<string, number>();

  reset(): void {
    this.day = null;
    this.anchorForward = undefined;
    this.previousAtm = undefined;
    this.calls.clear();
    this.puts.clear();
    this.callEntryVega.clear();
    this.callEntryTheta.clear();
    this.putEntryVega.clear();
    this.putEntryTheta.clear();
  }

  ingest(snapshot: ChainSnapshot): ReferenceBandPoint | null {
    const nextDay = chartTimeDayKey(Math.floor(snapshot.ts / 1000) + IST_OFFSET);
    if (nextDay !== this.day) {
      this.reset();
      this.day = nextDay;
    }

    for (const update of snapshot.ce) {
      const key = contractKey(update, 'CE');
      this.calls.set(key, carryLeg(this.calls.get(key), update, 'CE'));
    }
    for (const update of snapshot.pe) {
      const key = contractKey(update, 'PE');
      this.puts.set(key, carryLeg(this.puts.get(key), update, 'PE'));
    }

    let selectedAtm = this.previousAtm;
    let forward = this.anchorForward;
    let rolled = false;

    if (snapshot.requireBook) {
      if (!finite(snapshot.spot) || snapshot.spot <= 0) return null;
      const strikes = [
        ...new Set([...this.calls.values(), ...this.puts.values()].map((leg) => leg.sp)),
      ]
        .filter((strike) => finite(strike))
        .sort((a, b) => a - b);
      if (!strikes.length) return null;
      const seed = finite(this.anchorForward) ? this.anchorForward : snapshot.spot;
      const centre = nearestStrikeIndex(strikes, seed);
      const low = Math.max(0, centre - BAND_ATM_CANDIDATE_WIDTH);
      const high = Math.min(strikes.length - 1, centre + BAND_ATM_CANDIDATE_WIDTH);
      let best: { strike: number; straddle: number; forward: number } | null = null;

      for (let i = low; i <= high; i++) {
        const strike = strikes[i];
        const ce = [...this.calls.values()].find((leg) => leg.sp === strike);
        const pe = [...this.puts.values()].find((leg) => leg.sp === strike);
        if (!ce || !pe) continue;
        const ceBid = finite(ce.bid) ? ce.bid : 0;
        const ceAsk = finite(ce.ask) ? ce.ask : 0;
        const peBid = finite(pe.bid) ? pe.bid : 0;
        const peAsk = finite(pe.ask) ? pe.ask : 0;
        const combinedBid = ceBid + peBid;
        const combinedAsk = ceAsk + peAsk;
        if (!(combinedBid > 0) || !(combinedAsk > 0)) continue;
        const ceMid = (ceBid + ceAsk) / 2;
        const peMid = (peBid + peAsk) / 2;
        const straddle = (combinedBid + combinedAsk) / 2;
        const candidate = { strike, straddle, forward: strike + ceMid - peMid };
        if (!best || candidate.straddle < best.straddle) best = candidate;
      }
      if (!best) return null;
      rolled = this.previousAtm !== undefined && best.strike !== this.previousAtm;
      selectedAtm = best.strike;
      forward = best.forward;
      this.previousAtm = best.strike;
      this.anchorForward = best.forward;
    }

    const calls = this.aggregateSide(this.calls, this.callEntryVega, this.callEntryTheta);
    const puts = this.aggregateSide(this.puts, this.putEntryVega, this.putEntryTheta);
    return {
      ts: snapshot.ts,
      spot: finite(snapshot.spot) ? snapshot.spot : NaN,
      forward: finite(forward) ? forward : NaN,
      atmStrike: finite(selectedAtm) ? selectedAtm : NaN,
      rolled,
      callVegaChange: calls.vegaChange,
      putVegaChange: puts.vegaChange,
      callThetaChange: calls.thetaChange,
      putThetaChange: puts.thetaChange,
      callVegaTotal: calls.vegaTotal,
      putVegaTotal: puts.vegaTotal,
      callThetaTotal: calls.thetaTotal,
      putThetaTotal: puts.thetaTotal,
      callCount: calls.count,
      putCount: puts.count,
    };
  }

  private aggregateSide(
    legs: ReadonlyMap<string, CarriedLeg>,
    entryVega: Map<string, number>,
    entryTheta: Map<string, number>,
  ): SideAggregate {
    let vegaChange = 0;
    let thetaChange = 0;
    let vegaTotal = 0;
    let thetaTotal = 0;
    let hasVega = false;
    let hasTheta = false;
    let count = 0;

    for (const [key, leg] of legs) {
      if (!isBandMember(leg.delta)) {
        entryVega.delete(key);
        entryTheta.delete(key);
        continue;
      }
      count++;
      if (finite(leg.vega)) {
        if (!entryVega.has(key)) entryVega.set(key, leg.vega);
        vegaChange += leg.vega - entryVega.get(key)!;
        vegaTotal += leg.vega;
        hasVega = true;
      }
      if (finite(leg.theta)) {
        if (!entryTheta.has(key)) entryTheta.set(key, leg.theta);
        thetaChange += leg.theta - entryTheta.get(key)!;
        thetaTotal += leg.theta;
        hasTheta = true;
      }
    }
    return {
      vegaChange: hasVega ? vegaChange : NaN,
      thetaChange: hasTheta ? thetaChange : NaN,
      vegaTotal: hasVega ? vegaTotal : NaN,
      thetaTotal: hasTheta ? thetaTotal : NaN,
      count,
    };
  }
}

export function referenceBandPointToSeries(
  point: ReferenceBandPoint,
  greek: GreekName,
): SeriesPoint {
  return greek === 'vega'
    ? {
        ts: point.ts,
        ceTotal: point.callVegaTotal,
        peTotal: point.putVegaTotal,
        ceDiff: point.callVegaChange,
        peDiff: point.putVegaChange,
      }
    : {
        ts: point.ts,
        ceTotal: point.callThetaTotal,
        peTotal: point.putThetaTotal,
        ceDiff: point.callThetaChange,
        peDiff: point.putThetaChange,
      };
}

/** Restrict downloads; delta still decides membership at every accepted bar. */
export function referenceBandUniverse(
  contracts: ReadonlyArray<BandContractMeta>,
  spotValues: ReadonlyArray<number>,
  deltaMin = BAND_DELTA_MIN,
): Set<string> {
  const strikes = [...new Set(contracts.map((contract) => contract.strike))].sort((a, b) => a - b);
  const step = inferBandStrikeStep(strikes);
  if (!strikes.length || !(step > 0) || !spotValues.some((spot) => finite(spot) && spot > 0))
    return new Set(contracts.map((contract) => contract.name));
  const atms = spotValues
    .filter((spot) => finite(spot) && spot > 0)
    .map((spot) => strikes[nearestStrikeIndex(strikes, spot)]);
  const minAtm = Math.min(...atms);
  const maxAtm = Math.max(...atms);
  const minFetchAnchor = minAtm - BAND_ATM_CANDIDATE_WIDTH * step;
  const maxFetchAnchor = maxAtm + BAND_ATM_CANDIDATE_WIDTH * step;
  const wing =
    deltaMin <= BAND_DELTA_MIN ? BAND_WIDE_OTM_FETCH_STRIKES : BAND_NARROW_OTM_FETCH_STRIKES;
  const names = new Set<string>();
  for (const contract of contracts) {
    const inWindow =
      contract.side === 'CE'
        ? contract.strike >= minFetchAnchor - BAND_ITM_FETCH_STRIKES * step &&
          contract.strike <= maxFetchAnchor + wing * step
        : contract.strike >= minFetchAnchor - wing * step &&
          contract.strike <= maxFetchAnchor + BAND_ITM_FETCH_STRIKES * step;
    if (inWindow) names.add(contract.name);
  }
  return names;
}
