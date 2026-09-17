/**
 * Replays position auto-exit rules over the history a backdated paper entry already lived through.
 *
 * A trade entered "at 09:25" and placed at 10:00 has 35 minutes in which its stop-loss, target,
 * trailing stop or time exit might already have fired. The live engine (positionRules.ts) only
 * ever sees ticks from now on, so this walks today's traded seconds instead and reports every exit
 * that would have happened, with its second and price. It is pure: the caller applies the result.
 *
 * Choices, each the conservative reading of a 1-second bar whose intrabar order is unknown:
 *  - A leg's adverse extreme is tested before its favourable one: SL before target.
 *  - An exit fills at the level, unless the second opened beyond it (a gap), then at that open.
 *  - A time exit fills at the open of the first trade at or after the named minute.
 *  - A group's combined ₹ uses each leg's last close, carried forward. Highs and lows of different
 *    legs never happened at the same moment, so combining them would invent a P&L nobody saw.
 *
 * The trailing-stop step mirrors `applyLiveTrail` in positionRules.ts line for line;
 * positionRuleReplay.test.ts drives both on the same prices and pins them to the same exits.
 * That function is not imported (it is private and keyed on live state) and not modified.
 */
import { exitTimeMinutes, liveLevels } from '../src/lib/positionRuleLevels.ts';
import type { TrailStop } from './backtest/types.ts';
import type { GroupRule, LegRule } from './positionRules.ts';

export interface ReplayBar {
  /** IST seconds past midnight. */
  sec: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ReplayLeg {
  ref_id: number;
  basket_group_id: string;
  /** Signed: + long, − short. */
  qty: number;
  entryRs: number;
  entrySec: number;
  bars: ReplayBar[];
}

export type ReplayReason = 'STOPLOSS' | 'TARGET' | 'PORTFOLIO_TP' | 'PORTFOLIO_SL' | 'TIME_EXIT';

export interface ReplayExit {
  scope: 'LEG' | 'GROUP';
  reason: ReplayReason;
  ref_id: number;
  basket_group_id: string;
  sec: number;
  priceRs: number;
}

export interface TrailRuntime {
  slPriceRs: number | null;
  favExtremeRs: number;
}

export interface ReplayOutcome {
  exits: ReplayExit[];
  /** Trailing state of every leg rule still armed at the end, to seed the live engine with. */
  legTrails: Array<{ ref_id: number; basket_group_id: string; state: TrailRuntime }>;
  groupTrail: TrailRuntime | null;
  /** Leg rules that fired (or were cascaded away) and must be deleted, as the live engine does. */
  legRulesSpent: Array<{ ref_id: number; basket_group_id: string }>;
  groupRuleSpent: boolean;
}

/** `applyLiveTrail`'s tightening step without its state map: same inputs, same arithmetic. */
export function stepTrail(
  st: TrailRuntime,
  side: 'BUY' | 'SELL',
  entryRs: number,
  priceRs: number,
  trail: TrailStop | undefined,
): number | null {
  if (!trail || trail.type === 'NONE') return null;
  const sell = side === 'SELL';
  if (sell) {
    if (priceRs < st.favExtremeRs) st.favExtremeRs = priceRs;
  } else if (priceRs > st.favExtremeRs) st.favExtremeRs = priceRs;

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

const legKey = (refId: number, gid: string) => `${refId}:${gid || ''}`;

/** Did a leg's rule fire inside this second? Mutates the trailing state as the second is lived. */
function legSecondHit(
  leg: ReplayLeg,
  rule: LegRule,
  bar: ReplayBar,
  st: TrailRuntime,
): { reason: ReplayReason; priceRs: number } | null {
  const sell = leg.qty < 0;
  const side = sell ? 'SELL' : 'BUY';

  const exitMin = exitTimeMinutes(rule.exitTime);
  if (exitMin != null && bar.sec >= exitMin * 60) return { reason: 'TIME_EXIT', priceRs: bar.open };

  // A level on the loss side of a short is above; the open is "beyond" it when at or past it.
  const lossHit = (level: number) => (sell ? bar.high >= level : bar.low <= level);
  const lossFill = (level: number) =>
    (sell ? bar.open >= level : bar.open <= level) ? bar.open : level;

  const { slPrice, tgtPrice } = liveLevels(side, leg.entryRs, rule.stopLoss, rule.target);
  if (slPrice != null && lossHit(slPrice))
    return { reason: 'STOPLOSS', priceRs: lossFill(slPrice) };
  if (tgtPrice != null && (sell ? bar.low <= tgtPrice : bar.high >= tgtPrice)) {
    const gapped = sell ? bar.open <= tgtPrice : bar.open >= tgtPrice;
    return { reason: 'TARGET', priceRs: gapped ? bar.open : tgtPrice };
  }
  if (rule.trail && rule.trail.type !== 'NONE') {
    // The stop already standing is tested against this second's worst price first; only then may
    // this second's best price tighten it, and the tightened stop sees the second's close.
    if (st.slPriceRs != null && lossHit(st.slPriceRs)) {
      return { reason: 'STOPLOSS', priceRs: lossFill(st.slPriceRs) };
    }
    const sl = stepTrail(st, side, leg.entryRs, sell ? bar.low : bar.high, rule.trail);
    if (sl != null && (sell ? bar.close >= sl : bar.close <= sl)) {
      return { reason: 'STOPLOSS', priceRs: sl };
    }
  }
  return null;
}

export function replayRules(
  legs: ReplayLeg[],
  legRules: LegRule[],
  groupRule: GroupRule | undefined,
  nowSec: number,
): ReplayOutcome {
  const exits: ReplayExit[] = [];
  const legRulesSpent: ReplayOutcome['legRulesSpent'] = [];
  const rules = new Map(legRules.map((r) => [legKey(r.ref_id, r.basket_group_id), r]));
  const open = new Map(legs.map((l) => [legKey(l.ref_id, l.basket_group_id), l]));
  const last = new Map(legs.map((l) => [legKey(l.ref_id, l.basket_group_id), l.entryRs]));
  const trails = new Map(
    legs.map((l) => [
      legKey(l.ref_id, l.basket_group_id),
      { slPriceRs: null, favExtremeRs: l.entryRs } as TrailRuntime,
    ]),
  );
  const barsBySec = new Map(
    legs.map((l) => [
      legKey(l.ref_id, l.basket_group_id),
      new Map(l.bars.filter((b) => b.sec > l.entrySec && b.sec <= nowSec).map((b) => [b.sec, b])),
    ]),
  );
  const timeline = [...new Set([...barsBySec.values()].flatMap((m) => [...m.keys()]))].sort(
    (a, b) => a - b,
  );

  let group = groupRule;
  const groupTrail: TrailRuntime = { slPriceRs: null, favExtremeRs: 0 };
  const groupExitMin = exitTimeMinutes(group?.exitTime);

  const close = (
    key: string,
    sec: number,
    priceRs: number,
    reason: ReplayReason,
    scope: 'LEG' | 'GROUP',
  ) => {
    const leg = open.get(key);
    if (!leg) return;
    open.delete(key);
    exits.push({
      scope,
      reason,
      ref_id: leg.ref_id,
      basket_group_id: leg.basket_group_id,
      sec,
      priceRs,
    });
    if (rules.has(key)) {
      rules.delete(key);
      legRulesSpent.push({ ref_id: leg.ref_id, basket_group_id: leg.basket_group_id });
    }
  };
  /** Price of a leg at the start of a second: its open if it traded then, else its last close. */
  const priceAtStart = (key: string, sec: number) =>
    barsBySec.get(key)!.get(sec)?.open ?? last.get(key)!;

  for (const sec of timeline) {
    if (!open.size) break;

    // 1. A group time exit happens at the first moment of the named minute, before anything
    //    inside this second can move.
    if (group && groupExitMin != null && sec >= groupExitMin * 60) {
      for (const key of [...open.keys()])
        close(key, sec, priceAtStart(key, sec), 'TIME_EXIT', 'GROUP');
      group = undefined;
      break;
    }

    // 2. Leg rules on the legs that traded this second.
    for (const [key, leg] of [...open]) {
      const bar = barsBySec.get(key)!.get(sec);
      const rule = rules.get(key);
      if (!bar || !rule) continue;
      const hit = legSecondHit(leg, rule, bar, trails.get(key)!);
      if (!hit) continue;
      close(key, sec, hit.priceRs, hit.reason, 'LEG');
      if (group?.exitAllOnLegHit) {
        for (const sib of [...open.keys()])
          close(sib, sec, priceAtStart(sib, sec), hit.reason, 'GROUP');
        group = undefined;
      }
    }

    // 3. Carry each traded leg's close forward.
    for (const key of open.keys()) {
      const bar = barsBySec.get(key)!.get(sec);
      if (bar) last.set(key, bar.close);
    }

    // 4. Group thresholds on the combined ₹ of the legs still open.
    if (group && open.size) {
      let mtm = 0;
      for (const [key, leg] of open) mtm += (last.get(key)! - leg.entryRs) * leg.qty;
      let reason: ReplayReason | null = null;
      if (group.maxProfit && mtm >= group.maxProfit) reason = 'PORTFOLIO_TP';
      else if (group.maxLoss && mtm <= -Math.abs(group.maxLoss)) reason = 'PORTFOLIO_SL';
      else if (group.trail && group.trail.type !== 'NONE') {
        if (groupTrail.slPriceRs != null && mtm <= groupTrail.slPriceRs) reason = 'PORTFOLIO_SL';
        else {
          const floor = stepTrail(groupTrail, 'BUY', 0, mtm, group.trail);
          if (floor != null && mtm <= floor) reason = 'PORTFOLIO_SL';
        }
      }
      if (reason) {
        for (const key of [...open.keys()]) close(key, sec, last.get(key)!, reason, 'GROUP');
        group = undefined;
      }
    }
  }

  // Time exits whose minute has passed but whose leg never traded again: the live sweep would have
  // squared them off at the last price it had, at that minute.
  if (group && groupExitMin != null && groupExitMin * 60 <= nowSec && open.size) {
    for (const key of [...open.keys()])
      close(key, groupExitMin * 60, last.get(key)!, 'TIME_EXIT', 'GROUP');
    group = undefined;
  }
  for (const [key] of [...open]) {
    const exitMin = exitTimeMinutes(rules.get(key)?.exitTime);
    if (exitMin != null && exitMin * 60 <= nowSec)
      close(key, exitMin * 60, last.get(key)!, 'TIME_EXIT', 'LEG');
  }

  const groupRuleSpent = !!groupRule && !group;
  if (groupRuleSpent) {
    // The live engine deletes the leg rules of every leg a group exit closed.
    for (const e of exits) {
      const key = legKey(e.ref_id, e.basket_group_id);
      if (
        e.scope === 'GROUP' &&
        !legRulesSpent.some((s) => legKey(s.ref_id, s.basket_group_id) === key)
      ) {
        if (legRules.some((r) => legKey(r.ref_id, r.basket_group_id) === key)) {
          legRulesSpent.push({ ref_id: e.ref_id, basket_group_id: e.basket_group_id });
        }
      }
    }
  }

  return {
    exits,
    legTrails: [...open.values()]
      .filter((l) => rules.get(legKey(l.ref_id, l.basket_group_id))?.trail?.type)
      .map((l) => ({
        ref_id: l.ref_id,
        basket_group_id: l.basket_group_id,
        state: trails.get(legKey(l.ref_id, l.basket_group_id))!,
      })),
    groupTrail: group?.trail && group.trail.type !== 'NONE' ? groupTrail : null,
    legRulesSpent,
    groupRuleSpent,
  };
}
