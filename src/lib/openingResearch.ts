import {
  OPENING_ENTRY_FEATURES,
  plainAmount,
  type OpeningDaySummary,
  type OpeningEntryFeature,
  type OpeningResearchRow,
} from './openingStrangle.ts';

export { OPENING_ENTRY_FEATURES } from './openingStrangle.ts';

export const OPENING_ENTRY_FEATURE_META = {
  entryCredit: { label: 'Opening credit', unit: '₹ per lot' },
  premiumImbalance: { label: 'Call vs put premium imbalance', unit: '%' },
  entryIv: { label: 'Opening implied volatility', unit: 'vol points' },
  ivSkew: { label: 'Call minus put IV', unit: 'vol points' },
  callDistancePct: { label: 'Distance to call strike', unit: '%' },
  putDistancePct: { label: 'Distance to put strike', unit: '%' },
  overnightGapPct: { label: 'Spot gap from prior close', unit: '%' },
  dte: { label: 'Days to expiry', unit: 'trading days' },
  monthly: { label: 'Contract type', unit: '' },
  creditVsRecent: { label: 'Opening credit vs recent same-DTE median', unit: '%' },
  ivVsRecent: { label: 'Opening IV vs recent same-DTE median', unit: '%' },
} satisfies Record<OpeningEntryFeature, { label: string; unit: string }>;

export interface OpeningRuleStats {
  eligible: number;
  n: number;
  takeRate: number | null;
  winRate: number | null;
  meanNet: number | null;
  totalNet: number;
  netPerEligible: number | null;
  p10Net: number | null;
  medianDrawdown: number | null;
}

interface OpeningRulePeriod {
  from: string | null;
  to: string | null;
  baseline: OpeningRuleStats;
}

export interface OpeningEntryRule {
  key: string;
  feature: OpeningEntryFeature;
  label: string;
  condition: string;
  discovery: OpeningRuleStats;
  holdout: OpeningRuleStats;
  holdoutDates: string[];
  missingDiscovery: number;
  missingHoldout: number;
  validated: boolean;
}

export interface OpeningEntryAnalysis {
  cost: number;
  discovery: OpeningRulePeriod;
  holdout: OpeningRulePeriod;
  candidates: OpeningEntryRule[];
}

interface Sample {
  date: string;
  net: number;
  drawdown: number;
  features?: OpeningResearchRow['features'];
}

interface Condition {
  key: string;
  label: string;
  matches: (value: number) => boolean;
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index);
  return sorted[lo] + (sorted[Math.ceil(index)] - sorted[lo]) * (index - lo);
}

function featureValue(sample: Sample, feature: OpeningEntryFeature): number | null {
  const value = sample.features?.[feature];
  return value != null && Number.isFinite(value) ? value : null;
}

function stats(samples: Sample[], eligible: number): OpeningRuleStats {
  const n = samples.length;
  const totals = samples.reduce(
    (sum, sample) => {
      sum.net += sample.net;
      if (sample.net > 0) sum.wins++;
      return sum;
    },
    { net: 0, wins: 0 },
  );
  return {
    eligible,
    n,
    takeRate: eligible ? (100 * n) / eligible : null,
    winRate: n ? (100 * totals.wins) / n : null,
    meanNet: n ? totals.net / n : null,
    totalNet: totals.net,
    netPerEligible: eligible ? totals.net / eligible : null,
    p10Net: percentile(
      samples.map((sample) => sample.net),
      0.1,
    ),
    medianDrawdown: percentile(
      samples.map((sample) => sample.drawdown),
      0.5,
    ),
  };
}

function period(samples: Sample[]): OpeningRulePeriod {
  return {
    from: samples[0]?.date ?? null,
    to: samples[samples.length - 1]?.date ?? null,
    baseline: stats(samples, samples.length),
  };
}

function conditions(feature: OpeningEntryFeature, discovery: number[]): Condition[] {
  if (feature === 'monthly') {
    return [
      { key: 'weekly', label: 'Weekly contracts', matches: (value) => value === 0 },
      { key: 'monthly', label: 'Monthly contracts', matches: (value) => value === 1 },
    ];
  }
  if (feature === 'dte') {
    return [0, 1, 2, 3, 4, 5].map((bucket) => ({
      key: String(bucket),
      label: bucket === 5 ? '5+ trading days' : `${bucket} DTE`,
      matches: (value) => (bucket === 5 ? value >= 5 : value === bucket),
    }));
  }
  const lower = percentile(discovery, 1 / 3);
  const upper = percentile(discovery, 2 / 3);
  if (lower == null || upper == null) return [];
  const { unit } = OPENING_ENTRY_FEATURE_META[feature];
  const format = (value: number) => `${plainAmount(value)}${unit === '%' ? '%' : ` ${unit}`}`;
  return [
    { key: 'low', label: `At or below ${format(lower)}`, matches: (value) => value <= lower },
    {
      key: 'middle',
      label: `Above ${format(lower)} through ${format(upper)}`,
      matches: (value) => value > lower && value <= upper,
    },
    { key: 'high', label: `Above ${format(upper)}`, matches: (value) => value > upper },
  ];
}

function lift(rule: OpeningRuleStats, baseline: OpeningRuleStats): number {
  return (rule.netPerEligible ?? 0) - (baseline.netPerEligible ?? 0);
}

/** Fit thresholds and order candidates on earlier sessions only. Later sessions measure them. */
export function analyzeOpeningEntryRules(
  days: OpeningDaySummary[],
  researchRows: OpeningResearchRow[],
  requestedCost?: number | null,
): OpeningEntryAnalysis {
  const cost =
    requestedCost != null && Number.isFinite(requestedCost) && requestedCost > 0
      ? requestedCost
      : 0;
  const featuresByDate = new Map(researchRows.map((row) => [row.date, row.features]));
  const unique = new Map<string, Sample>();
  for (const day of days) {
    if (day.close == null || !Number.isFinite(day.close) || unique.has(day.date)) continue;
    unique.set(day.date, {
      date: day.date,
      net: day.close - cost,
      drawdown: day.drawdown,
      features: featuresByDate.get(day.date),
    });
  }
  const samples = [...unique.values()].sort((a, b) => a.date.localeCompare(b.date));
  const split = Math.floor(samples.length * 0.7);
  const discoverySamples = samples.slice(0, split);
  const holdoutSamples = samples.slice(split);
  const discovery = period(discoverySamples);
  const holdout = period(holdoutSamples);
  const candidates: OpeningEntryRule[] = [];

  for (const feature of OPENING_ENTRY_FEATURES) {
    const discoveryValues = discoverySamples.flatMap((sample) => {
      const value = featureValue(sample, feature);
      return value == null ? [] : [{ sample, value }];
    });
    const holdoutValues = holdoutSamples.flatMap((sample) => {
      const value = featureValue(sample, feature);
      return value == null ? [] : [{ sample, value }];
    });
    for (const condition of conditions(
      feature,
      discoveryValues.map(({ value }) => value),
    )) {
      const earlier = discoveryValues
        .filter(({ value }) => condition.matches(value))
        .map(({ sample }) => sample);
      if (!earlier.length) continue;
      const later = holdoutValues
        .filter(({ value }) => condition.matches(value))
        .map(({ sample }) => sample);
      const discoveryRule = stats(earlier, discoverySamples.length);
      const holdoutRule = stats(later, holdoutSamples.length);
      candidates.push({
        key: `${feature}-${condition.key}`,
        feature,
        label: OPENING_ENTRY_FEATURE_META[feature].label,
        condition: condition.label,
        discovery: discoveryRule,
        holdout: holdoutRule,
        holdoutDates: later.map(({ date }) => date),
        missingDiscovery: discoverySamples.length - discoveryValues.length,
        missingHoldout: holdoutSamples.length - holdoutValues.length,
        validated:
          earlier.length >= 30 &&
          later.length >= 15 &&
          lift(discoveryRule, discovery.baseline) > 0 &&
          holdoutRule.totalNet > 0 &&
          (holdoutRule.meanNet ?? 0) > (holdout.baseline.meanNet ?? 0) &&
          lift(holdoutRule, holdout.baseline) > 0,
      });
    }
  }

  candidates.sort(
    (a, b) => lift(b.discovery, discovery.baseline) - lift(a.discovery, discovery.baseline),
  );
  return { cost, discovery, holdout, candidates };
}
