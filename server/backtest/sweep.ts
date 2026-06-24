import type { BacktestConfig, Metrics, SweepCell, SweepParam, SweepRequest, SweepResponse } from './types.ts';
import { enumerateTradingDays, runDays } from './engine.ts';
import { computeMetrics } from './analysis.ts';

const pathKey = (p: string): string | number => (/^\d+$/.test(p) ? Number(p) : p);

export function setByPath(obj: any, path: string, value: number): void {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur?.[pathKey(parts[i])];
    if (cur == null || typeof cur !== 'object') {
      throw new Error(`Invalid parameter path "${path}" — no object at "${parts.slice(0, i + 1).join('.')}".`);
    }
  }
  cur[pathKey(parts[parts.length - 1])] = value;
}

/** True if `path` resolves to an existing leaf in `obj` that can be assigned a number. */
export function pathIsValid(obj: any, path: string): boolean {
  if (!path) return false;
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur?.[pathKey(parts[i])];
    if (cur == null || typeof cur !== 'object') return false;
  }
  // leaf must already exist (undefined leaf ⇒ the sweep would silently no-op)
  return cur != null && parts[parts.length - 1] in cur;
}

export function rangeValues(p: SweepParam): number[] {
  const vals: number[] = [];
  const step = Math.abs(p.step) || 1;
  if (p.from <= p.to) {
    for (let v = p.from; v <= p.to + step * 0.001; v += step) vals.push(Math.round(v * 1e6) / 1e6);
  } else {
    for (let v = p.from; v >= p.to - step * 0.001; v -= step) vals.push(Math.round(v * 1e6) / 1e6);
  }
  return vals;
}

export async function runSweep(req: SweepRequest): Promise<SweepResponse> {
  const vals1 = rangeValues(req.param1);
  const vals2 = req.param2 ? rangeValues(req.param2) : [undefined];
  const cells: SweepCell[] = [];
  let bestMetric = -Infinity, bestV1 = vals1[0], bestV2: number | undefined;
  const metricKey = req.metric;

  for (const v1 of vals1) {
    for (const v2 of vals2) {
      const cfg: BacktestConfig = JSON.parse(JSON.stringify(req.base));
      setByPath(cfg, req.param1.path, v1);
      if (req.param2 && v2 !== undefined) setByPath(cfg, req.param2.path, v2);

      const dates = enumerateTradingDays(cfg.from, cfg.to, cfg.tradingDays);
      const { trades } = await runDays(cfg, dates);
      const m = computeMetrics(trades);
      const val = m[metricKey] as number;
      cells.push({ v1, v2, metric: Math.round(val * 100) / 100, trades: trades.length });

      if (val > bestMetric) { bestMetric = val; bestV1 = v1; bestV2 = v2; }
    }
  }

  return { ok: true, cells, bestV1, bestV2, bestMetric: Math.round(bestMetric * 100) / 100 };
}
