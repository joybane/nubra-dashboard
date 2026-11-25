import { formatPnl } from '../lib/openingStrangle';
import { OpeningChartCard } from './OpeningStrangleCharts';

const P = 'max-w-[90ch] text-[14px] leading-relaxed text-[var(--text-secondary)]';
const NUMBER = new Intl.NumberFormat('en-IN');

interface WinRateRow {
  label: string;
  n: number;
  wins: number;
  mean: number;
}

// Fixed archive snapshot from POST /api/analysis/opening-strangle/study with onTimeOnly,
// includeResearch, rupees and the end dates below. Use finite 15:29 closes, subtract ₹100 per
// lot, rank by spotMove for the quartiles, and use analyzeOpeningEntryRules for the IV split.
const STUDIES = {
  NIFTY: {
    period: '1 Jan 2021 to 6 Nov 2026',
    laterPeriod: '7 Feb 2025 to 6 Nov 2026',
    sessions: 1420,
    move: [
      { label: 'Smallest moves · 0.14–0.43%', n: 355, wins: 340, mean: 1672 },
      { label: 'Second quartile · 0.43–0.63%', n: 355, wins: 298, mean: 1523 },
      { label: 'Third quartile · 0.63–0.94%', n: 355, wins: 224, mean: 800 },
      { label: 'Largest moves · 0.94–2.72%', n: 355, wins: 109, mean: -2220 },
    ],
    iv: [
      { label: 'Every eligible trade', n: 427, wins: 291, mean: 427 },
      { label: 'Opening IV above 21.38%', n: 91, wins: 69, mean: 1774 },
    ],
    replay: {
      date: '12 May 2025',
      direction: 'rose',
      call: -22165,
      put: 2811.25,
      gross: -19353.75,
      forward: -11043,
      iv: -9120,
      time: 810,
    },
  },
  SENSEX: {
    period: '16 Aug 2023 to 13 Nov 2026',
    laterPeriod: '18 Dec 2025 to 13 Nov 2026',
    sessions: 740,
    move: [
      { label: 'Smallest moves · 0.13–0.38%', n: 185, wins: 178, mean: 2421 },
      { label: 'Second quartile · 0.38–0.56%', n: 185, wins: 161, mean: 1979 },
      { label: 'Third quartile · 0.56–0.80%', n: 185, wins: 127, mean: 1166 },
      { label: 'Largest moves · 0.80–2.56%', n: 185, wins: 60, mean: -1982 },
    ],
    iv: [
      { label: 'Every eligible trade', n: 222, wins: 144, mean: -10 },
      { label: 'Opening IV above 18.21%', n: 98, wins: 61, mean: 273 },
    ],
    replay: {
      date: '8 Jul 2026',
      direction: 'fell',
      call: 3128,
      put: -20500,
      gross: -17372,
      forward: -15198,
      iv: -3114,
      time: 940,
    },
  },
};

const signedRupees = (value: number) => `${value > 0 ? '+' : ''}${formatPnl(value, 'rupees')}`;

function WinRateBars({
  rows,
  digits,
  countLabel,
}: {
  rows: WinRateRow[];
  digits: number;
  countLabel: 'sessions' | 'trades';
}) {
  return (
    <>
      <ul role="list" className="mt-3 grid gap-3">
        {rows.map(({ label, n, wins, mean }) => {
          const rate = (100 * wins) / n;
          return (
            <li key={label} className="grid gap-1">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="font-medium">{label}</span>
                <strong className="shrink-0 tabular-nums">{rate.toFixed(digits)}%</strong>
              </div>
              <div aria-hidden="true" className="h-2 rounded bg-[var(--bg-secondary)]">
                <div className="h-full rounded bg-[var(--accent)]" style={{ width: `${rate}%` }} />
              </div>
              <div className="text-xs tabular-nums text-[var(--text-muted)]">
                {NUMBER.format(n)} {countLabel} · Average {signedRupees(mean)} net per lot
              </div>
            </li>
          );
        })}
      </ul>
      <div
        aria-hidden="true"
        className="mt-2 flex justify-between text-xs text-[var(--text-muted)]"
      >
        <span>0%</span>
        <span>50%</span>
        <span>100%</span>
      </div>
    </>
  );
}

export default function OpeningStrangleFindings({ index }: { index: string }) {
  const isNifty = index === 'NIFTY';
  const study = STUDIES[isNifty ? 'NIFTY' : 'SENSEX'];
  const { replay } = study;

  return (
    <>
      <p className="text-xs text-[var(--text-muted)]">
        Fixed historical study · {NUMBER.format(study.sessions)} {index} sessions · {study.period} ·
        Exact 09:15–15:29 IST · ₹100 per lot round trip.
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="grid content-start gap-2.5">
          <OpeningChartCard
            title="Profitable trades by intraday index move"
            description="Four equal-sized groups sorted by the largest observed move in either direction from 09:15. Move ranges are rounded."
          >
            <WinRateBars rows={study.move} digits={2} countLabel="sessions" />
          </OpeningChartCard>
          <p className={P}>
            <strong>Large index moves drove losses.</strong> A strong rally made the sold call more
            expensive to buy back. A sharp fall did the same to the sold put. The largest moves
            often outweighed the benefit of time decay. The chart measures the full session, so the
            move is known at the close.
          </p>
          <p className={P}>
            <strong>
              {index} on {replay.date}.
            </strong>{' '}
            The index {replay.direction}. The call finished at {signedRupees(replay.call)} and the
            put at {signedRupees(replay.put)}, for {signedRupees(replay.gross)} gross per lot. The
            pricing model attributes approximately {signedRupees(replay.forward)} to the forward
            price move, {signedRupees(replay.iv)} to implied volatility changes and{' '}
            {signedRupees(replay.time)} to time decay.
          </p>
        </div>
        <div className="grid content-start gap-2.5">
          <OpeningChartCard
            title="Profitable trades by opening IV"
            description={`Later sample · ${study.laterPeriod}. The earlier 70% of sessions set the high-IV threshold. The later 30% measured performance.`}
          >
            <WinRateBars rows={study.iv} digits={1} countLabel="trades" />
          </OpeningChartCard>
          {isNifty ? (
            <>
              <p className={P}>
                <strong>Higher opening IV is a paper-trading hypothesis.</strong> The high-IV win
                rate fell from 84% in the 2025 part of the later sample to 70% in 2026. Its
                10th-percentile trade was −₹5,398, compared with −₹3,592 across all trades.
              </p>
              <p className={P}>
                Counting skipped trades as zero, the high-IV rule earned ₹378 per eligible session
                versus ₹427 when trading every eligible session.
              </p>
            </>
          ) : (
            <p className={P}>
              <strong>SENSEX had no reliable opening signal for profit or loss.</strong> Higher IV
              raised average profit per trade in the later sample and reduced the win rate. It also
              earned less per eligible session in the earlier sample, ₹816 versus ₹1,284 for trading
              every eligible session.
            </p>
          )}
          <p className={P}>No tested entry condition cleared the full validation checks.</p>
        </div>
      </div>
    </>
  );
}
