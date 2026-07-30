// ─────────────────────────────────────────────────────────────────────────────
// Live position auto-exit rules — SL/Target/Trailing on open paper positions,
// evaluated on every price tick. Reuses the exact premium SL/target math from
// the backtest engine (server/backtest/engine.ts) so live behaviour matches
// what a strategy designer already expects from backtesting the same rule.
//
// v1 scope: premium-based SL/target only (PREMIUM_PERCENT / PREMIUM_ABSOLUTE)
// plus a trailing stop, at both the individual leg (LEG) and whole basket
// group (GROUP, combined ₹ P&L) level. Underlying/delta-based SL are deferred
// (would need live spot + reconstructed greeks piped into this loop).
// ─────────────────────────────────────────────────────────────────────────────
import { liveLevels, type LiveSLTarget } from '../src/lib/positionRuleLevels.ts';
import type { TrailStop } from './backtest/types.ts';
import { dbUpsertPositionRule, dbLoadPositionRules, dbDeletePositionRule } from './paperDb.ts';

// The live rule vocabulary is a subset of the backtest's (premium-only) plus
// PREMIUM_PRICE, which is live-specific: a backtest leg has no single "current
// price" a user could name up front. Exported under the historical `SLTarget`
// name so server/index.ts's API types keep working unchanged.
export type SLTarget = LiveSLTarget;
export type { TrailStop };

export interface LegRule {
  scope: 'LEG';
  ref_id: number;
  basket_group_id: string; // '' if ungrouped — matches SimBroker's posKey convention
  stopLoss?: SLTarget; // type restricted to NONE | PREMIUM_PERCENT | PREMIUM_ABSOLUTE
  target?: SLTarget;
  trail?: TrailStop;
}
export interface GroupRule {
  scope: 'GROUP';
  basket_group_id: string;
  maxProfit?: number; // ₹, combined MTM across the group's open legs
  maxLoss?: number; // ₹, positive magnitude
  trail?: TrailStop; // trailing lock/giveback on combined ₹ MTM (entry treated as 0)
  exitAllOnLegHit?: boolean; // cascade: any single leg's own SL/target hit closes the whole group
}
export type PositionRule = LegRule | GroupRule;

export function legRuleKey(refId: number, basketGroupId?: string): string {
  return `${refId}:${basketGroupId || ''}`;
}

// Only these SL/target types are supported for live monitoring — anything else
// (underlying/delta) is silently downgraded to NONE at the API boundary.
const ALLOWED_SL_TYPES = new Set(['NONE', 'PREMIUM_PRICE', 'PREMIUM_PERCENT', 'PREMIUM_ABSOLUTE']);
export function sanitizeSLTarget(v: SLTarget | undefined): SLTarget {
  if (!v || !ALLOWED_SL_TYPES.has(v.type)) return { type: 'NONE' };
  return { type: v.type, value: v.value };
}

// ── mutable trailing-stop runtime state ──────────────────────────────────────
// Keyed identically to legRules. Reset whenever the position's entry_time no
// longer matches what the trail state was captured against — i.e. the position
// fully closed and a later order re-opened the same ref_id/basket_group_id key.
// Without this reset a fresh position would inherit a stale, already-tightened
// stop from a previous occupant of the same key.
interface TrailState {
  entryTimeSeen: number;
  slPriceRs: number | null; // tightened SL premium (₹), mirrors engine.ts Slot.slPrice
  favExtremeRs: number; // best premium seen since entry (₹), running high/low
}

const legRules = new Map<string, LegRule>();
const groupRules = new Map<string, GroupRule>();
const trailStates = new Map<string, TrailState>();

export function loadPositionRules(): void {
  for (const row of dbLoadPositionRules()) {
    try {
      const rule = JSON.parse(row.rule_json) as PositionRule;
      if (rule.scope === 'LEG') legRules.set(row.rule_key, rule);
      else if (rule.scope === 'GROUP') groupRules.set(row.rule_key, rule);
    } catch {
      /* skip corrupt row */
    }
  }
  console.log(
    `[PositionRules] Restored ${legRules.size} leg rule(s), ${groupRules.size} group rule(s)`,
  );
}

export function upsertLegRule(rule: LegRule): void {
  const key = legRuleKey(rule.ref_id, rule.basket_group_id);
  legRules.set(key, rule);
  trailStates.delete(key); // rule definition changed -> trailing restarts clean
  dbUpsertPositionRule(key, 'LEG', JSON.stringify(rule));
}

function groupTrailKey(basketGroupId: string): string {
  return `grp:${basketGroupId}`;
}

export function upsertGroupRule(rule: GroupRule): void {
  groupRules.set(rule.basket_group_id, rule);
  trailStates.delete(groupTrailKey(rule.basket_group_id)); // rule definition changed -> trailing restarts clean
  dbUpsertPositionRule(rule.basket_group_id, 'GROUP', JSON.stringify(rule));
}

export function deleteLegRule(refId: number, basketGroupId?: string): boolean {
  const key = legRuleKey(refId, basketGroupId);
  trailStates.delete(key);
  legRules.delete(key);
  return dbDeletePositionRule(key);
}

export function deleteGroupRule(basketGroupId: string): boolean {
  trailStates.delete(groupTrailKey(basketGroupId));
  groupRules.delete(basketGroupId);
  return dbDeletePositionRule(basketGroupId);
}

export function listPositionRules(): PositionRule[] {
  return [...legRules.values(), ...groupRules.values()];
}

// ── broker-facing structural types ───────────────────────────────────────────
// Deliberately duck-typed rather than importing SimBroker/SimPosition from
// index.ts, so this module has no dependency on the server entrypoint.
export interface RulePosition {
  ref_id: number;
  nubraName: string;
  display_name: string;
  qty: number; // signed: + long, - short
  avg_price: number; // paise
  last_traded_price: number; // paise
  order_delivery_type: string;
  basket_group_id?: string;
  entry_time?: number;
}
export interface RuleBroker {
  getPositions(): RulePosition[];
  placeOrder(p: {
    nubraName: string;
    liveRefId: number;
    display_name?: string;
    order_type: string;
    order_side: string;
    order_qty: number;
    order_delivery_type: string;
    validity_type: string;
    basket_group_id?: string;
  }): unknown;
}

export interface RuleFireEvent {
  scope: 'LEG' | 'GROUP';
  reason: 'STOPLOSS' | 'TARGET' | 'PORTFOLIO_TP' | 'PORTFOLIO_SL';
  ref_ids: number[];
  basket_group_id?: string;
}

function closePosition(broker: RuleBroker, pos: RulePosition): void {
  broker.placeOrder({
    nubraName: pos.nubraName,
    liveRefId: pos.ref_id,
    display_name: pos.display_name,
    order_type: 'ORDER_TYPE_MARKET',
    order_side: pos.qty > 0 ? 'ORDER_SIDE_SELL' : 'ORDER_SIDE_BUY',
    order_qty: Math.abs(pos.qty),
    order_delivery_type: pos.order_delivery_type,
    validity_type: 'DAY',
    basket_group_id: pos.basket_group_id || undefined,
  });
}

// Tighten a live trailing stop continuously (every tick, not per-bar like the
// backtest) and return the current SL premium level in rupees, or null if the
// trail hasn't triggered yet.
function applyLiveTrail(
  key: string,
  side: 'BUY' | 'SELL',
  entryRs: number,
  ltpRs: number,
  trail: TrailStop,
  entryTime: number | undefined,
): number | null {
  if (!trail || trail.type === 'NONE') return null;
  const sell = side === 'SELL';
  let st = trailStates.get(key);
  if (!st || st.entryTimeSeen !== (entryTime ?? 0)) {
    st = { entryTimeSeen: entryTime ?? 0, slPriceRs: null, favExtremeRs: entryRs };
    trailStates.set(key, st);
  }
  if (sell) {
    if (ltpRs < st.favExtremeRs) st.favExtremeRs = ltpRs;
  } else {
    if (ltpRs > st.favExtremeRs) st.favExtremeRs = ltpRs;
  }

  const favExtreme = sell ? entryRs - st.favExtremeRs : st.favExtremeRs - entryRs;
  const trigger = trail.trigger ?? 0;
  if (favExtreme < trigger) return st.slPriceRs;

  let candidate: number | null = null;
  if (trail.type === 'TO_COST') {
    candidate = entryRs;
  } else if (trail.type === 'LOCK') {
    const lock = trail.lock ?? 0;
    candidate = sell ? entryRs - lock : entryRs + lock;
  } else if (trail.type === 'TRAIL' || trail.type === 'LOCK_AND_TRAIL') {
    const step = trail.step && trail.step > 0 ? trail.step : 1;
    const move = trail.trail ?? 0;
    const steps = Math.floor((favExtreme - trigger) / step) + 1;
    const trailed = sell ? entryRs - steps * move : entryRs + steps * move;
    if (trail.type === 'LOCK_AND_TRAIL') {
      const lock = trail.lock ?? 0;
      const locked = sell ? entryRs - lock : entryRs + lock;
      candidate = sell ? Math.max(trailed, locked) : Math.min(trailed, locked);
    } else {
      candidate = trailed;
    }
  }
  if (candidate == null) return st.slPriceRs;
  st.slPriceRs =
    st.slPriceRs == null
      ? candidate
      : sell
        ? Math.min(st.slPriceRs, candidate)
        : Math.max(st.slPriceRs, candidate);
  return st.slPriceRs;
}

// Called from the live tick router right after a position's LTP is updated.
// Evaluates any LEG rule on the touched position(s) and any GROUP rule on
// their basket(s), firing opposite-side market exits through the broker on a
// hit. Returns the events that fired so the caller can broadcast them.
export function evaluateAndFire(broker: RuleBroker, changedRefId: number): RuleFireEvent[] {
  const events: RuleFireEvent[] = [];
  if (legRules.size === 0 && groupRules.size === 0) return events;

  const allPositions = broker.getPositions();
  const touched = allPositions.filter((p) => p.ref_id === changedRefId);

  for (const pos of touched) {
    const key = legRuleKey(pos.ref_id, pos.basket_group_id);
    const rule = legRules.get(key);
    if (!rule) continue;

    const side: 'BUY' | 'SELL' = pos.qty > 0 ? 'BUY' : 'SELL';
    const sell = side === 'SELL';
    const entryRs = pos.avg_price / 100;
    const ltpRs = pos.last_traded_price / 100;
    const sl = sanitizeSLTarget(rule.stopLoss);
    const tgt = sanitizeSLTarget(rule.target);
    const { slPrice, tgtPrice } = liveLevels(side, entryRs, sl, tgt);

    let hitReason: 'STOPLOSS' | 'TARGET' | null = null;
    if (slPrice != null && (sell ? ltpRs >= slPrice : ltpRs <= slPrice)) hitReason = 'STOPLOSS';
    else if (tgtPrice != null && (sell ? ltpRs <= tgtPrice : ltpRs >= tgtPrice))
      hitReason = 'TARGET';
    else if (rule.trail && rule.trail.type !== 'NONE') {
      const trailSl = applyLiveTrail(key, side, entryRs, ltpRs, rule.trail, pos.entry_time);
      if (trailSl != null && (sell ? ltpRs >= trailSl : ltpRs <= trailSl)) hitReason = 'STOPLOSS';
    }

    if (hitReason) {
      closePosition(broker, pos);
      deleteLegRule(pos.ref_id, pos.basket_group_id);
      events.push({
        scope: 'LEG',
        reason: hitReason,
        ref_ids: [pos.ref_id],
        basket_group_id: pos.basket_group_id,
      });

      // Cascade: this group wants every other leg squared off the moment any
      // one leg's own SL/target fires, not just on the combined ₹ threshold.
      const gid = pos.basket_group_id;
      const grpRule = gid ? groupRules.get(gid) : undefined;
      if (gid && grpRule?.exitAllOnLegHit) {
        const siblings = allPositions.filter(
          (p) => p.basket_group_id === gid && p.ref_id !== pos.ref_id,
        );
        for (const sib of siblings) {
          closePosition(broker, sib);
          deleteLegRule(sib.ref_id, sib.basket_group_id);
        }
        deleteGroupRule(gid);
        if (siblings.length) {
          events.push({
            scope: 'GROUP',
            reason: hitReason,
            ref_ids: siblings.map((p) => p.ref_id),
            basket_group_id: gid,
          });
        }
      }
    }
  }

  const groupIds = new Set(touched.map((p) => p.basket_group_id).filter((g): g is string => !!g));
  for (const gid of groupIds) {
    const rule = groupRules.get(gid);
    if (!rule) continue;
    const members = allPositions.filter((p) => p.basket_group_id === gid);
    if (!members.length) continue;
    const mtmRs = members.reduce(
      (s, p) => s + ((p.last_traded_price - p.avg_price) * p.qty) / 100,
      0,
    );

    let hit: 'PORTFOLIO_TP' | 'PORTFOLIO_SL' | null = null;
    if (rule.maxProfit && mtmRs >= rule.maxProfit) hit = 'PORTFOLIO_TP';
    else if (rule.maxLoss && mtmRs <= -Math.abs(rule.maxLoss)) hit = 'PORTFOLIO_SL';
    else if (rule.trail && rule.trail.type !== 'NONE') {
      // Combined MTM starts at 0 for the group ("entry"); anchor the trail's
      // episode to the earliest member entry_time so a full close + later
      // re-open of the group doesn't inherit a stale, already-tightened floor.
      const anchorTime = members.reduce((min, p) => Math.min(min, p.entry_time ?? 0), Infinity);
      const trailFloor = applyLiveTrail(
        groupTrailKey(gid),
        'BUY',
        0,
        mtmRs,
        rule.trail,
        anchorTime === Infinity ? 0 : anchorTime,
      );
      if (trailFloor != null && mtmRs <= trailFloor) hit = 'PORTFOLIO_SL';
    }

    if (hit) {
      for (const p of members) closePosition(broker, p);
      deleteGroupRule(gid);
      events.push({
        scope: 'GROUP',
        reason: hit,
        ref_ids: members.map((p) => p.ref_id),
        basket_group_id: gid,
      });
    }
  }

  return events;
}
