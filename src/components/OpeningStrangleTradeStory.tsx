import {
  OPENING_SESSION_MINUTES,
  openingPnlAfterCost,
  openingPnlInUnit,
  openingTime,
  type OpeningDay,
} from '../lib/openingStrangle';

const RUPEES = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
const POINTS = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const PERCENT = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

function signed(value: number, format: Intl.NumberFormat, showGain = false) {
  const sign = value < 0 ? '−' : value > 0 && showGain ? '+' : '';
  return `${sign}${format.format(Math.abs(value))}`;
}

function SpotStory({ day }: { day: OpeningDay }) {
  const { summary, spot } = day;
  let minimum = Infinity;
  let maximum = -Infinity;
  let observed = 0;
  let touch: { leg: 'call' | 'put'; minute: number; value: number } | undefined;
  for (let minute = summary.entry; minute < OPENING_SESSION_MINUTES; minute++) {
    const value = spot[minute];
    if (value == null || !Number.isFinite(value)) continue;
    observed++;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
    if (!touch) {
      if (value >= summary.ceStrike) touch = { leg: 'call', minute, value };
      else if (value <= summary.peStrike) touch = { leg: 'put', minute, value };
    }
  }
  if (observed === 0)
    return <p>There are no observed spot marks during the hold, so strike touches are unknown.</p>;
  const missing = OPENING_SESSION_MINUTES - summary.entry - observed;
  return (
    <p>
      Spot ranged from {POINTS.format(minimum)} to {POINTS.format(maximum)} in the observed marks.{' '}
      {touch
        ? `The first observed strike touch was the ${touch.leg} at ${openingTime(touch.minute)} IST, with spot at ${POINTS.format(touch.value)}.`
        : 'No observed spot mark reached either strike.'}{' '}
      {missing > 0 &&
        `Spot quotes are missing for ${missing} ${missing === 1 ? 'minute' : 'minutes'} of the hold.`}
    </p>
  );
}

export default function OpeningStrangleTradeStory({
  day,
  cost,
}: {
  day: OpeningDay;
  cost: number;
}) {
  const { summary } = day;
  const closeMinute = OPENING_SESSION_MINUTES - 1;
  const call = day.cePnl[closeMinute];
  const put = day.pePnl[closeMinute];
  const last = openingPnlAfterCost(day.pnl[summary.lastMarked], cost);
  const close = openingPnlAfterCost(summary.close, cost);
  const closePct = openingPnlInUnit(close, summary.entryCredit, 'creditPct');
  const outcome = cost ? 'net' : 'gross';
  const expiry =
    summary.dte === 0
      ? 'On expiry day'
      : `With ${summary.dte} trading ${summary.dte === 1 ? 'day' : 'days'} to expiry`;
  const missingLegs =
    call == null && put == null
      ? 'both option quotes were missing'
      : call == null
        ? 'the call quote was missing'
        : put == null
          ? 'the put quote was missing'
          : 'a combined mark was unavailable';

  return (
    <section
      aria-label="What happened on this trade"
      className="rounded border border-[var(--border)] bg-[var(--bg-card)] p-3 sm:p-4"
    >
      <h3 className="text-[17px] font-semibold">What happened on this trade</h3>
      <div className="mt-2 grid max-w-[90ch] gap-2 text-[14px] leading-relaxed text-[var(--text-secondary)]">
        <p>
          {expiry}, the replay sold the{' '}
          <strong>{summary.ceStrike.toLocaleString('en-IN')} call</strong> and the{' '}
          <strong>{summary.peStrike.toLocaleString('en-IN')} put</strong> at{' '}
          {openingTime(summary.entry)} IST. Selling one lot of each collected{' '}
          {signed(summary.entryCredit, RUPEES)} in total. Both strikes stayed fixed during the hold.
        </p>
        {close != null && summary.close != null && call != null && put != null ? (
          <p>
            The 15:29 IST quotes put the combined buyback at{' '}
            <strong>{signed(summary.entryCredit - summary.close, RUPEES)}</strong>. Subtracting that
            from the opening credit
            {cost > 0 && ` and deducting ${signed(cost, RUPEES)} in round-trip costs`} gave a{' '}
            {outcome} P&amp;L of{' '}
            <strong>
              {signed(close, RUPEES, true)}
              {closePct != null &&
                ` (${signed(closePct, PERCENT, true)}% of the combined opening credit)`}
            </strong>
            . Gross leg P&amp;L was {signed(call, RUPEES, true)} for the call and{' '}
            {signed(put, RUPEES, true)} for the put.
          </p>
        ) : (
          <p>
            At 15:29 IST, {missingLegs}, so the combined buyback and closing P&amp;L are
            unavailable.{' '}
            {last != null && (
              <>
                The last observed combined {outcome} mark was {signed(last, RUPEES, true)} at{' '}
                {openingTime(summary.lastMarked)} IST.
              </>
            )}
          </p>
        )}
        <p>
          The lowest observed {outcome} P&amp;L was{' '}
          <strong>{signed(openingPnlAfterCost(summary.worst.pnl, cost), RUPEES, true)}</strong> at{' '}
          {openingTime(summary.worst.minute)} IST. The largest peak-to-trough drawdown was{' '}
          {signed(summary.drawdown, RUPEES)}, measured from an earlier observed high to a later low.
        </p>
        <SpotStory day={day} />
        {summary.marked < summary.possible && (
          <p>
            Both option prices were available for {summary.marked} of {summary.possible} minute
            marks. The combined line has gaps where either option quote was missing.
          </p>
        )}
      </div>
    </section>
  );
}
