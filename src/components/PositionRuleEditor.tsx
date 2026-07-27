// Auto-exit rule editor for a live position (LEG) or a whole basket/strategy
// group (GROUP) on the Positions tab. Field layout mirrors the backtest's
// LegCard SL/Target/Trailing block (src/backtest/LegCard.tsx) and the
// portfolioRisk maxProfit/maxLoss inputs (Backtest.tsx) — same vocabulary,
// restricted to what's evaluable from live LTP alone (v1 scope).
import { useState } from 'react';
import type {
  LegPositionRule, GroupPositionRule, LiveSLTarget, LiveSLTargetType, LiveTrailStop, LiveTrailType,
} from '../types';
import { liveLevels, levelHit, type LiveSide } from '../lib/positionRuleLevels';

const inputCls =
  'w-full px-1.5 py-1 bg-[var(--bg-card)] border border-[var(--border)] rounded text-[12px] ' +
  'text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]';
const lblCls = 'text-[9px] uppercase tracking-wide text-[var(--text-muted)]';

// Labels spell out the unit, because getting this wrong silently disarms the
// rule: "84" as an offset on an ₹82.70 entry means exit at ₹166.70, not ₹84.
const SL_TYPES: { v: LiveSLTargetType; label: string }[] = [
  { v: 'NONE',             label: 'None' },
  { v: 'PREMIUM_PRICE',    label: 'Price ₹ (exit at)' },
  { v: 'PREMIUM_ABSOLUTE', label: 'Offset ₹ from entry' },
  { v: 'PREMIUM_PERCENT',  label: '% of entry premium' },
];
const valueUnit = (t: LiveSLTargetType) => (t === 'PREMIUM_PERCENT' ? '%' : '₹');
const rs = (v: number) => `₹${v.toFixed(2)}`;
const TRAIL_TYPES: { v: LiveTrailType; label: string }[] = [
  { v: 'NONE',           label: 'No trailing' },
  { v: 'TO_COST',        label: 'Move SL to cost' },
  { v: 'LOCK',           label: 'Lock profit' },
  { v: 'TRAIL',          label: 'Trail SL' },
  { v: 'LOCK_AND_TRAIL', label: 'Lock & trail' },
];

interface LegProps {
  mode: 'LEG';
  refId: number;
  basketGroupId: string;
  displayName: string;
  entryPriceRs: number;   // position avg price in ₹ — anchors the trigger preview
  side: LiveSide;
  ltpRs?: number;         // current premium, to flag a level that is already crossed
  initial: LegPositionRule | null;
  onClose: () => void;
  onSaved: () => void;
}
interface GroupProps {
  mode: 'GROUP';
  basketGroupId: string;
  strategyName: string;
  initial: GroupPositionRule | null;
  onClose: () => void;
  onSaved: () => void;
}
type Props = LegProps | GroupProps;

export default function PositionRuleEditor(props: Props) {
  const [saving, setSaving] = useState(false);
  const [stopLoss, setStopLoss] = useState<LiveSLTarget>(
    props.mode === 'LEG' ? (props.initial?.stopLoss ?? { type: 'NONE' }) : { type: 'NONE' },
  );
  const [target, setTarget] = useState<LiveSLTarget>(
    props.mode === 'LEG' ? (props.initial?.target ?? { type: 'NONE' }) : { type: 'NONE' },
  );
  const [trail, setTrail] = useState<LiveTrailStop>(props.initial?.trail ?? { type: 'NONE' });
  const [maxProfit, setMaxProfit] = useState<number>(
    props.mode === 'GROUP' ? (props.initial?.maxProfit ?? 0) : 0,
  );
  const [maxLoss, setMaxLoss] = useState<number>(
    props.mode === 'GROUP' ? (props.initial?.maxLoss ?? 0) : 0,
  );
  const [exitAllOnLegHit, setExitAllOnLegHit] = useState<boolean>(
    props.mode === 'GROUP' ? (props.initial?.exitAllOnLegHit ?? false) : false,
  );

  const hasExisting = !!props.initial;

  // Resolve what the user typed into the actual exit levels, with the same
  // function the server fires on — so the preview can never promise a level the
  // engine won't act at. Irrelevant in GROUP mode (combined ₹ P&L, not premium).
  const entryRs = props.mode === 'LEG' ? props.entryPriceRs : 0;
  const side: LiveSide = props.mode === 'LEG' ? props.side : 'BUY';
  const ltpRs  = props.mode === 'LEG' ? props.ltpRs : undefined;
  const { slPrice, tgtPrice } = liveLevels(side, entryRs, stopLoss, target);

  // "→ exits when LTP ≤ ₹81.50" beneath each field. Warnings are advisory only —
  // Save stays enabled, because an intentional exit at a loss is a real trade.
  function levelHint(kind: 'SL' | 'TARGET', level: number | null) {
    if (level == null) return null;
    const sell = side === 'SELL';
    const cmp = kind === 'SL' ? (sell ? '≥' : '≤') : (sell ? '≤' : '≥');
    let warn: string | null = null;
    if (ltpRs != null && levelHit(kind, side, level, ltpRs)) {
      warn = 'already past — this exits immediately';
    } else if (levelHit(kind, side, level, entryRs)) {
      warn = kind === 'SL'
        ? 'stop is on the profitable side of entry'
        : 'target is on the losing side of entry';
    }
    return (
      <div className={`text-[10px] mt-0.5 ${warn ? 'text-[var(--yellow)]' : 'text-[var(--text-muted)]'}`}>
        → exits when LTP {cmp} {rs(level)}{warn ? ` — ${warn}` : ''}
      </div>
    );
  }

  async function save() {
    setSaving(true);
    try {
      if (props.mode === 'LEG') {
        await fetch('/paper/positions/rules/leg', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ref_id: props.refId, basket_group_id: props.basketGroupId, stopLoss, target, trail }),
        });
      } else {
        await fetch('/paper/positions/rules/group', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            basket_group_id: props.basketGroupId, maxProfit: maxProfit || undefined, maxLoss: maxLoss || undefined,
            trail, exitAllOnLegHit,
          }),
        });
      }
      props.onSaved();
      props.onClose();
    } catch (e) { console.warn('[PositionRuleEditor] save failed:', e); }
    finally { setSaving(false); }
  }

  async function clearRule() {
    setSaving(true);
    try {
      if (props.mode === 'LEG') {
        await fetch(`/paper/positions/rules/leg?ref_id=${props.refId}&basket_group_id=${encodeURIComponent(props.basketGroupId)}`, { method: 'DELETE' });
      } else {
        await fetch(`/paper/positions/rules/group?basket_group_id=${encodeURIComponent(props.basketGroupId)}`, { method: 'DELETE' });
      }
      props.onSaved();
      props.onClose();
    } catch (e) { console.warn('[PositionRuleEditor] clear failed:', e); }
    finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={props.onClose}>
      <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-xl w-96 p-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <span className="text-[13px] font-semibold text-[var(--text-primary)]">
            {props.mode === 'LEG' ? `SL/Target — ${props.displayName}` : `Group SL/Target — ${props.strategyName}`}
          </span>
          <button onClick={props.onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-lg leading-none">&times;</button>
        </div>

        <div className="flex flex-col gap-2">
          {props.mode === 'LEG' ? (
            <div className="flex flex-col gap-2">
              <div className="text-[10px] text-[var(--text-muted)] -mt-1">
                Entry {rs(entryRs)} · <span className={side === 'BUY' ? 'text-[var(--green)]' : 'text-[var(--red)]'}>{side}</span>
                {ltpRs != null && <> · LTP {rs(ltpRs)}</>}
              </div>
              <div>
                <div className="flex gap-1.5">
                  <label className="flex-1 min-w-0">
                    <span className={lblCls}>Stop loss</span>
                    <select value={stopLoss.type} onChange={e => setStopLoss({ ...stopLoss, type: e.target.value as LiveSLTargetType })} className={inputCls}>
                      {SL_TYPES.map(s => <option key={s.v} value={s.v}>{s.label}</option>)}
                    </select>
                  </label>
                  {stopLoss.type !== 'NONE' && (
                    <label className="w-20 shrink-0">
                      <span className={lblCls}>Val {valueUnit(stopLoss.type)}</span>
                      <input type="number" step="any" value={stopLoss.value ?? 0} onChange={e => setStopLoss({ ...stopLoss, value: Number(e.target.value) })} className={inputCls} />
                    </label>
                  )}
                </div>
                {levelHint('SL', slPrice)}
              </div>
              <div>
                <div className="flex gap-1.5">
                  <label className="flex-1 min-w-0">
                    <span className={lblCls}>Target</span>
                    <select value={target.type} onChange={e => setTarget({ ...target, type: e.target.value as LiveSLTargetType })} className={inputCls}>
                      {SL_TYPES.map(s => <option key={s.v} value={s.v}>{s.label}</option>)}
                    </select>
                  </label>
                  {target.type !== 'NONE' && (
                    <label className="w-20 shrink-0">
                      <span className={lblCls}>Val {valueUnit(target.type)}</span>
                      <input type="number" step="any" value={target.value ?? 0} onChange={e => setTarget({ ...target, value: Number(e.target.value) })} className={inputCls} />
                    </label>
                  )}
                </div>
                {levelHint('TARGET', tgtPrice)}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-2 gap-2">
                <label><span className={lblCls}>Max profit ₹ (0=off)</span>
                  <input type="number" value={maxProfit} onChange={e => setMaxProfit(Number(e.target.value) || 0)} className={inputCls} /></label>
                <label><span className={lblCls}>Max loss ₹ (0=off)</span>
                  <input type="number" value={maxLoss} onChange={e => setMaxLoss(Number(e.target.value) || 0)} className={inputCls} /></label>
              </div>
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={exitAllOnLegHit} onChange={e => setExitAllOnLegHit(e.target.checked)} />
                <span className="text-[11px] text-[var(--text-primary)]">Exit all legs if any single leg hits its own SL/Target</span>
              </label>
            </div>
          )}

          <label>
            <span className={lblCls}>{props.mode === 'LEG' ? 'Trailing stop' : 'Trailing profit lock (combined ₹)'}</span>
            <select value={trail.type} onChange={e => setTrail({ ...trail, type: e.target.value as LiveTrailType })} className={inputCls}>
              {TRAIL_TYPES.map(t => (
                <option key={t.v} value={t.v}>
                  {props.mode === 'GROUP' && t.v === 'TO_COST' ? 'Give back to breakeven' : t.label}
                </option>
              ))}
            </select>
          </label>
          {trail.type !== 'NONE' && (
            <div className="grid grid-cols-3 gap-1">
              <label>
                <span className={lblCls}>Trigger {props.mode === 'LEG' ? 'pts' : '₹'}</span>
                <input type="number" value={trail.trigger ?? 0} onChange={e => setTrail({ ...trail, trigger: Number(e.target.value) })} className={inputCls} />
              </label>
              {(trail.type === 'LOCK' || trail.type === 'LOCK_AND_TRAIL') && (
                <label>
                  <span className={lblCls}>Lock {props.mode === 'LEG' ? 'pts' : '₹'}</span>
                  <input type="number" value={trail.lock ?? 0} onChange={e => setTrail({ ...trail, lock: Number(e.target.value) })} className={inputCls} />
                </label>
              )}
              {(trail.type === 'TRAIL' || trail.type === 'LOCK_AND_TRAIL') && (
                <>
                  <label>
                    <span className={lblCls}>Every {props.mode === 'LEG' ? 'pts' : '₹'}</span>
                    <input type="number" value={trail.step ?? 0} onChange={e => setTrail({ ...trail, step: Number(e.target.value) })} className={inputCls} />
                  </label>
                  <label>
                    <span className={lblCls}>Move SL {props.mode === 'LEG' ? 'pts' : '₹'}</span>
                    <input type="number" value={trail.trail ?? 0} onChange={e => setTrail({ ...trail, trail: Number(e.target.value) })} className={inputCls} />
                  </label>
                </>
              )}
            </div>
          )}
        </div>
        {props.mode === 'GROUP' && trail.type !== 'NONE' && (
          <p className="text-[10px] text-[var(--text-muted)] mt-1">
            e.g. trigger 1000, lock 500 → once combined profit reaches ₹1000, exit if it drops back to ₹500.
          </p>
        )}

        <div className="flex items-center gap-2 mt-4">
          {hasExisting && (
            <button onClick={clearRule} disabled={saving}
              className="px-2 py-1 rounded text-[11px] font-semibold text-[var(--red)] bg-[var(--red)]/10 hover:bg-[var(--red)]/25 border border-[var(--red)]/30 transition-colors">
              Clear rule
            </button>
          )}
          <button onClick={save} disabled={saving}
            className="ml-auto px-3 py-1 rounded text-[11px] font-semibold text-[var(--accent)] bg-[var(--accent)]/10 hover:bg-[var(--accent)]/25 border border-[var(--accent)]/30 transition-colors">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
