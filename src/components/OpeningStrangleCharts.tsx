import { useState, type ReactNode } from 'react';
import {
  OPENING_SESSION_MINUTES,
  formatPnl,
  openingPnlAfterCost,
  openingPnlInUnit,
  openingTime,
  plainAmount,
  type OpeningDay,
  type OpeningDaySummary,
  type OpeningGroup,
  type OpeningUnit,
} from '../lib/openingStrangle';
import type { OpeningPremiumPrices } from '../lib/openingPremiumPrices';
import SvgChart, { type SvgChartLinkedHover } from './SvgChart';

const COLORS = ['#3971d6', '#c17126', '#2a927c', '#9b68c1', '#c85178', '#758496'];
const AXIS_COLORS = { axisColor: 'var(--text-muted)' };
const ZERO = [{ axis: 'y' as const, value: 0, color: 'var(--text-muted)', dashed: true }];
const REPLAY_ZERO = [{ ...ZERO[0], color: 'var(--replay-baseline)' }];
const unitLabel = (unit: OpeningUnit) => (unit === 'rupees' ? '₹ per lot' : '% of entry credit');
const PREMIUM = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });
const formatPremium = (lot: number | null, quote: number | null) =>
  lot == null || quote == null
    ? '—'
    : `${PREMIUM.format(lot)} per lot · ${PREMIUM.format(quote)} per unit`;
const REPLAY_AXES = {
  margin: { left: 76, right: 76 },
  axisColor: 'var(--replay-axis)',
  frameColor: 'var(--replay-frame, none)',
  xLabel: 'Market time (IST)',
  xTickSpacing: 60,
};

type MarketPoint = {
  minute: number;
  spot: number | null;
  call: number | null;
  put: number | null;
  callQuote: number | null;
  putQuote: number | null;
};

type ReplayChart = 'market' | 'pnl';

function marketTooltip(point: Record<string, number | null>, call: string, put: string): string[] {
  return [
    `Index  ${plainAmount(point.spot)}`,
    `${call}  ${formatPremium(point.call, point.callQuote)}`,
    `${put}  ${formatPremium(point.put, point.putQuote)}`,
  ];
}

export function OpeningChartCard({
  title,
  description,
  children,
  replay = false,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  replay?: boolean;
}) {
  return (
    <section
      className={`min-w-0 rounded border border-[var(--border)] bg-[var(--bg-card)] p-2.5${replay ? ' opening-replay-card' : ''}`}
    >
      <h3 className="text-sm font-semibold">{title}</h3>
      {description && <div className="mt-0.5 text-xs text-[var(--text-muted)]">{description}</div>}
      {children}
    </section>
  );
}

export function OpeningGroupChart({
  groups,
  active,
  unit,
}: {
  groups: OpeningGroup[];
  active?: string;
  unit: OpeningUnit;
}) {
  const available = groups.filter((group) => group.n > 0);
  if (!available.length)
    return (
      <p className="py-12 text-center text-[var(--text-muted)]">
        No curves to display for these filters.
      </p>
    );
  const chosen = available.find((group) => group.label === active);
  const data = Array.from({ length: OPENING_SESSION_MINUTES }, (_, minute) => {
    const datum: Record<string, number | null> = {
      minute,
      p10: chosen?.curve[minute].p10 ?? null,
      p90: chosen?.curve[minute].p90 ?? null,
    };
    for (const group of available) {
      datum[group.label] = group.curve[minute].median;
      datum[`${group.label} count`] = group.curve[minute].n;
    }
    return datum;
  });
  const series = available.map((group) => ({
    dataKey: group.label,
    color: COLORS[groups.indexOf(group)],
    strokeWidth: group === chosen ? 2.7 : 1.55,
  }));
  const boundaries = chosen
    ? ['p10', 'p90'].map((dataKey) => ({
        dataKey,
        color: COLORS[groups.indexOf(chosen)],
        strokeWidth: 1,
        dashed: true,
      }))
    : [];
  return (
    <div className="h-[22rem]">
      <SvgChart
        {...AXIS_COLORS}
        data={data}
        xKey="minute"
        xFormatter={openingTime}
        yFormatter={(v) => formatPnl(v, unit)}
        yLabel={`P&L · ${unitLabel(unit)}`}
        series={[...series, ...boundaries]}
        legendLabels={
          chosen ? { p10: `${chosen.label} P10`, p90: `${chosen.label} P90` } : undefined
        }
        refLines={ZERO}
        showLegend
        tooltipFormatter={(d) =>
          [
            `${openingTime(d.minute)} IST`,
            ...available.map(
              (group) =>
                `${group.label}  ${formatPnl(d[group.label], unit)}  ·  ${d[`${group.label} count`]} sessions`,
            ),
            ...(chosen
              ? [`${chosen.label} P10–P90  ${formatPnl(d.p10, unit)} to ${formatPnl(d.p90, unit)}`]
              : []),
          ].join('\n')
        }
      />
    </div>
  );
}

export function OpeningComparisonChart({
  days,
  unit,
  cost,
}: {
  days: OpeningDay[];
  unit: OpeningUnit;
  cost: number;
}) {
  const data = Array.from({ length: OPENING_SESSION_MINUTES }, (_, minute) => {
    const datum: Record<string, number | null> = { minute };
    for (const { summary, pnl } of days)
      datum[summary.date] = openingPnlInUnit(
        openingPnlAfterCost(pnl[minute], cost),
        summary.entryCredit,
        unit,
      );
    return datum;
  });
  return (
    <OpeningChartCard
      title="Pinned session curves"
      description={`Combined ${cost ? 'net' : 'gross'} P&L aligned by market time.`}
    >
      <div className="h-[24rem]">
        <SvgChart
          {...AXIS_COLORS}
          data={data}
          xKey="minute"
          xFormatter={openingTime}
          yFormatter={(v) => formatPnl(v, unit)}
          yLabel={`P&L · ${unitLabel(unit)}`}
          series={days.map(({ summary }, i) => ({ dataKey: summary.date, color: COLORS[i] }))}
          refLines={ZERO}
          showLegend
        />
      </div>
    </OpeningChartCard>
  );
}

function OpeningMarketChart({
  summary,
  data,
  call,
  put,
  hasPremiums,
  loading,
  linkedHover,
}: {
  summary: OpeningDaySummary;
  data: MarketPoint[];
  call: string;
  put: string;
  hasPremiums: boolean;
  loading: boolean;
  linkedHover: SvgChartLinkedHover;
}) {
  return (
    <OpeningChartCard
      title="Underlying and option premiums"
      description={`Each option line shows one lot of ${summary.quantity} units. Guides mark the traded strikes.`}
      replay
    >
      {!hasPremiums && (
        <p className="mt-1 text-xs text-[var(--text-muted)]" role="status">
          {loading
            ? 'Loading archived option premiums…'
            : 'Matching archived option premiums are unavailable for this replay.'}
        </p>
      )}
      <div className="opening-replay-plot">
        <SvgChart
          {...REPLAY_AXES}
          data={data}
          linkedHover={linkedHover}
          xKey="minute"
          xFormatter={openingTime}
          yFormatter={plainAmount}
          yLabel="Index points"
          rightAxis={{ label: '₹ per lot', formatter: plainAmount }}
          series={[
            { dataKey: 'spot', color: 'var(--replay-index)', strokeWidth: 2.2 },
            { dataKey: 'call', color: 'var(--replay-call)', yAxis: 'right' },
            { dataKey: 'put', color: 'var(--replay-put)', yAxis: 'right' },
          ]}
          refLines={[
            {
              axis: 'y',
              value: summary.ceStrike,
              color: 'var(--replay-call-guide)',
              dashed: true,
              label: 'Call strike',
              labelColor: 'var(--replay-call)',
            },
            {
              axis: 'y',
              value: summary.peStrike,
              color: 'var(--replay-put-guide)',
              dashed: true,
              label: 'Put strike',
              labelColor: 'var(--replay-put)',
            },
          ]}
          legendLabels={{ spot: 'Index', call, put }}
          showLegend
          tooltipFormatter={(d) =>
            [`${openingTime(d.minute)} IST`, ...marketTooltip(d, call, put)].join('\n')
          }
        />
      </div>
    </OpeningChartCard>
  );
}

export function OpeningDayCharts({
  day,
  unit,
  cost,
  premiums,
  premiumsLoading,
}: {
  day: OpeningDay;
  unit: OpeningUnit;
  cost: number;
  premiums?: OpeningPremiumPrices;
  premiumsLoading: boolean;
}) {
  const [hover, setHover] = useState<{ day: OpeningDay; chart: ReplayChart; index: number } | null>(
    null,
  );
  const currentHover = hover?.day === day ? hover : null;
  const linkChart = (chart: ReplayChart): SvgChartLinkedHover => ({
    index: currentHover?.index ?? null,
    active: currentHover?.chart === chart,
    onChange: (index) =>
      setHover((previous) => {
        const sameChart = previous?.day === day && previous.chart === chart;
        if (index === null) return sameChart ? null : previous;
        return sameChart && previous.index === index ? previous : { day, chart, index };
      }),
  });
  const { summary } = day;
  const call = `Call ${plainAmount(summary.ceStrike)}`;
  const put = `Put ${plainAmount(summary.peStrike)}`;
  const scaled = (value: number | null) => openingPnlInUnit(value, summary.entryCredit, unit);
  const marketData = day.spot.map((spot, minute) => {
    const callQuote = premiums?.call[minute] ?? null;
    const putQuote = premiums?.put[minute] ?? null;
    return {
      minute,
      spot,
      callQuote,
      putQuote,
      call: callQuote == null ? null : callQuote * summary.quantity,
      put: putQuote == null ? null : putQuote * summary.quantity,
    };
  });
  const data = marketData.map(({ minute, ...prices }) => ({
    minute,
    ...prices,
    combined: scaled(openingPnlAfterCost(day.pnl[minute], cost)),
    callPnl: scaled(day.cePnl[minute]),
    putPnl: scaled(day.pePnl[minute]),
    callIv: day.ceIv[minute],
    putIv: day.peIv[minute],
  }));
  return (
    <>
      <OpeningMarketChart
        summary={summary}
        data={marketData}
        call={call}
        put={put}
        hasPremiums={Boolean(premiums)}
        loading={premiumsLoading}
        linkedHover={linkChart('market')}
      />
      <OpeningChartCard
        title="Intraday profit and loss"
        description={`${unit === 'creditPct' ? 'Percent of combined opening credit.' : 'Rupees per lot.'} Combined P&L requires both prices.${cost ? ' It includes the round-trip cost.' : ' The zero line marks break-even.'} Hover or use the arrow keys to compare both charts at the same minute.`}
        replay
      >
        <div className="opening-replay-plot">
          <SvgChart
            {...REPLAY_AXES}
            data={data}
            linkedHover={linkChart('pnl')}
            xKey="minute"
            xFormatter={openingTime}
            yFormatter={(v) => formatPnl(v, unit)}
            yLabel={`P&L · ${unitLabel(unit)}`}
            series={[
              {
                dataKey: 'combined',
                color: 'var(--replay-combined)',
                strokeWidth: 'var(--replay-combined-width, 2.7)',
              },
              { dataKey: 'callPnl', color: 'var(--replay-call)' },
              { dataKey: 'putPnl', color: 'var(--replay-put)' },
            ]}
            legendLabels={{
              combined: cost ? 'Combined net' : 'Combined gross',
              callPnl: 'Call gross',
              putPnl: 'Put gross',
            }}
            refLines={REPLAY_ZERO}
            showLegend
            tooltipFormatter={(d) =>
              [
                `${openingTime(d.minute)} IST`,
                ...marketTooltip(d, call, put),
                `Combined ${cost ? 'net' : 'gross'}  ${formatPnl(d.combined, unit)}`,
                `Call gross  ${formatPnl(d.callPnl, unit)}  ·  IV ${plainAmount(d.callIv)}`,
                `Put gross  ${formatPnl(d.putPnl, unit)}  ·  IV ${plainAmount(d.putIv)}`,
              ].join('\n')
            }
          />
        </div>
      </OpeningChartCard>
    </>
  );
}

export type AttributionPoint = {
  minute: number;
  forward: number | null;
  time: number | null;
  iv: number | null;
  residual: number | null;
  actual: number | null;
  coverage: string;
};

export function OpeningAttributionChart({
  points,
  unit,
  description,
}: {
  points: AttributionPoint[];
  unit: OpeningUnit;
  description: string;
}) {
  const explanation =
    'Black-76 estimates since entry. The residual reconciles modeled effects with observed gross P&L.';
  const modeled = points.filter((point) => point.actual != null).length;
  return (
    <OpeningChartCard title="Pricing attribution" description={`${description} ${explanation}`}>
      {modeled > 0 ? (
        <div className="h-[19rem]">
          <SvgChart
            {...AXIS_COLORS}
            data={points}
            xKey="minute"
            xFormatter={openingTime}
            yFormatter={(v) => formatPnl(v, unit)}
            yLabel={`P&L · ${unitLabel(unit)}`}
            series={[
              { dataKey: 'actual', color: COLORS[0], strokeWidth: 2.7 },
              { dataKey: 'forward', color: COLORS[1] },
              { dataKey: 'time', color: COLORS[2] },
              { dataKey: 'iv', color: COLORS[3] },
              { dataKey: 'residual', color: COLORS[5], dashed: true },
            ]}
            legendLabels={{
              actual: 'Observed gross P&L',
              forward: 'Forward',
              time: 'Elapsed time',
              iv: 'Implied volatility',
              residual: 'Residual',
            }}
            refLines={ZERO}
            showLegend
            tooltipFormatter={(d) =>
              [
                `${openingTime(d.minute)} IST  ·  ${d.coverage}`,
                `Observed gross P&L  ${formatPnl(d.actual, unit)}`,
                `Forward  ${formatPnl(d.forward, unit)}`,
                `Elapsed time  ${formatPnl(d.time, unit)}`,
                `Implied volatility  ${formatPnl(d.iv, unit)}`,
                `Residual  ${formatPnl(d.residual, unit)}`,
              ].join('\n')
            }
          />
        </div>
      ) : (
        <p className="py-6 text-[var(--text-muted)]">
          Attribution requires priceable implied volatility for both legs at entry and at each mark.
        </p>
      )}
    </OpeningChartCard>
  );
}
