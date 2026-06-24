import { useState } from 'react';
import type {
  Leg, OptionType, Side, StrikeMethod, SLTargetType, ExpiryFlag, TrailType, ReentryMode,
} from './types';

interface Props {
  leg:      Leg;
  index:    number;
  onChange: (leg: Leg) => void;
  onRemove: () => void;
}

const inputCls =
  'w-full px-1.5 py-1 bg-[var(--bg-card)] border border-[var(--border)] rounded text-[12px] ' +
  'text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]';
const lblCls = 'text-[9px] uppercase tracking-wide text-[var(--text-muted)]';

const STRIKE_METHODS: { v: StrikeMethod; label: string }[] = [
  { v: 'ATM',                     label: 'ATM ± offset' },
  { v: 'CLOSEST_PREMIUM',         label: 'Closest premium' },
  { v: 'PREMIUM_GTE',             label: 'Premium ≥' },
  { v: 'PREMIUM_LTE',             label: 'Premium ≤' },
  { v: 'PREMIUM_RANGE',           label: 'Premium range' },
  { v: 'STRADDLE_WIDTH',          label: 'Straddle width' },
  { v: 'ATM_STRADDLE_PREMIUM_PCT',label: 'ATM straddle premium %' },
  { v: 'POINTS_FROM_SPOT',        label: 'Points from spot' },
  { v: 'PERCENT_FROM_SPOT',       label: '% from spot' },
  { v: 'FIXED_STRIKE',            label: 'Fixed strike' },
  { v: 'DELTA',                   label: 'Target delta' },
  { v: 'DELTA_RANGE',             label: 'Delta range' },
];
const RANGE_STRIKE = (m: StrikeMethod): boolean => m === 'PREMIUM_RANGE' || m === 'DELTA_RANGE';
const SL_TYPES: { v: SLTargetType; label: string }[] = [
  { v: 'NONE',              label: 'None' },
  { v: 'PREMIUM_PERCENT',   label: '% of premium' },
  { v: 'PREMIUM_ABSOLUTE',  label: 'Premium pts' },
  { v: 'UNDERLYING_POINTS', label: 'Underlying pts' },
  { v: 'UNDERLYING_PERCENT',label: 'Underlying %' },
  { v: 'DELTA',             label: 'Delta level' },
];
const TRAIL_TYPES: { v: TrailType; label: string }[] = [
  { v: 'NONE',           label: 'No trailing' },
  { v: 'TO_COST',        label: 'Move SL to cost' },
  { v: 'LOCK',           label: 'Lock profit' },
  { v: 'TRAIL',          label: 'Trail SL' },
  { v: 'LOCK_AND_TRAIL', label: 'Lock & trail' },
];
const REENTRY_MODES: { v: ReentryMode; label: string }[] = [
  { v: 'NONE',         label: 'No re-entry' },
  { v: 'ASAP',         label: 'Re-enter ASAP' },
  { v: 'COST',         label: 'Re-enter at cost' },
  { v: 'REVERSE_ASAP', label: 'Reverse & re-enter' },
];

export default function LegCard({ leg, index, onChange, onRemove }: Props) {
  const set = (patch: Partial<Leg>) => onChange({ ...leg, ...patch });
  const [advanced, setAdvanced] = useState(false);
  const trail = leg.trail ?? { type: 'NONE' as TrailType };
  const reentry = leg.reentry ?? { mode: 'NONE' as ReentryMode };
  const setTrail = (patch: Partial<typeof trail>) => set({ trail: { ...trail, ...patch } });
  const setReentry = (patch: Partial<typeof reentry>) => set({ reentry: { ...reentry, ...patch } });
  const isSell = leg.side === 'SELL';
  const isCall = leg.optionType === 'CALL';

  return (
    <div className={`rounded-lg border p-2 flex flex-col gap-2 ${leg.enabled ? 'border-[var(--border)] bg-[var(--bg-secondary)]' : 'border-[var(--border)] bg-[var(--bg-card)] opacity-55'}`}>
      {/* header row */}
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-[var(--text-muted)] font-mono">L{index + 1}</span>
        <button
          onClick={() => set({ optionType: (isCall ? 'PUT' : 'CALL') as OptionType })}
          className={`px-2 py-0.5 rounded text-[11px] font-bold ${isCall ? 'bg-sky-500/20 text-sky-400' : 'bg-fuchsia-500/20 text-fuchsia-400'}`}
        >{isCall ? 'CE' : 'PE'}</button>
        <button
          onClick={() => set({ side: (isSell ? 'BUY' : 'SELL') as Side })}
          className={`px-2 py-0.5 rounded text-[11px] font-bold ${isSell ? 'bg-[var(--red)]/20 text-[var(--red)]' : 'bg-[var(--green)]/20 text-[var(--green)]'}`}
        >{isSell ? 'SELL' : 'BUY'}</button>
        <div className="flex items-center gap-1 ml-auto">
          <span className={lblCls}>Lots</span>
          <input type="number" min={1} value={leg.lots}
            onChange={(e) => set({ lots: Math.max(1, Number(e.target.value) || 1) })}
            className="w-12 px-1.5 py-0.5 bg-[var(--bg-card)] border border-[var(--border)] rounded text-[12px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]" />
        </div>
        <button onClick={() => set({ enabled: !leg.enabled })} title="Enable/disable"
          className={`px-1.5 py-0.5 rounded text-[10px] ${leg.enabled ? 'text-[var(--green)]' : 'text-[var(--text-muted)]'}`}>
          {leg.enabled ? '●' : '○'}
        </button>
        <button onClick={onRemove} title="Remove leg"
          className="px-1.5 py-0.5 rounded text-[12px] text-[var(--text-muted)] hover:text-[var(--red)]">✕</button>
      </div>

      {/* expiry + strike */}
      <div className="grid grid-cols-2 gap-1.5">
        <label>
          <span className={lblCls}>Expiry</span>
          <select value={leg.expiry.flag}
            onChange={(e) => set({ expiry: { ...leg.expiry, flag: e.target.value as ExpiryFlag } })}
            className={inputCls}>
            <option value="WEEK">Weekly</option>
            <option value="MONTH">Monthly</option>
          </select>
        </label>
        <label>
          <span className={lblCls}>Expiry offset</span>
          <select value={leg.expiry.offset}
            onChange={(e) => set({ expiry: { ...leg.expiry, offset: Number(e.target.value) } })}
            className={inputCls}>
            <option value={0}>Current (0)</option>
            <option value={1}>Next (+1)</option>
            <option value={2}>Far (+2)</option>
            <option value={3}>+3</option>
          </select>
        </label>
        <label>
          <span className={lblCls}>Strike method</span>
          <select value={leg.strike.method}
            onChange={(e) => set({ strike: { ...leg.strike, method: e.target.value as StrikeMethod } })}
            className={inputCls}>
            {STRIKE_METHODS.map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
          </select>
        </label>
        <div>
          <span className={lblCls}>{strikeParamLabel(leg.strike.method)}</span>
          {RANGE_STRIKE(leg.strike.method) ? (
            <div className="flex gap-1">
              <input type="number" aria-label="min" placeholder="min" step={strikeStep(leg.strike.method)}
                value={strikeRangeVal(leg, 'lo')}
                onChange={(e) => set({ strike: { ...leg.strike, ...strikeRangePatch(leg.strike.method, 'lo', Number(e.target.value)) } })}
                className={inputCls} />
              <input type="number" aria-label="max" placeholder="max" step={strikeStep(leg.strike.method)}
                value={strikeRangeVal(leg, 'hi')}
                onChange={(e) => set({ strike: { ...leg.strike, ...strikeRangePatch(leg.strike.method, 'hi', Number(e.target.value)) } })}
                className={inputCls} />
            </div>
          ) : (
            <input type="number" value={strikeParamValue(leg)} step={strikeStep(leg.strike.method)}
              onChange={(e) => set({ strike: { ...leg.strike, ...strikeParamPatch(leg.strike.method, Number(e.target.value)) } })}
              className={inputCls} />
          )}
        </div>
      </div>

      {/* SL + target */}
      <div className="grid grid-cols-2 gap-1.5">
        <div className="flex gap-1">
          <label className="flex-1">
            <span className={lblCls}>Stop loss</span>
            <select value={leg.stopLoss.type}
              onChange={(e) => set({ stopLoss: { ...leg.stopLoss, type: e.target.value as SLTargetType } })}
              className={inputCls}>
              {SL_TYPES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
            </select>
          </label>
          {leg.stopLoss.type !== 'NONE' && (
            <label className="w-16">
              <span className={lblCls}>Val</span>
              <input type="number" value={leg.stopLoss.value ?? 0}
                onChange={(e) => set({ stopLoss: { ...leg.stopLoss, value: Number(e.target.value) } })}
                className={inputCls} />
            </label>
          )}
        </div>
        <div className="flex gap-1">
          <label className="flex-1">
            <span className={lblCls}>Target</span>
            <select value={leg.target.type}
              onChange={(e) => set({ target: { ...leg.target, type: e.target.value as SLTargetType } })}
              className={inputCls}>
              {SL_TYPES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
            </select>
          </label>
          {leg.target.type !== 'NONE' && (
            <label className="w-16">
              <span className={lblCls}>Val</span>
              <input type="number" value={leg.target.value ?? 0}
                onChange={(e) => set({ target: { ...leg.target, value: Number(e.target.value) } })}
                className={inputCls} />
            </label>
          )}
        </div>
      </div>

      {/* advanced: trailing + re-entry */}
      <button onClick={() => setAdvanced((v) => !v)}
        className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)] text-left flex items-center gap-1">
        <span>{advanced ? '▾' : '▸'}</span>
        <span>Trailing &amp; re-entry</span>
        {(trail.type !== 'NONE' || reentry.mode !== 'NONE') && (
          <span className="text-[var(--accent)]">●</span>
        )}
      </button>

      {advanced && (
        <div className="flex flex-col gap-1.5 pl-1 border-l-2 border-[var(--border)]">
          {/* trailing */}
          <label>
            <span className={lblCls}>Trailing stop</span>
            <select value={trail.type}
              onChange={(e) => setTrail({ type: e.target.value as TrailType })}
              className={inputCls}>
              {TRAIL_TYPES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
            </select>
          </label>
          {trail.type !== 'NONE' && (
            <div className="grid grid-cols-3 gap-1">
              <label>
                <span className={lblCls}>Trigger pts</span>
                <input type="number" value={trail.trigger ?? 0}
                  onChange={(e) => setTrail({ trigger: Number(e.target.value) })} className={inputCls} />
              </label>
              {(trail.type === 'LOCK' || trail.type === 'LOCK_AND_TRAIL') && (
                <label>
                  <span className={lblCls}>Lock pts</span>
                  <input type="number" value={trail.lock ?? 0}
                    onChange={(e) => setTrail({ lock: Number(e.target.value) })} className={inputCls} />
                </label>
              )}
              {(trail.type === 'TRAIL' || trail.type === 'LOCK_AND_TRAIL') && (
                <>
                  <label>
                    <span className={lblCls}>Every pts</span>
                    <input type="number" value={trail.step ?? 0}
                      onChange={(e) => setTrail({ step: Number(e.target.value) })} className={inputCls} />
                  </label>
                  <label>
                    <span className={lblCls}>Move SL pts</span>
                    <input type="number" value={trail.trail ?? 0}
                      onChange={(e) => setTrail({ trail: Number(e.target.value) })} className={inputCls} />
                  </label>
                </>
              )}
            </div>
          )}

          {/* re-entry */}
          <label>
            <span className={lblCls}>Re-entry</span>
            <select value={reentry.mode}
              onChange={(e) => setReentry({ mode: e.target.value as ReentryMode })}
              className={inputCls}>
              {REENTRY_MODES.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
            </select>
          </label>
          {reentry.mode !== 'NONE' && (
            <div className="flex items-center gap-2">
              <label className="w-20">
                <span className={lblCls}>Max times</span>
                <input type="number" min={0} value={reentry.max ?? 0}
                  onChange={(e) => setReentry({ max: Math.max(0, Number(e.target.value) || 0) })} className={inputCls} />
              </label>
              <label className="flex items-center gap-1 mt-3 text-[10px] text-[var(--text-secondary)]">
                <input type="checkbox" checked={reentry.onStopLoss ?? true}
                  onChange={(e) => setReentry({ onStopLoss: e.target.checked })} />
                on SL
              </label>
              <label className="flex items-center gap-1 mt-3 text-[10px] text-[var(--text-secondary)]">
                <input type="checkbox" checked={reentry.onTarget ?? false}
                  onChange={(e) => setReentry({ onTarget: e.target.checked })} />
                on target
              </label>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function strikeParamLabel(m: StrikeMethod): string {
  switch (m) {
    case 'ATM': return 'ATM offset (steps)';
    case 'CLOSEST_PREMIUM': return 'Target premium ₹';
    case 'PREMIUM_GTE': return 'Premium ≥ ₹';
    case 'PREMIUM_LTE': return 'Premium ≤ ₹';
    case 'PREMIUM_RANGE': return 'Premium range ₹';
    case 'STRADDLE_WIDTH': return 'Straddle width ×';
    case 'ATM_STRADDLE_PREMIUM_PCT': return '% of ATM straddle';
    case 'POINTS_FROM_SPOT': return 'Points (± )';
    case 'PERCENT_FROM_SPOT': return '% (± )';
    case 'FIXED_STRIKE': return 'Strike';
    case 'DELTA': return '|Delta| (0–1)';
    case 'DELTA_RANGE': return '|Delta| range';
  }
}
function strikeStep(m: StrikeMethod): number {
  switch (m) {
    case 'PERCENT_FROM_SPOT': return 0.5;
    case 'ATM': return 1;
    case 'FIXED_STRIKE': return 50;
    case 'DELTA':
    case 'DELTA_RANGE': return 0.05;
    case 'STRADDLE_WIDTH': return 0.1;
    case 'ATM_STRADDLE_PREMIUM_PCT': return 1;
    default: return 5; // premium-based criteria
  }
}
function strikeParamValue(leg: Leg): number {
  const s = leg.strike;
  switch (s.method) {
    case 'ATM': return s.atmOffset ?? 0;
    case 'CLOSEST_PREMIUM':
    case 'PREMIUM_GTE':
    case 'PREMIUM_LTE': return s.premiumTarget ?? 0;
    case 'STRADDLE_WIDTH': return s.straddleWidthMult ?? 1;
    case 'ATM_STRADDLE_PREMIUM_PCT': return s.straddlePremiumPct ?? 0;
    case 'POINTS_FROM_SPOT': return s.pointsFromSpot ?? 0;
    case 'PERCENT_FROM_SPOT': return s.percentFromSpot ?? 0;
    case 'FIXED_STRIKE': return s.absoluteStrike ?? 0;
    case 'DELTA': return s.targetDelta ?? 0.3;
    case 'PREMIUM_RANGE': return s.premiumMin ?? 0;   // unused (range UI), kept exhaustive
    case 'DELTA_RANGE': return s.deltaMin ?? 0;       // unused (range UI), kept exhaustive
  }
}
function strikeParamPatch(m: StrikeMethod, v: number): Partial<Leg['strike']> {
  switch (m) {
    case 'ATM': return { atmOffset: Math.round(v) };
    case 'CLOSEST_PREMIUM':
    case 'PREMIUM_GTE':
    case 'PREMIUM_LTE': return { premiumTarget: v };
    case 'STRADDLE_WIDTH': return { straddleWidthMult: v };
    case 'ATM_STRADDLE_PREMIUM_PCT': return { straddlePremiumPct: v };
    case 'POINTS_FROM_SPOT': return { pointsFromSpot: v };
    case 'PERCENT_FROM_SPOT': return { percentFromSpot: v };
    case 'FIXED_STRIKE': return { absoluteStrike: v };
    case 'DELTA': return { targetDelta: v };
    case 'PREMIUM_RANGE': return { premiumMin: v };   // unused (range UI), kept exhaustive
    case 'DELTA_RANGE': return { deltaMin: v };        // unused (range UI), kept exhaustive
  }
}
// Range criteria (Premium range / Delta range) use two inputs (lo + hi).
function strikeRangeVal(leg: Leg, side: 'lo' | 'hi'): number {
  const s = leg.strike;
  if (s.method === 'DELTA_RANGE') return (side === 'lo' ? s.deltaMin : s.deltaMax) ?? 0;
  return (side === 'lo' ? s.premiumMin : s.premiumMax) ?? 0; // PREMIUM_RANGE
}
function strikeRangePatch(m: StrikeMethod, side: 'lo' | 'hi', v: number): Partial<Leg['strike']> {
  if (m === 'DELTA_RANGE') return side === 'lo' ? { deltaMin: v } : { deltaMax: v };
  return side === 'lo' ? { premiumMin: v } : { premiumMax: v }; // PREMIUM_RANGE
}
