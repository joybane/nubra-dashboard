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
  /**
   * The line this reading came from, where there was one. Absent on rows a caller synthesised —
   * the underlying's price row, which its host prepends by hand.
   *
   * Carried so a caller can go back to the series for things a value alone cannot answer: what y
   * it sits at (`priceToCoordinate`), or what range its scale is holding. That is what lets the
   * left axis follow the cursor without re-walking the pane's series a second time.
   */
  series?: ISeriesApi<'Line'>;
}

/**
 * Read every visible greek line on `paneIndex`, skipping `exclude` (the host's own price series).
 *
 * `exclude` takes a list as readily as one series, because a pane may carry more than one series
 * that is not a reading: `GreekIndicatorPane` also owns an invisible anchor whose only job is to
 * lend its scale to the left axis. Without it the anchor would show up as a nameless row in every
 * tooltip and pinned card.
 *
 * `readExact` supplies a value when the caller already has one for this instant — the crosshair
 * path passes `param.seriesData`. Where that misses, the reading is carried forward from the last
 * bar at or before `logical`: greek history is 1-minute while a live price line is 1-second, so an
 * exact hit fails at ~59 of every 60 cursor positions and the rows would otherwise blink out.
 */
export function greekRows(
  chart: IChartApi,
  exclude: ISeriesApi<'Line'> | ReadonlyArray<ISeriesApi<'Line'> | null> | null,
  readExact: ((s: ISeriesApi<'Line'>) => number | undefined) | null,
  logical: number | null,
  paneIndex = 0,
): GreekRow[] {
  const skip = new Set(Array.isArray(exclude) ? exclude : [exclude]);
  let overlaySeries: ISeriesApi<'Line'>[] = [];
  try {
    overlaySeries = (chart.panes()[paneIndex]?.getSeries() ?? []).filter(
      (s) => !skip.has(s as ISeriesApi<'Line'>),
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
    rows.push({ color: o.color || '#888', label: o.title || '', value: v, series });
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
  exclude: ISeriesApi<'Line'> | ReadonlyArray<ISeriesApi<'Line'> | null> | null,
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
 * The gap the stacked panes put between crosshair and card — StrategyAnalysisView's own `GAP`.
 * Theirs, not this file's: matching it is the point. See the STACKED section of `placeTooltip`,
 * which is why that path ignores the `gap` argument.
 */
const STACK_GAP = 24;

/**
 * Park a tooltip beside the cursor without letting it leave the pane.
 *
 * `desiredTop` is the intended top edge rather than the cursor's y, because the synced-crosshair
 * path below wants the card pinned to the top of the pane instead of trailing a y it never had.
 *
 * ── STACKED (`flipAtMidpoint`) ──
 * A pane living in a stack of sibling panes has to place its card by the *same* rule its siblings
 * use, or it visibly disagrees with them: `place` in StrategyAnalysisView and `alignLeft` in
 * PinnedCrosshairLayer both swing left once the cursor passes the pane's horizontal midpoint,
 * while this card used to sit right until it would have overflowed.
 *
 * Matching them means copying HOW they place it, not just when. They anchor a flipped card by CSS
 * — `translate3d(calc(Xpx - 100%), …)` — and never measure it. This used to subtract a measured
 * `offsetWidth` instead, and a greek card's width follows its widest reading, which changes digit
 * count on every tick: the card's left edge crept with the numbers even under a motionless cursor.
 * The old right-edge backstop was worse, because it could flip a card the shared rule had just
 * decided to leave on the right — the "every other pane went left, this one didn't" case.
 *
 * The one measurement left is the off-left check, and it decides only WHETHER to flip, never where
 * the card lands. It can bite only when the card is wider than half the pane, so it turns over when
 * the row set changes and not when a digit does.
 *
 * `gap` applies to the un-flagged path only; the stacked one uses the siblings' own `STACK_GAP`,
 * since agreeing with them is the whole requirement.
 *
 * The un-flagged path — the Tracker and the Chart view, whose cards float alone over their own
 * chart and answer to nobody — is untouched.
 */
export function placeTooltip(
  container: HTMLElement,
  tooltip: HTMLElement,
  cursorX: number,
  desiredTop: number,
  gap = 16,
  flipAtMidpoint = false,
): void {
  if (flipAtMidpoint) {
    const cw = container.clientWidth;
    // Same expression as the siblings', so the two cannot disagree at the boundary.
    const alignLeft =
      cursorX > cw * 0.5 &&
      // …unless flipping would push the card off the pane's left edge entirely.
      cursorX - STACK_GAP - tooltip.offsetWidth >= 4;
    const x = alignLeft ? cursorX - STACK_GAP : cursorX + STACK_GAP;
    // `transform` supersedes left/top, which an earlier call on the un-flagged path may have set.
    tooltip.style.left = '0px';
    tooltip.style.top = '0px';
    tooltip.style.transform = alignLeft
      ? `translate3d(calc(${x}px - 100%), ${desiredTop}px, 0)`
      : `translate3d(${x}px, ${desiredTop}px, 0)`;
    return;
  }

  const tw = tooltip.offsetWidth;
  const th = tooltip.offsetHeight;
  let x = cursorX + gap;
  // The backstop for a card that would run off the right edge.
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
  /**
   * Further series to keep out of the rows, on top of `baseSeries`. For panes carrying a series
   * that is not a reading — `GreekIndicatorPane`'s invisible axis anchor.
   */
  excludeSeries?: () => ReadonlyArray<ISeriesApi<'Line'> | null>;
  /** Card chrome. Defaults to the Tracker's plain card. */
  style?: GreekTooltipStyle;
  /** See `placeTooltip` — set by panes that sit in a stack of sibling panes. */
  flipAtMidpoint?: boolean;
  /**
   * Whether the cursor is physically over this pane right now.
   *
   * Which of the two drivers over one card is allowed to write it. The hover binding owns the card
   * while the cursor is in the pane and the host-synced view owns it while the cursor is out — the
   * arrangement `createGreekTooltip`'s doc describes, and which nothing used to enforce.
   *
   * It has to be enforced because lightweight-charts re-fires `crosshairMove` on whichever pane
   * last held a crosshair position whenever a series is `update()`d — including a position placed
   * synthetically by `setCrosshairPosition`, which is exactly what a host does to a pane the cursor
   * is NOT over. So on every live tick the hover binding woke up for a cursor that was somewhere
   * else and re-placed the card by its own rule, fighting the host's placement: the card shook, and
   * moving the mouse for real settled it. StrategyAnalysisView defends its own tooltips from the
   * same echo with a `sourceChart !== hoveredChartRef.current` guard.
   *
   * Omit it and both drivers stay unguarded, which is correct for a chart that has only one.
   */
  isPointerInside?: () => boolean;
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

    for (const r of greekRows(
      chart,
      [base, ...(opts.excludeSeries?.() ?? [])],
      readExact,
      logical,
      paneIndex,
    )) {
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

  /**
   * The card's top edge, by the rule this pane's neighbours use.
   *
   * Stacked, the siblings park the card a fixed distance ABOVE the cursor and clamp it into the
   * pane (`place` in StrategyAnalysisView), rather than trailing below it. Trailing is what the
   * lone cards do, and it is kept for them. The clamp is deliberately against the pane's height
   * alone and never the card's: a greek card gains and loses rows as measures come and go and as
   * readings carry forward, and clamping against a measured height moved the card every time the
   * row count changed.
   */
  const topFor = (cursorY: number | null): number => {
    if (cursorY == null) return 8; // synced from elsewhere — pin it to the top of the pane
    if (!opts.flipAtMidpoint) return cursorY + 16;
    return Math.max(8, Math.min(cursorY - 80, container.clientHeight - 100));
  };

  return { hide, render, topFor };
}

/**
 * Subscribe a crosshair tooltip listing the base series plus every visible greek line.
 * Returns an unsubscribe function.
 */
export function bindGreekCrosshair(opts: GreekCrosshairOpts): () => void {
  const { chart, container } = opts;
  const { hide, render, topFor } = makeGreekTooltipRenderer(opts);

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
    // Checked here and not at the top: "the crosshair is gone" must be honoured whoever it comes
    // from, or a cursor that leaves the pane strands the card on its last reading. What is refused
    // is only the PLACEMENT of a live one — this is the synthetic echo described on
    // `isPointerInside`, and the host-synced view owns the card while the cursor is elsewhere.
    if (opts.isPointerInside && !opts.isPointerInside()) return;
    const logical =
      param.logical ?? (synced ? logicalAtTime(chart, param.time as CrosshairTime) : null);

    render(
      param.time as CrosshairTime,
      logical,
      pt.x,
      // No cursor to dodge on a point-less event, so pin the card to the top of the pane rather
      // than trailing a y that is really just 0.
      topFor(synced ? null : pt.y),
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
  const { hide, render, topFor } = makeGreekTooltipRenderer(opts);

  return {
    hide,
    showAt(time) {
      if (time == null) {
        // Always honoured, even with the cursor in the pane: this is the host saying the crosshair
        // is gone everywhere. The hover binding re-shows the card on the very next move.
        hide();
        return;
      }
      // The cursor is in this pane, so the hover binding is driving the card off a real position.
      // Overwriting it here is what put two rules on one element — see `isPointerInside`.
      if (opts.isPointerInside?.()) return;
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
      render(time, logicalAtTime(chart, time), x, topFor(null), null);
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
