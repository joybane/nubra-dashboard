/**
 * Premium ranges by distance from expiry, picked from the tiers the prices at that distance fall into.
 *
 * Selling a strike because it is "OTM 2" says nothing about what it pays: ₹3 on the expiry day, ₹40
 * four days out. Here a button per distance (Exp, Exp−1, Exp−2… in trading days) opens that
 * distance's tiers — for the call and the put — as found by the last run
 * (server/signalBacktest/premiumSets.ts), and picking one makes the premium rule sell inside that
 * range on days at that distance. Distance from expiry rather than weekday, because the expiry
 * weekday has moved over the years. The ranges come from the data, never from a number typed in: a
 * distance (or a side) with nothing picked is simply not traded.
 */
import { useEffect, useRef, useState } from 'react';
import {
  dteLabel,
  dteShort,
  rangeText,
  sameRange,
  type LegChoice,
  type PremiumRange,
  type PremiumSet,
  type PremiumSetsResponse,
  type TradeParams,
} from '../lib/signalBacktest';

type Side = 'CE' | 'PE';
type RangePatch = Partial<Pick<TradeParams, 'cePremiumByDte' | 'pePremiumByDte'>>;
const FIELD = { CE: 'cePremiumByDte', PE: 'pePremiumByDte' } as const;

interface Props {
  /** The last run's sets; null before the first run (or when the server predates them). */
  sets: PremiumSetsResponse | null;
  /** What the sets were built over, for the panel header. */
  builtFor: string;
  legs: LegChoice;
  /** The distances to offer, nearest to expiry first. */
  dtes: number[];
  ce: Record<string, PremiumRange>;
  pe: Record<string, PremiumRange>;
  /** One patch per change, so clearing both sides is a single update and not two racing ones. */
  onChange: (patch: RangePatch) => void;
}

const SIDE_NAME: Record<Side, string> = { CE: 'Call (CE)', PE: 'Put (PE)' };

/** "the expiry day", "1 day before expiry" — for a sentence. */
const distanceText = (dte: number) => (dte === 0 ? 'the expiry day' : `${dteLabel(dte)} expiry`);

export default function PremiumSetsPicker({ sets, builtFor, legs, dtes, ce, pe, onChange }: Props) {
  const [open, setOpen] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open == null) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(null);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(null);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const sides: Side[] = legs === 'BOTH' ? ['CE', 'PE'] : [legs];
  const chosen: Record<Side, Record<string, PremiumRange>> = { CE: ce, PE: pe };
  const picked = (d: number) => sides.filter((s) => chosen[s][String(d)] != null);
  const any = dtes.some((d) => picked(d).length > 0);

  const pick = (side: Side, dte: number, set: PremiumSet) => {
    const next = { ...chosen[side] };
    const range: PremiumRange = [set.low, set.high];
    if (sameRange(next[String(dte)], range)) delete next[String(dte)];
    else next[String(dte)] = range;
    onChange({ [FIELD[side]]: next });
  };
  const without = (side: Side, dte: number) => {
    const next = { ...chosen[side] };
    delete next[String(dte)];
    return next;
  };
  const clearDay = (dte: number) => {
    const patch: RangePatch = {};
    for (const s of sides) patch[FIELD[s]] = without(s, dte);
    onChange(patch);
  };
  const clearAll = () => {
    const patch: RangePatch = {};
    for (const s of sides) patch[FIELD[s]] = {};
    onChange(patch);
  };

  const day = open != null ? sets?.expiryDays.find((d) => d.dte === open) : undefined;

  return (
    <div ref={box} className="relative flex flex-col gap-0.5">
      <span className="text-[9px] uppercase tracking-wide text-[var(--text-muted)]">
        Premium tier by days to expiry
        {any && (
          <button
            type="button"
            className="ml-1.5 normal-case tracking-normal text-[var(--accent)]"
            onClick={clearAll}
          >
            clear
          </button>
        )}
      </span>
      <div className="flex gap-1">
        {dtes.map((d) => {
          const set = picked(d);
          const summary = sides
            .map((s) => {
              const r = chosen[s][String(d)];
              return `${s} ${r ? rangeText(...r) : 'not traded'}`;
            })
            .join(' · ');
          return (
            <button
              key={d}
              type="button"
              aria-expanded={open === d}
              title={`${dteLabel(d)}${d === 0 ? '' : ' expiry'} (trading days): ${summary}. Click to choose a premium tier.`}
              onClick={() => setOpen((cur) => (cur === d ? null : d))}
              className={`relative h-7 min-w-[48px] rounded border px-1.5 text-[10px] font-semibold uppercase ${
                open === d
                  ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                  : set.length
                    ? 'border-[var(--accent)]/60 text-[var(--accent)]'
                    : 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
            >
              {dteShort(d)}
              {set.length > 0 && (
                <span className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
              )}
            </button>
          );
        })}
      </div>

      {!any && open == null && (
        <span className="max-w-[260px] text-[10px] text-[var(--text-muted)]">
          Exp = expiry day, Exp−1 = the day before. Pick a tier for each distance you want to trade;
          the others are skipped.
        </span>
      )}

      {open != null && (
        <div
          role="dialog"
          aria-label={`${dteLabel(open)} premium tiers`}
          className="absolute left-0 top-full z-40 mt-1 w-[min(660px,92vw)] rounded border border-[var(--border)] bg-[var(--bg-card)] p-2 shadow-xl"
        >
          <div className="mb-1.5 flex items-center gap-2 border-b border-[var(--border)] pb-1.5 text-[11px]">
            <span className="font-semibold">
              {open === 0 ? 'Expiry day' : `${dteLabel(open)} expiry`}
            </span>
            <span className="text-[var(--text-muted)]">
              {day && day.days > 0
                ? `${day.days} day${day.days === 1 ? '' : 's'} · ${builtFor}`
                : 'no days yet'}
            </span>
            {picked(open).length > 0 && (
              <button
                type="button"
                className="ml-auto text-[var(--accent)]"
                onClick={() => clearDay(open)}
              >
                clear this distance
              </button>
            )}
            <button
              type="button"
              aria-label="Close"
              className={`${picked(open).length > 0 ? '' : 'ml-auto '}text-[var(--text-muted)] hover:text-[var(--text-primary)]`}
              onClick={() => setOpen(null)}
            >
              ✕
            </button>
          </div>

          {!sets ? (
            <p className="px-1 py-3 text-[11px] text-[var(--text-muted)]">
              Run the backtest once. The tiers are built from the days it covers, at the entry
              minute of each signal — so they follow the From / To range and the delay you set. (If
              you just updated the app, restart the server first.)
            </p>
          ) : !day || day.days === 0 ? (
            <p className="px-1 py-3 text-[11px] text-[var(--text-muted)]">
              The last run has no signal day on {distanceText(open)}.
            </p>
          ) : (
            <div
              className={`grid max-h-[55vh] gap-3 overflow-y-auto pr-1 ${sides.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}
            >
              {sides.map((side) => {
                const list = day[side];
                const cur = chosen[side][String(open)];
                return (
                  <div key={side} className="min-w-0">
                    <div className="mb-1 flex items-baseline justify-between text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                      <span className="font-semibold">{SIDE_NAME[side]}</span>
                      <span className="normal-case tracking-normal">
                        {cur ? `selling ${rangeText(...cur)}` : 'nothing chosen: not traded'}
                      </span>
                    </div>
                    {list.length === 0 ? (
                      <p className="py-2 text-[11px] text-[var(--text-muted)]">
                        No strike priced ₹1 or more.
                      </p>
                    ) : (
                      <ul className="flex flex-col gap-1">
                        {list.map((set) => {
                          const on = sameRange(cur, [set.low, set.high]);
                          return (
                            <li key={`${set.low}-${set.high}`}>
                              <button
                                type="button"
                                aria-pressed={on}
                                onClick={() => pick(side, open, set)}
                                title={`${set.points} prices fell in this tier. On ${set.coverage}% of the days on ${distanceText(open)} at least one strike was priced inside ${rangeText(set.low, set.high)}, so that is how often a premium rule finds something to sell here.`}
                                className={`relative w-full overflow-hidden rounded border px-2 py-1 text-left text-[11px] ${
                                  on
                                    ? 'border-[var(--accent)] bg-[var(--accent)]/10'
                                    : 'border-[var(--border)] hover:border-[var(--accent)]/60'
                                }`}
                              >
                                <span
                                  aria-hidden
                                  className="absolute inset-y-0 left-0 bg-[var(--accent)]/10"
                                  style={{ width: `${set.coverage}%` }}
                                />
                                <span className="relative flex items-baseline justify-between gap-2 font-mono">
                                  <span className="font-semibold">
                                    {rangeText(set.low, set.high)}
                                  </span>
                                  <span className="text-[10px] text-[var(--text-muted)]">
                                    median {set.median} · {set.coverage}% of days
                                  </span>
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {sets && day && day.days > 0 && (
            <p className="mt-2 border-t border-[var(--border)] pt-1.5 text-[10px] text-[var(--text-muted)]">
              Tiers are where the entry-minute prices of ATM and out-of-the-money strikes bunch (₹1
              and up), each cut to about ±20% so it names a price to sell around. Ends where prices
              are too thin to form a tier are left out. The bar and percentage show how often a
              strike sat inside the range — on a day with none, the trade is skipped. Built from the
              strikes stored for those days.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
