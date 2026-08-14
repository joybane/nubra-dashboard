// ─── Crosshair tooltip for charts carrying inline Greek overlays ─────────────────
//
// Shared by the Tracker and by GreekIndicatorPane (Nubra BT / positions), so the reading
// experience is identical wherever the overlays are shown. Extracted from Tracker verbatim;
// the subtlety worth preserving is the NearestLeft carry-forward in `bindGreekCrosshair`.

import {
  MismatchDirection,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type UTCTimestamp,
} from 'lightweight-charts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Chart time is IST-baked seconds, so read UTC parts to get the IST wall clock. */
export function fmtCrosshairTime(t: number): string {
  const d = new Date(t * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${hh}:${mm}`;
}

/** Greek totals can be ~1e9 (industry); render them compactly in the tooltip. */
export function fmtCompact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(2) + 'K';
  return v.toFixed(2);
}

export function tipRow(color: string, label: string, val: string): string {
  return (
    `<div style="display:flex;align-items:center;gap:6px;line-height:1.6;white-space:nowrap">` +
    `<span style="width:8px;height:8px;border-radius:2px;background:${color};flex:none"></span>` +
    `<span style="color:var(--text-secondary);font-size:11px">${label}</span>` +
    `<span style="margin-left:auto;padding-left:14px;color:var(--text-primary);font-weight:600;font-size:11px">${val}</span>` +
    `</div>`
  );
}

/** One overlay line's reading — the unit both the hover tooltip and a pinned card are built from. */
export interface GreekRow {
  color: string;
  label: string;
  value: number;
  /** Overrides fmtCompact — the underlying row is a price, not a nine-digit greek total. */
  format?: (v: number) => string;
}

/**
 * Read every visible greek line on `paneIndex`, skipping `exclude` (the host's own price series).
 *
 * `readExact` supplies a value when the caller already has one for this instant — the crosshair
 * path passes `param.seriesData`. Where that misses, the reading is carried forward from the last
 * bar at or before `logical`: greek history is 1-minute while a live price line is 1-second, so an
 * exact hit fails at ~59 of every 60 cursor positions and the rows would otherwise blink out.
 */
export function greekRows(
  chart: IChartApi,
  exclude: ISeriesApi<'Line'> | null,
  readExact: ((s: ISeriesApi<'Line'>) => number | undefined) | null,
  logical: number | null,
  paneIndex = 0,
): GreekRow[] {
  let overlaySeries: ISeriesApi<'Line'>[] = [];
  try {
    overlaySeries = (chart.panes()[paneIndex]?.getSeries() ?? []).filter(
      (s) => s !== exclude,
    ) as ISeriesApi<'Line'>[];
  } catch {
    /* pane gone */
  }

  const rows: GreekRow[] = [];
  for (const series of overlaySeries) {
    const o = series.options() as { color?: string; title?: string; visible?: boolean };
    if (o.visible === false) continue;
    let v = readExact?.(series);
    if ((v == null || !Number.isFinite(v)) && logical != null) {
      const prev = series.dataByIndex(logical, MismatchDirection.NearestLeft) as {
        value?: number;
      } | null;
      v = prev?.value;
    }
    if (v == null || !Number.isFinite(v)) continue;
    rows.push({ color: o.color || '#888', label: o.title || '', value: v });
  }
  return rows;
}

/**
 * One series' value at a logical index, carried forward from the last bar at or before it.
 *
 * The host's own price row needs this for the same reason the greek rows do: a synced crosshair
 * and a pinned card both arrive without `seriesData`, so an exact-hit read would drop the row.
 */
export function seriesValueAt(
  series: ISeriesApi<'Line'> | null,
  logical: number | null,
): number | undefined {
  if (!series || logical == null) return undefined;
  try {
    const p = series.dataByIndex(logical, MismatchDirection.NearestLeft) as {
      value?: number;
    } | null;
    return p?.value != null && Number.isFinite(p.value) ? p.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Logical index for a chart time, via the time scale's own coordinate mapping.
 *
 * A pinned card knows only a timestamp — there is no cursor and therefore no `param.logical` —
 * but `dataByIndex` is the only way to carry a reading forward off-grid, and it wants an index.
 */
export function logicalAtTime(chart: IChartApi, time: number): number | null {
  try {
    const x = chart.timeScale().timeToCoordinate(time as UTCTimestamp);
    if (x == null || !Number.isFinite(x)) return null;
    const logical = chart.timeScale().coordinateToLogical(x);
    return logical == null || !Number.isFinite(logical) ? null : logical;
  } catch {
    return null;
  }
}

export interface GreekCrosshairOpts {
  chart: IChartApi;
  container: HTMLDivElement;
  tooltip: HTMLDivElement;
  /** The host's own price/underlying series — rendered first, in its own format. */
  baseSeries: () => ISeriesApi<'Line'> | null;
  /** Label for the base row (the symbol being charted). */
  baseLabel: () => string;
  /** Format the base row's value. Greek rows always use fmtCompact. */
  formatBase: (v: number) => string;
  /** Pane whose series are enumerated for greek rows. Defaults to 0 (where inline overlays live). */
  paneIndex?: number;
}

/**
 * Subscribe a crosshair tooltip listing the base series plus every visible greek line.
 * Returns an unsubscribe function.
 *
 * Greek/IV history is 1-minute while a live price line is 1-second, so `seriesData` is empty for
 * a greek series at ~59 of every 60 crosshair positions — rows would blink out and the tooltip
 * would collapse to just the price. Enumerating the pane's series and carrying the last known
 * value forward (NearestLeft) is what keeps them steady, rather than relying on an exact time hit.
 */
export function bindGreekCrosshair(opts: GreekCrosshairOpts): () => void {
  const { chart, container, tooltip, baseSeries, baseLabel, formatBase } = opts;
  const paneIndex = opts.paneIndex ?? 0;

  const onCrosshair = (param: MouseEventParams) => {
    // A host that syncs crosshairs across panes calls setCrosshairPosition on the panes the
    // cursor is NOT over, and those fire with a time but no point. Deriving x from the time
    // scale keeps the reading visible on a synced pane instead of blanking it — without this,
    // hovering the price chart would move a crosshair line here and show nothing beside it.
    let pt = param.point;
    let synced = false;
    if (!pt && param.time != null) {
      try {
        const x = chart.timeScale().timeToCoordinate(param.time);
        if (x != null && Number.isFinite(x)) {
          pt = { x, y: 0 } as NonNullable<MouseEventParams['point']>;
          synced = true;
        }
      } catch {
        /* time scale not laid out */
      }
    }
    if (
      param.time == null ||
      !pt ||
      pt.x < 0 ||
      pt.y < 0 ||
      pt.x > container.clientWidth ||
      pt.y > container.clientHeight
    ) {
      tooltip.style.display = 'none';
      return;
    }
    // A synced crosshair carries no seriesData either, so fall back to the time when there is
    // no logical index to read against.
    const logical = param.logical ?? (synced ? logicalAtTime(chart, param.time as number) : null);

    const rows: string[] = [];
    const base = baseSeries();
    if (base) {
      // Exact hit first, then carry forward — otherwise the price row is the one thing that
      // disappears on a synced crosshair, leaving greek rows with nothing to read them against.
      const exact = (param.seriesData.get(base) as { value?: number } | undefined)?.value;
      const v = typeof exact === 'number' ? exact : seriesValueAt(base, logical);
      if (v != null) rows.push(tipRow('#2962ff', baseLabel(), formatBase(v)));
    }

    for (const r of greekRows(
      chart,
      base,
      (s) => (param.seriesData.get(s) as { value?: number } | undefined)?.value,
      logical,
      paneIndex,
    )) {
      rows.push(tipRow(r.color, r.label, fmtCompact(r.value)));
    }
    if (!rows.length) {
      tooltip.style.display = 'none';
      return;
    }
    tooltip.innerHTML =
      `<div style="font-size:10px;color:var(--text-muted);margin-bottom:4px">${fmtCrosshairTime(param.time as number)}</div>` +
      rows.join('');
    tooltip.style.display = 'block';

    const tw = tooltip.offsetWidth,
      th = tooltip.offsetHeight;
    // A synced crosshair has no cursor to dodge, so pin the card to the top of the pane rather
    // than trailing a y that is really just 0.
    let x = pt.x + 16,
      y = synced ? 8 : pt.y + 16;
    if (x + tw > container.clientWidth) x = pt.x - tw - 16;
    if (y + th > container.clientHeight) y = container.clientHeight - th - 8;
    tooltip.style.left = `${Math.max(4, x)}px`;
    tooltip.style.top = `${Math.max(4, y)}px`;
  };

  chart.subscribeCrosshairMove(onCrosshair);
  return () => {
    try {
      chart.unsubscribeCrosshairMove(onCrosshair);
    } catch {
      /* chart already disposed */
    }
  };
}
