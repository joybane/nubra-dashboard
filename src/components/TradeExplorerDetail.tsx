/**
 * The Trade Explorer's trade detail, laid out like the day view in the Strangle Max Loss report: the
 * key facts, the signal as a t1 / t2 table in words, the greeks, the IV signal with its working, the
 * option chain at the signal minute, then the day's chart.
 */
import { useEffect, useState, type ReactNode } from 'react';
import SignalDayChart from './SignalDayChart';
import { IV_CUTS, IV_LEVELS } from '../lib/ivSignal';
import {
  COLUMN_BY_KEY,
  formatCell,
  formatClock,
  type Column,
  type DayRow,
} from '../lib/tradeExplorer';
import type { GreekKey, SignalUnderlying } from '../lib/signalBacktest';
import type { Theme } from '../types';

const LEVEL_COLOR = [
  'var(--blue)',
  'var(--cyan)',
  'var(--text-secondary)',
  'var(--yellow)',
  'var(--red)',
];

const rupee = (v: number | null | undefined) =>
  v == null ? '–' : `${v < 0 ? '−' : ''}₹${Math.round(Math.abs(v)).toLocaleString('en-IN')}`;
const signedRupee = (v: number | null | undefined) =>
  v == null ? '–' : `${v > 0 ? '+' : ''}${rupee(v)}`;
const plain = (v: number | null | undefined, digits = 2) =>
  v == null
    ? '–'
    : `${v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('en-IN', {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })}`;
const colorOf = (v: number | null | undefined) =>
  v == null || v === 0 ? undefined : v < 0 ? 'var(--red)' : 'var(--green)';

function Panel({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <details open className="rounded border border-[var(--border)] bg-[var(--bg-card)] p-2">
      <summary className="mb-1 cursor-pointer text-[13px] font-semibold">{title}</summary>
      {children}
    </details>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="rounded bg-[var(--bg-secondary)] px-1.5 py-0.5">
      <span className="text-[var(--text-muted)]">{label}</span>{' '}
      <b className="font-mono">{children}</b>
    </span>
  );
}

const th = 'px-1.5 py-1 text-right font-normal text-[var(--text-muted)]';
const td = 'border-t border-[var(--border)] px-1.5 py-0.5 text-right font-mono';
const tdName = 'border-t border-[var(--border)] px-1.5 py-0.5 text-left';

function SignalPanel({ row, underlying }: { row: DayRow; underlying: SignalUnderlying }) {
  const { signal: s, trade: t } = row.raw;
  const pct = row.values.gapPct as number | null;
  const spotMove = s.spot2 - s.spot1;
  const sentence = (v: number) =>
    v >= 0 ? `made the seller ${rupee(v)}` : `cost the seller ${rupee(-v)}`;
  return (
    <Panel title="The signal">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr>
            <th className={`${th} text-left`} />
            <th className={th}>t1 {s.t1}</th>
            <th className={th}>t2 {s.t2}</th>
            <th className={th}>Change for the seller</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className={tdName}>{underlying}</td>
            <td className={td}>{plain(s.spot1)}</td>
            <td className={td}>{plain(s.spot2)}</td>
            <td className={td}>
              {spotMove >= 0 ? '+' : '−'}
              {Math.abs(spotMove).toFixed(1)} pts
            </td>
          </tr>
          <tr>
            <td className={tdName}>Call {s.legs.ceStrike}</td>
            <td className={td}>₹{plain(s.ce1)}</td>
            <td className={td}>₹{plain(s.ce2)}</td>
            <td className={td} style={{ color: colorOf(s.ceDelta) }}>
              {signedRupee(s.ceDelta)}
            </td>
          </tr>
          <tr>
            <td className={tdName}>Put {s.legs.peStrike}</td>
            <td className={td}>₹{plain(s.pe1)}</td>
            <td className={td}>₹{plain(s.pe2)}</td>
            <td className={td} style={{ color: colorOf(s.peDelta) }}>
              {signedRupee(s.peDelta)}
            </td>
          </tr>
          <tr>
            <td className={tdName}>Both legs</td>
            <td className={td} />
            <td className={td} />
            <td className={td} style={{ color: colorOf(s.totalDelta) }}>
              {signedRupee(s.totalDelta)}
            </td>
          </tr>
          <tr className="font-semibold">
            <td className={tdName}>Difference between the legs</td>
            <td className={td} />
            <td className={td}>{pct == null ? '' : `${Math.round(pct)}% of the bigger leg`}</td>
            <td className={td}>{rupee(s.gap)}</td>
          </tr>
        </tbody>
      </table>
      <p className="mt-1.5 text-[11px] leading-snug text-[var(--text-secondary)]">
        At {s.t1} and {s.t2}, {underlying} stood at the same level. The two legs still moved
        differently: the call {sentence(s.ceDelta)} and the put {sentence(s.peDelta)}, so they
        disagree by <b>{rupee(s.gap)}</b>
        {pct != null && (
          <>
            , which is <b>{Math.round(pct)}%</b> of the bigger leg
          </>
        )}
        . The rule needs at least 50%. These are the {s.legs.entryTime} legs, ₹ for 1 lot of {t.qty}
        . You sold {t.entryTime === s.t2 ? 'at the signal' : `one minute later, at ${t.entryTime}`}.
      </p>
    </Panel>
  );
}

const GREEK_ROWS: Array<{ key: GreekKey; label: string; digits: number }> = [
  { key: 'iv', label: 'IV %', digits: 2 },
  { key: 'delta', label: 'Delta', digits: 3 },
  { key: 'gamma', label: 'Gamma', digits: 5 },
  { key: 'theta', label: 'Theta', digits: 2 },
  { key: 'vega', label: 'Vega', digits: 2 },
];

function GreeksPanel({ row }: { row: DayRow }) {
  const g = row.raw.signal.greeks;
  const change = (a: number | undefined, b: number | undefined, digits: number) =>
    a == null || b == null ? '–' : `${b - a >= 0 ? '+' : '−'}${Math.abs(b - a).toFixed(digits)}`;
  return (
    <Panel title="Greeks and IV at the signal">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr>
            <th className={`${th} text-left`} />
            <th className={th}>Call t1</th>
            <th className={th}>Call t2</th>
            <th className={th}>Change</th>
            <th className={th}>Put t1</th>
            <th className={th}>Put t2</th>
            <th className={th}>Change</th>
          </tr>
        </thead>
        <tbody>
          {GREEK_ROWS.map(({ key, label, digits }) => (
            <tr key={key}>
              <td className={tdName}>{label}</td>
              <td className={td}>{plain(g?.t1.CE?.[key], digits)}</td>
              <td className={td}>{plain(g?.t2.CE?.[key], digits)}</td>
              <td className={td}>{change(g?.t1.CE?.[key], g?.t2.CE?.[key], digits)}</td>
              <td className={td}>{plain(g?.t1.PE?.[key], digits)}</td>
              <td className={td}>{plain(g?.t2.PE?.[key], digits)}</td>
              <td className={td}>{change(g?.t1.PE?.[key], g?.t2.PE?.[key], digits)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-[10px] text-[var(--text-muted)]">
        Per option, for the {row.raw.signal.legs.entryTime} legs.
      </p>
    </Panel>
  );
}

function IvPanel({ row, underlying }: { row: DayRow; underlying: SignalUnderlying }) {
  const v = row.values;
  const dte = row.raw.dte;
  const cuts = dte != null ? IV_CUTS[underlying][dte] : undefined;
  const ratio = v.ivRatio as number | null;
  if (!cuts || ratio == null) {
    return (
      <Panel title="IV signal for this day">
        <p className="text-[11px] text-[var(--text-muted)]">
          No reading: it needs at least 4 earlier days with the same days to expiry, and only covers
          0 to 4 days to expiry.
        </p>
      </Panel>
    );
  }
  const level = IV_LEVELS.indexOf(v.ivLevel as (typeof IV_LEVELS)[number]);
  const g = row.raw.signal.greeks?.t2;
  const range = (i: number) =>
    i === 0
      ? `up to ${cuts[0].toFixed(2)}×`
      : i === cuts.length
        ? `above ${cuts[i - 1].toFixed(2)}×`
        : `${cuts[i - 1].toFixed(2)}–${cuts[i].toFixed(2)}×`;
  return (
    <Panel title="IV signal for this day">
      <div className="text-[14px] font-bold" style={{ color: LEVEL_COLOR[level] }}>
        {IV_LEVELS[level]} · {ratio.toFixed(2)}× its usual level
      </div>
      <div className="my-1 flex overflow-hidden rounded">
        {IV_LEVELS.map((name, i) => (
          <div
            key={name}
            className="flex-1 border-r border-[var(--bg-card)] px-1 py-0.5 text-center text-[10px]"
            style={{
              background: i === level ? LEVEL_COLOR[i] : 'var(--bg-secondary)',
              color: i === level ? 'var(--bg-primary)' : 'var(--text-muted)',
              fontWeight: i === level ? 700 : 400,
            }}
          >
            {name}
            <div className="font-mono text-[9px]">{range(i)}</div>
          </div>
        ))}
      </div>
      <p className="text-[11px] leading-snug text-[var(--text-secondary)]">
        At the signal, the {row.raw.signal.legs.ceStrike} call had an IV of{' '}
        <b>{plain(g?.CE?.iv)}%</b> and the {row.raw.signal.legs.peStrike} put{' '}
        <b>{plain(g?.PE?.iv)}%</b>: on average <b>{plain(v.ivNow as number)}%</b>. The usual level,
        the middle of the last 20 readings with the same days to expiry, is{' '}
        <b>{plain(v.ivUsual as number)}%</b>. So{' '}
        <b>
          {plain(v.ivNow as number)} ÷ {plain(v.ivUsual as number)} = {ratio.toFixed(2)}×
        </b>
        .
      </p>
    </Panel>
  );
}

interface ChainSide {
  close: number;
  iv: number | null;
  delta: number | null;
  volume: number | null;
  oi: number | null;
}
interface ChainResponse {
  ok: true;
  time: string;
  expiry: string;
  spot: number;
  forward: number | null;
  atm: number;
  rows: Array<{ strike: number; ce: ChainSide | null; pe: ChainSide | null }>;
}

function ChainPanel({ row, underlying }: { row: DayRow; underlying: SignalUnderlying }) {
  const { raw } = row;
  const [chain, setChain] = useState<ChainResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    setChain(null);
    setError(null);
    const qs = new URLSearchParams({
      underlying,
      date: raw.date,
      source: raw.source,
      time: raw.signal.t2,
    });
    fetch(`/api/signal-backtest/chain?${qs}`, { signal: ctl.signal })
      .then(async (res) => {
        const body = await res.json();
        if (body.ok) setChain(body as ChainResponse);
        else setError(body.error ?? 'The chain could not be read.');
      })
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setError(String(e));
      });
    return () => ctl.abort();
  }, [underlying, raw.date, raw.source, raw.signal.t2]);

  if (error) {
    return (
      <Panel title="Option chain at the signal">
        <p className="text-[11px] text-[var(--red)]">{error}</p>
      </Panel>
    );
  }
  if (!chain) {
    return (
      <Panel title="Option chain at the signal">
        <p className="text-[11px] text-[var(--text-muted)]">Loading the chain…</p>
      </Panel>
    );
  }
  const sold = (kind: 'CE' | 'PE', strike: number) =>
    raw.trade.legs.some((l) => l.kind === kind && l.strike === strike);
  const ref = (kind: 'CE' | 'PE', strike: number) =>
    (kind === 'CE' ? raw.signal.legs.ceStrike : raw.signal.legs.peStrike) === strike;
  const hasFlow = chain.rows.some((r) => r.ce?.oi != null || r.pe?.oi != null);
  const cls = (kind: 'CE' | 'PE', strike: number, itm: boolean) =>
    `${td} ${sold(kind, strike) ? 'bg-[var(--accent)]/25 font-semibold' : itm ? 'bg-[var(--bg-secondary)]' : ''}`;
  return (
    <Panel
      title={
        <>
          Option chain at the signal, {chain.time}{' '}
          <span className="font-normal text-[var(--text-muted)]">
            spot {plain(chain.spot)} · forward {plain(chain.forward)} · expiry {chain.expiry}
          </span>
        </>
      }
    >
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr>
            {hasFlow && <th className={th}>OI</th>}
            {hasFlow && <th className={th}>Vol</th>}
            <th className={th}>Delta</th>
            <th className={th}>IV</th>
            <th className={th}>Call</th>
            <th className={`${th} text-center`}>Strike</th>
            <th className={th}>Put</th>
            <th className={th}>IV</th>
            <th className={th}>Delta</th>
            {hasFlow && <th className={th}>Vol</th>}
            {hasFlow && <th className={th}>OI</th>}
          </tr>
        </thead>
        <tbody>
          {chain.rows.map((r) => {
            const ceItm = r.strike < chain.spot;
            const peItm = r.strike > chain.spot;
            return (
              <tr key={r.strike}>
                {hasFlow && <td className={cls('CE', r.strike, ceItm)}>{plain(r.ce?.oi, 0)}</td>}
                {hasFlow && (
                  <td className={cls('CE', r.strike, ceItm)}>{plain(r.ce?.volume, 0)}</td>
                )}
                <td className={cls('CE', r.strike, ceItm)}>{plain(r.ce?.delta)}</td>
                <td className={cls('CE', r.strike, ceItm)}>{plain(r.ce?.iv)}</td>
                <td className={cls('CE', r.strike, ceItm)}>
                  {ref('CE', r.strike) && (
                    <span className="mr-1 text-[9px] text-[var(--yellow)]">09:15</span>
                  )}
                  {plain(r.ce?.close)}
                </td>
                <td
                  className={`${td} text-center font-semibold`}
                  style={r.strike === chain.atm ? { color: 'var(--accent)' } : undefined}
                >
                  {r.strike}
                </td>
                <td className={cls('PE', r.strike, peItm)}>
                  {plain(r.pe?.close)}
                  {ref('PE', r.strike) && (
                    <span className="ml-1 text-[9px] text-[var(--yellow)]">09:15</span>
                  )}
                </td>
                <td className={cls('PE', r.strike, peItm)}>{plain(r.pe?.iv)}</td>
                <td className={cls('PE', r.strike, peItm)}>{plain(r.pe?.delta)}</td>
                {hasFlow && (
                  <td className={cls('PE', r.strike, peItm)}>{plain(r.pe?.volume, 0)}</td>
                )}
                {hasFlow && <td className={cls('PE', r.strike, peItm)}>{plain(r.pe?.oi, 0)}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-1 text-[10px] text-[var(--text-muted)]">
        Blue cells are the strikes sold. 09:15 marks the legs the signal and the IV signal read.
        {!hasFlow && ' Volume and OI are stored only for days downloaded from Nubra.'}
      </p>
    </Panel>
  );
}

export default function TradeExplorerDetail({
  row,
  theme,
  underlying,
  position,
  onClose,
  onStep,
  canStep,
}: {
  row: DayRow;
  theme: Theme;
  underlying: SignalUnderlying;
  position: string;
  onClose: () => void;
  onStep: (dir: -1 | 1) => void;
  canStep: { prev: boolean; next: boolean };
}) {
  const v = row.values;
  const t = row.raw.trade;
  const col = (k: string) => COLUMN_BY_KEY.get(k) as Column;
  const estimated = row.raw.estimated;
  const button = 'h-6 w-7 rounded border border-[var(--border)] disabled:opacity-30';
  return (
    <div className="flex h-full min-h-0 flex-col border-l border-[var(--border)]">
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-2 py-1">
        <button
          type="button"
          className={button}
          disabled={!canStep.prev}
          onClick={() => onStep(-1)}
          aria-label="Previous day"
        >
          ←
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold">
            {row.raw.date} ({v.weekday}) · {formatCell(col('dte'), v.dte)} · OTM 2
          </div>
          <div className="truncate text-[10px] text-[var(--text-muted)]">{position}</div>
        </div>
        <button
          type="button"
          className={button}
          disabled={!canStep.next}
          onClick={() => onStep(1)}
          aria-label="Next day"
        >
          →
        </button>
        <button type="button" className={button} onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2 text-[11px]">
        <div className="flex flex-wrap gap-1.5">
          <Fact label="1 lot">{t.qty} qty</Fact>
          <Fact label="Entry">
            {t.entryTime}, {underlying} {plain(t.entrySpot)}
          </Fact>
          <Fact label="Sold">
            {t.legs.map((l) => `${l.strike} ${l.kind} @ ₹${plain(l.entryPrice)}`).join(' · ')}
          </Fact>
          <Fact label="Premium collected">{rupee(v.premium as number)}</Fact>
          <Fact label="Max loss">
            {rupee(v.maxLoss as number)}
            {v.maxLossAt != null && ` at ${formatClock(v.maxLossAt as number)}`}
          </Fact>
          <Fact label="Best profit">{rupee(v.bestProfit as number | null)}</Fact>
          <Fact label={`Result at ${t.exitTime}`}>
            <span style={{ color: colorOf(t.pnl) }}>{signedRupee(t.pnl)}</span>
          </Fact>
          <Fact label="Expiry">{row.raw.expiry}</Fact>
          <Fact label="Data">{row.raw.source === 'nubra' ? 'Nubra' : 'Local files'}</Fact>
        </div>
        {estimated && (
          <p className="rounded border border-[var(--yellow)] px-2 py-1 text-[11px] text-[var(--yellow)]">
            <b>Estimated.</b> This day's stored prices stop 10 strikes from spot:{' '}
            {estimated.legs.map((l) => `${l.strike} ${l.kind} after ${l.from}`).join(', ')}. From
            there those legs are priced from the IV of the nearest strike that still has a price, so
            the max loss and result are estimates. Tested on real prices, the error was about{' '}
            {underlying === 'SENSEX' ? '₹300' : '₹550'} per leg at 8 strikes away, and it grows
            further out. With those legs frozen instead it read {signedRupee(estimated.before.pnl)}{' '}
            and a max loss of {rupee(estimated.before.maxLoss)}.
          </p>
        )}
        <div className="h-[340px] shrink-0 overflow-hidden rounded border border-[var(--border)]">
          <SignalDayChart
            theme={theme}
            underlying={underlying}
            row={row.raw}
            fillLegs={estimated?.legs}
            onClose={onClose}
            onStep={onStep}
            canStep={canStep}
          />
        </div>
        <SignalPanel row={row} underlying={underlying} />
        <GreeksPanel row={row} />
        <IvPanel row={row} underlying={underlying} />
        <ChainPanel row={row} underlying={underlying} />
      </div>
    </div>
  );
}
