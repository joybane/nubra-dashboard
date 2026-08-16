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

/**
 * Either shape lightweight-charts uses for a time on these charts.
 *
 * Intraday intervals carry IST-baked epoch seconds; 1d/1w/1mt carry a business day instead
 * (see `toChartTime`). A tooltip on the Chart view sees both, because the interval buttons
 * switch between them.
 */
export type CrosshairTime = number | { year: number; month: number; day: number };

/** Chart time is IST-baked seconds, so read UTC parts to get the IST wall clock. */
export function fmtCrosshairTime(t: CrosshairTime): string {
  // A business day has no clock to show — printing one would invent a 00:00 that means nothing.
  if (typeof t === 'object' && t) return `${t.day} ${MONTHS[t.month - 1]} ${t.year}`;
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

/**
 * Escape text destined for a tooltip's `innerHTML`.
 *
 * Series titles and instrument names reach these cards from the broker's refdata, not from a
 * literal in this repo — so they are interpolated into markup we did not author. Nothing observed
 * there contains markup today; escaping costs one pass over a short string and removes the
 * question entirely.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function tipRow(color: string, label: string, val: string): string {
  return (
    `<div style="display:flex;align-items:center;gap:6px;line-height:1.6;white-space:nowrap">` +
    `<span style="width:8px;height:8px;border-radius:2px;background:${escapeHtml(color)};flex:none"></span>` +
    `<span style="color:var(--text-secondary);font-size:11px">${escapeHtml(label)}</span>` +
    `<span style="margin-left:auto;padding-left:14px;color:var(--text-primary);font-weight:600;font-size:11px">${escapeHtml(val)}</span>` +
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

/** One line's change between two instants: `after` minus `before`, for a Δ strip. */
export interface GreekRowDelta {
  label: string;
  value: number;
}

/**
 * Pair two readings of the same pane up by series title and subtract.
 *
 * By title rather than by position, because each reading enumerates whatever lines existed when it
 * was taken: switching a measure on or off between the two pinned instants shifts the list, and a
 * positional pairing would quietly subtract Theta from Vega. A line present in only one of the two
 * readings is dropped — there is no difference to state — and the order of `after` is kept, so the
 * strip lists its rows in the order the pane draws them.
 */
export function diffGreekRows(before: GreekRow[], after: GreekRow[]): GreekRowDelta[] {
  const prior = new Map(before.map((r) => [r.label, r.value]));
  const out: GreekRowDelta[] = [];
  for (const r of after) {
    const was = prior.get(r.label);
    if (was == null || !Number.isFinite(was) || !Number.isFinite(r.value)) continue;
    out.push({ label: r.label, value: r.value - was });
  }
  return out;
}

/**
 * Every visible greek line the chart carries, gathered across its sub-panes.
 *
 * The Tracker draws its overlays *inline* on the price pane, so one `greekRows` call over pane 0
 * covers it. The Chart view gives each greek a pane of its own below the price (see
 * `createGreekPane`'s non-inline branch), so its rows are spread over panes 1..n — and how many
 * exist depends on which overlays are switched on. Enumerating from `fromPane` keeps the price
 * pane's own candles and volume out of the greek section.
 */
export function greekRowsAllPanes(
  chart: IChartApi,
  exclude: ISeriesApi<'Line'> | null,
  readExact: ((s: ISeriesApi<'Line'>) => number | undefined) | null,
  logical: number | null,
  fromPane = 1,
): GreekRow[] {
  let paneCount = 0;
  try {
    paneCount = chart.panes().length;
  } catch {
    return []; // chart disposed
  }
  const rows: GreekRow[] = [];
  for (let i = fromPane; i < paneCount; i++) {
    rows.push(...greekRows(chart, exclude, readExact, logical, i));
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
  series: ISeriesApi<'Line'> | ISeriesApi<'Histogram'> | null,
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

/** One O/H/L/C bar, carried forward the same way `seriesValueAt` carries a single value. */
export interface TooltipBar {
  open: number;
  high: number;
  low: number;
  close: number;
}

export function seriesBarAt(
  series: ISeriesApi<'Candlestick'> | null,
  logical: number | null,
): TooltipBar | undefined {
  if (!series || logical == null) return undefined;
  try {
    const p = series.dataByIndex(
      logical,
      MismatchDirection.NearestLeft,
    ) as Partial<TooltipBar> | null;
    return isTooltipBar(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

function isTooltipBar(p: Partial<TooltipBar> | null | undefined): p is TooltipBar {
  return (
    !!p &&
    Number.isFinite(p.open) &&
    Number.isFinite(p.high) &&
    Number.isFinite(p.low) &&
    Number.isFinite(p.close)
  );
}

/**
 * Logical index for a chart time, via the time scale's own coordinate mapping.
 *
 * A pinned card knows only a timestamp — there is no cursor and therefore no `param.logical` —
 * but `dataByIndex` is the only way to carry a reading forward off-grid, and it wants an index.
 */
export function logicalAtTime(chart: IChartApi, time: CrosshairTime): number | null {
  try {
    // The time scale accepts a business day as readily as a timestamp; only the type says otherwise.
    const x = chart.timeScale().timeToCoordinate(time as UTCTimestamp);
    if (x == null || !Number.isFinite(x)) return null;
    const logical = chart.timeScale().coordinateToLogical(x);
    return logical == null || !Number.isFinite(logical) ? null : logical;
  } catch {
    return null;
  }
}

/**
 * Park a tooltip beside the cursor without letting it leave the pane.
 *
 * `desiredTop` is the intended top edge rather than the cursor's y, because the synced-crosshair
 * path below wants the card pinned to the top of the pane instead of trailing a y it never had.
 *
 * `flipAtMidpoint` switches sides once the cursor is past the pane's horizontal midpoint instead
 * of waiting until the card would overflow the right edge. That is the rule the stacked panes
 * follow (StrategyAnalysisView's `place`, and PinnedCrosshairLayer's `alignLeft`), and a pane
 * among them has to follow it too: on the last-resort rule its card is still sitting to the right
 * of the crosshair while every card above it has already swung left.
 */
export function placeTooltip(
  container: HTMLElement,
  tooltip: HTMLElement,
  cursorX: number,
  desiredTop: number,
  gap = 16,
  flipAtMidpoint = false,
): void {
  const tw = tooltip.offsetWidth;
  const th = tooltip.offsetHeight;
  let x =
    flipAtMidpoint && cursorX > container.clientWidth / 2 ? cursorX - tw - gap : cursorX + gap;
  // Still the backstop for a card that would run off the right edge before the midpoint — a wide
  // card in a narrow pane.
  if (x + tw > container.clientWidth) x = cursorX - tw - gap;
  let y = desiredTop;
  if (y + th > container.clientHeight) y = container.clientHeight - th - 8;
  tooltip.style.left = `${Math.max(4, x)}px`;
  tooltip.style.top = `${Math.max(4, y)}px`;
}

/**
 * The card's chrome — how its timestamp header and each reading are marked up.
 *
 * Split out because the same rows are read in two very different frames. On the Tracker the card
 * floats over someone else's price chart and stays deliberately plain; in a pane that sits in a
 * stack of sibling panes it has to match the cards those panes draw, or the stack reads as four
 * unrelated widgets. Only the markup varies — which rows exist, and how they are found, does not.
 */
export interface GreekTooltipStyle {
  header(time: CrosshairTime): string;
  row(color: string, label: string, value: string): string;
}

/** The Tracker's card: a bare timestamp over `tipRow`s. */
export const PLAIN_TOOLTIP_STYLE: GreekTooltipStyle = {
  header: (t) =>
    `<div style="font-size:10px;color:var(--text-muted);margin-bottom:4px">${fmtCrosshairTime(t)}</div>`,
  row: tipRow,
};

const PANEL_MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';

/**
 * The panel card used by panes that live in a stack: a ruled monospace timestamp over rows with
 * round swatches and tabular figures — the markup of `ChartTooltips`' `*Body` components, in the
 * innerHTML form this file writes. The two have to be edited together to stay in step.
 */
export const PANEL_TOOLTIP_STYLE: GreekTooltipStyle = {
  header: (t) =>
    `<div style="font-size:10px;color:var(--text-muted);font-family:${PANEL_MONO};letter-spacing:0.02em;` +
    `border-bottom:1px solid #ffffff0a;padding-bottom:4px;margin-bottom:6px">${fmtCrosshairTime(t)}</div>`,
  row: (color, label, val) =>
    `<div style="display:flex;align-items:center;justify-content:space-between;gap:16px;font-size:11px;padding:2px 0;white-space:nowrap">` +
    `<span style="display:flex;align-items:center;gap:6px;color:var(--text-secondary)">` +
    `<span style="width:8px;height:8px;border-radius:9999px;background:${escapeHtml(color)};flex:none"></span>` +
    `${escapeHtml(label)}</span>` +
    `<span style="color:var(--text-primary);font-weight:500;font-variant-numeric:tabular-nums">${escapeHtml(val)}</span>` +
    `</div>`,
};

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
  /** Card chrome. Defaults to the Tracker's plain card. */
  style?: GreekTooltipStyle;
  /** See `placeTooltip` — set by panes that sit in a stack of sibling panes. */
  flipAtMidpoint?: boolean;
}

/**
 * Card markup and placement, shared by the hover subscription below and the host-driven sync
 * path in `createGreekTooltip`.
 *
 * Greek/IV history is 1-minute while a live price line is 1-second, so `seriesData` is empty for
 * a greek series at ~59 of every 60 crosshair positions — rows would blink out and the tooltip
 * would collapse to just the price. Enumerating the pane's series and carrying the last known
 * value forward (NearestLeft) is what keeps them steady, rather than relying on an exact time hit.
 * `readExact` is the crosshair's own `seriesData` where there is one, and null for an instant the
 * host synced onto this pane, which carries no series data at all.
 */
function makeGreekTooltipRenderer(opts: GreekCrosshairOpts) {
  const { chart, container, tooltip, baseSeries, baseLabel, formatBase } = opts;
  const paneIndex = opts.paneIndex ?? 0;
  const style = opts.style ?? PLAIN_TOOLTIP_STYLE;

  const hide = () => {
    tooltip.style.display = 'none';
  };

  // The time scale reports x within the PLOT area, excluding any visible left price scale, while
  // the tooltip is positioned inside the whole pane div — which includes that gutter. Measured
  // rather than assumed: the scale's rendered width depends on its widest label.
  const leftGutter = (): number => {
    try {
      return chart.priceScale('left').width() ?? 0;
    } catch {
      return 0;
    }
  };

  /** `x` is plot-relative; `top` is the card's intended top edge within the pane. */
  const render = (
    time: CrosshairTime,
    logical: number | null,
    x: number,
    top: number,
    readExact: ((s: ISeriesApi<'Line'>) => number | undefined) | null,
  ) => {
    const rows: string[] = [];
    const base = baseSeries();
    if (base) {
      // Exact hit first, then carry forward — otherwise the price row is the one thing that
      // disappears on a synced crosshair, leaving greek rows with nothing to read them against.
      const exact = readExact?.(base);
      const v =
        typeof exact === 'number' && Number.isFinite(exact) ? exact : seriesValueAt(base, logical);
      if (v != null) rows.push(style.row('#2962ff', baseLabel(), formatBase(v)));
    }

    for (const r of greekRows(chart, base, readExact, logical, paneIndex)) {
      rows.push(style.row(r.color, r.label, fmtCompact(r.value)));
    }
    if (!rows.length) {
      hide();
      return;
    }
    tooltip.innerHTML = style.header(time) + rows.join('');
    tooltip.style.display = 'block';
    placeTooltip(container, tooltip, x + leftGutter(), top, 16, !!opts.flipAtMidpoint);
  };

  return { hide, render };
}

/**
 * Subscribe a crosshair tooltip listing the base series plus every visible greek line.
 * Returns an unsubscribe function.
 */
export function bindGreekCrosshair(opts: GreekCrosshairOpts): () => void {
  const { chart, container } = opts;
  const { hide, render } = makeGreekTooltipRenderer(opts);

  const onCrosshair = (param: MouseEventParams) => {
    // Some crosshair events arrive with a time but no point. Deriving x from the time scale
    // keeps the reading visible rather than blanking it.
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
      hide();
      return;
    }
    const logical =
      param.logical ?? (synced ? logicalAtTime(chart, param.time as CrosshairTime) : null);

    render(
      param.time as CrosshairTime,
      logical,
      pt.x,
      // No cursor to dodge on a point-less event, so pin the card to the top of the pane rather
      // than trailing a y that is really just 0.
      synced ? 8 : pt.y + 16,
      (s) => (param.seriesData.get(s) as { value?: number } | undefined)?.value,
    );
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

/** Drives the same card from an instant the host chose, rather than from a cursor. */
export interface GreekTooltipView {
  /** Show the reading at `time`; null hides the card. */
  showAt(time: CrosshairTime | null): void;
  hide(): void;
}

/**
 * A tooltip a HOST can drive, for panes it syncs a crosshair onto.
 *
 * `chart.setCrosshairPosition()` draws the crosshair but deliberately suppresses the
 * crosshairMove event (`setAndSaveSyntheticPosition` → `setAndSaveCurrentPosition(..., skipEvent:
 * true)` inside lightweight-charts), so a pane the host syncs gets crosshair LINES and no
 * notification — `bindGreekCrosshair` never runs for it and the card silently stays hidden. The
 * host has to say so itself, which is what this is for. Both may be created over one tooltip
 * element: the hover path owns the card while the cursor is in the pane, this one while it is not.
 */
export function createGreekTooltip(opts: GreekCrosshairOpts): GreekTooltipView {
  const { chart, container } = opts;
  const { hide, render } = makeGreekTooltipRenderer(opts);

  return {
    hide,
    showAt(time) {
      if (time == null) {
        hide();
        return;
      }
      let x: number | null = null;
      try {
        x = chart.timeScale().timeToCoordinate(time as UTCTimestamp);
      } catch {
        x = null;
      }
      // Scrolled out of the visible range — the crosshair is off-pane, so is its reading.
      if (x == null || !Number.isFinite(x) || x < 0 || x > container.clientWidth) {
        hide();
        return;
      }
      render(time, logicalAtTime(chart, time), x, 8, null);
    },
  };
}

// ─── Candlestick crosshair tooltip ───────────────────────────────────────────────
//
// The Chart view differs from the Tracker in two ways that the binding above cannot absorb:
// its base series is a candlestick (four numbers per bar, not one) and its greek overlays live
// in sub-panes below the price rather than inline on it. What the two share — carrying readings
// forward off-grid, escaping, and keeping the card inside the pane — is shared code.

const MUTED = 'color:var(--text-muted)';

function ohlcCell(label: string, value: string, color: string): string {
  return (
    `<span style="${MUTED};font-size:10px">${label}</span>` +
    `<span style="color:${color};font-weight:600;font-size:11px;text-align:right">${escapeHtml(value)}</span>`
  );
}

function metaRow(label: string, value: string, color: string): string {
  return (
    `<div style="display:flex;align-items:center;gap:6px;line-height:1.6;white-space:nowrap">` +
    `<span style="${MUTED};font-size:11px">${escapeHtml(label)}</span>` +
    `<span style="margin-left:auto;padding-left:14px;color:${color};font-weight:600;font-size:11px">${escapeHtml(value)}</span>` +
    `</div>`
  );
}

export interface CandleCrosshairOpts {
  chart: IChartApi;
  container: HTMLElement;
  tooltip: HTMLElement;
  candleSeries: () => ISeriesApi<'Candlestick'> | null;
  /** Volume histogram. Its row is skipped whenever the series is switched off. */
  volumeSeries: () => ISeriesApi<'Histogram'> | null;
  /** Symbol shown in the header, beside the timestamp. */
  symbol: () => string;
  formatPrice: (v: number) => string;
  formatVolume: (v: number) => string;
}

/**
 * Crosshair tooltip for the Chart view: the hovered candle's O/H/L/C and change, the volume bar
 * when it is on, and every visible greek overlay line from the sub-panes below.
 *
 * Positioning is driven by a DOM `mousemove` on the container rather than by `param.point`,
 * because `point.y` is measured within the pane the cursor is in. On a chart with Vega and Theta
 * panes underneath, trusting it would place the card hundreds of pixels too high whenever the
 * cursor was in a sub-pane. `param` is still what supplies the *data* — the mouse position alone
 * cannot say which bar the crosshair snapped to.
 */
export function bindCandleCrosshair(opts: CandleCrosshairOpts): () => void {
  const { chart, container, tooltip, candleSeries, volumeSeries, symbol } = opts;
  const { formatPrice, formatVolume } = opts;

  let cursor: { x: number; y: number } | null = null;
  let lastParam: MouseEventParams | null = null;

  const hide = () => {
    tooltip.style.display = 'none';
  };

  const render = () => {
    const param = lastParam;
    if (!param || param.time == null || !cursor) return hide();

    const candle = candleSeries();
    if (!candle) return hide();
    const logical = param.logical ?? logicalAtTime(chart, param.time as CrosshairTime);
    const exactBar = param.seriesData.get(candle) as Partial<TooltipBar> | undefined;
    const bar = isTooltipBar(exactBar) ? exactBar : seriesBarAt(candle, logical);
    if (!bar) return hide();

    const up = bar.close >= bar.open;
    const closeColor = up ? 'var(--green)' : 'var(--red)';
    const chg = bar.close - bar.open;
    const chgPct = bar.open ? (chg / bar.open) * 100 : 0;

    const parts: string[] = [
      `<div style="display:flex;align-items:baseline;gap:6px;margin-bottom:5px;padding-bottom:4px;border-bottom:1px solid var(--border)">` +
        `<span style="font-size:11px;font-weight:700;color:var(--text-primary)">${escapeHtml(symbol())}</span>` +
        `<span style="margin-left:auto;font-size:10px;${MUTED}">${fmtCrosshairTime(param.time as CrosshairTime)}</span>` +
        `</div>`,
      `<div style="display:grid;grid-template-columns:auto 1fr auto 1fr;gap:1px 8px;align-items:baseline">` +
        ohlcCell('O', formatPrice(bar.open), 'var(--text-primary)') +
        ohlcCell('H', formatPrice(bar.high), 'var(--green)') +
        ohlcCell('L', formatPrice(bar.low), 'var(--red)') +
        ohlcCell('C', formatPrice(bar.close), closeColor) +
        `</div>`,
      metaRow(
        'Chg',
        `${chg >= 0 ? '+' : ''}${formatPrice(chg)} (${chg >= 0 ? '+' : ''}${chgPct.toFixed(2)}%)`,
        closeColor,
      ),
    ];

    const vol = volumeSeries();
    // `visible:false` is how the Vol toggle switches the histogram off; the series still holds
    // its data, so without this check the row would report a volume the chart is not drawing.
    if (vol && vol.options().visible !== false) {
      const exactVol = (param.seriesData.get(vol) as { value?: number } | undefined)?.value;
      const v = typeof exactVol === 'number' ? exactVol : seriesValueAt(vol, logical);
      if (v != null) parts.push(metaRow('Vol', formatVolume(v), 'var(--text-primary)'));
    }

    const greeks = greekRowsAllPanes(
      chart,
      null,
      (s) => (param.seriesData.get(s) as { value?: number } | undefined)?.value,
      logical,
    );
    if (greeks.length) {
      parts.push(`<div style="height:1px;background:var(--border);margin:5px 0 4px"></div>`);
      for (const r of greeks)
        parts.push(tipRow(r.color, r.label, (r.format ?? fmtCompact)(r.value)));
    }

    tooltip.innerHTML = parts.join('');
    tooltip.style.display = 'block';
    placeTooltip(container, tooltip, cursor.x, cursor.y + 16);
  };

  // Both inputs fire for the same physical mouse move, and a render writes innerHTML then reads
  // offsetWidth — a forced layout. Coalescing to one render per frame halves that, and there is
  // nothing to see between two events in the same frame anyway.
  let raf = 0;
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      render();
    });
  };

  const onCrosshair = (param: MouseEventParams) => {
    lastParam = param;
    schedule();
  };
  // Pointer events rather than mouse events, so a touch or pen drag positions the card too —
  // `mousemove` is only synthesized for taps, and never during a drag.
  const onPointerMove = (e: PointerEvent) => {
    const rect = container.getBoundingClientRect();
    cursor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    // The crosshair fires on its own for every move over data; tracking the pointer here as well
    // keeps the card glued to the cursor in the margins, where the crosshair stays silent.
    schedule();
  };
  const onPointerLeave = () => {
    cursor = null;
    hide();
  };

  chart.subscribeCrosshairMove(onCrosshair);
  container.addEventListener('pointermove', onPointerMove);
  container.addEventListener('pointerleave', onPointerLeave);
  // A touch drag ends with pointerup and no leave; without this the card would be stranded.
  container.addEventListener('pointercancel', onPointerLeave);

  return () => {
    if (raf) cancelAnimationFrame(raf);
    container.removeEventListener('pointermove', onPointerMove);
    container.removeEventListener('pointerleave', onPointerLeave);
    container.removeEventListener('pointercancel', onPointerLeave);
    try {
      chart.unsubscribeCrosshairMove(onCrosshair);
    } catch {
      /* chart already disposed */
    }
  };
}
