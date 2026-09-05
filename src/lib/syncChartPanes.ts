import { LineSeries, type IChartApi, type LogicalRange, type Time } from 'lightweight-charts';
import { isChartLive } from './chartLifecycle';

function sameRange(a: LogicalRange | null, b: LogicalRange | null): boolean {
  return !!a && !!b && Math.abs(a.from - b.from) < 1e-6 && Math.abs(a.to - b.to) < 1e-6;
}

/** Logical indices are only interchangeable when every chart has the same timestamps. */
export function syncChartPanes(charts: IChartApi[]): () => void {
  const anchors = charts.map((chart) =>
    chart.addSeries(LineSeries, {
      visible: false,
      priceScaleId: '__shared_timeline',
      lastValueVisible: false,
      priceLineVisible: false,
    }),
  );
  const subscriptions = new Map<object, () => void>();
  const cleanups: Array<() => void> = [];
  let timeline: number[] = [];
  let dirty = true;
  let syncing = false;
  let frame = 0;
  let stopped = false;
  let range: LogicalRange | null = null;
  let source = charts[0];
  let leftWidth = 60;
  let rightWidth = 75;

  const schedule = () => {
    if (!stopped && !frame) frame = requestAnimationFrame(flush);
  };
  const discoverSeries = () => {
    for (const chart of charts.filter(isChartLive)) {
      for (const series of chart.panes().flatMap((pane) => pane.getSeries())) {
        if (anchors.includes(series as (typeof anchors)[number]) || subscriptions.has(series))
          continue;
        const changed = () => {
          dirty = true;
          schedule();
        };
        series.subscribeDataChanged(changed);
        subscriptions.set(series, () => series.unsubscribeDataChanged(changed));
        dirty = true;
      }
    }
  };
  const syncFollowers = () => {
    if (!range) return;
    for (const chart of charts) {
      // Applying even an identical range stops the library's kinetic scroll animation.
      // Let the input pane keep moving naturally; only its siblings need a range write.
      if (!isChartLive(chart) || chart === source) continue;
      const scale = chart.timeScale();
      if (!sameRange(scale.getVisibleLogicalRange(), range)) scale.setVisibleLogicalRange(range);
    }
  };
  function flush() {
    frame = 0;
    if (stopped) return;
    syncing = true;
    try {
      discoverSeries();
      const live = charts.filter(isChartLive);
      if (dirty) {
        dirty = false;
        const times = new Set<number>();
        for (const chart of live) {
          for (const series of chart.panes().flatMap((pane) => pane.getSeries())) {
            if (anchors.includes(series as (typeof anchors)[number])) continue;
            for (const point of series.data()) {
              if (typeof point.time === 'number') times.add(point.time);
            }
          }
        }
        const next = [...times].sort((a, b) => a - b);
        if (next.length !== timeline.length || next.some((time, i) => time !== timeline[i])) {
          timeline = next;
          // Hidden values also equalize the last data index. Whitespace alone leaves
          // each chart clamping scroll ranges against its own last priced bar.
          const data = timeline.map((time) => ({ time: time as Time, value: 0 }));
          charts.forEach((chart, i) => {
            if (isChartLive(chart)) anchors[i].setData(data);
          });
        }
      }
      // minimumWidth is a floor: a large P&L label can widen just one pane.
      // Measure actual gutters, then reserve that width in every sibling.
      leftWidth = Math.max(leftWidth, ...live.map((c) => c.priceScale('left').width()));
      rightWidth = Math.max(rightWidth, ...live.map((c) => c.priceScale('right').width()));
      for (const chart of live) {
        if (
          chart.options().leftPriceScale.minimumWidth !== leftWidth ||
          chart.options().rightPriceScale.minimumWidth !== rightWidth
        ) {
          chart.applyOptions({
            leftPriceScale: { minimumWidth: leftWidth },
            rightPriceScale: { minimumWidth: rightWidth },
          });
        }
      }
      if (!isChartLive(source)) source = live[0];
      // Layout/data work may run between animation frames; use the source's current
      // range, never replay a stale range onto the pane the user is moving.
      range = source?.timeScale().getVisibleLogicalRange() ?? range;
      syncFollowers();
    } finally {
      syncing = false;
    }
  }
  for (const chart of charts) {
    const scale = chart.timeScale();
    const onRange = (next: LogicalRange | null) => {
      // Range setters emit again on the library's next paint, after the synchronous
      // guard has cleared. Ignore those echoes (including harmless float rounding).
      if (syncing || !next || sameRange(next, range)) return;
      source = chart;
      range = next;
      syncing = true;
      try {
        discoverSeries();
        if (dirty) schedule();
        else syncFollowers();
      } finally {
        syncing = false;
      }
    };
    scale.subscribeVisibleLogicalRangeChange(onRange);
    scale.subscribeSizeChange(schedule);
    cleanups.push(() => {
      if (!isChartLive(chart)) return;
      scale.unsubscribeVisibleLogicalRangeChange(onRange);
      scale.unsubscribeSizeChange(schedule);
    });
  }
  flush();
  return () => {
    stopped = true;
    cancelAnimationFrame(frame);
    cleanups.forEach((cleanup) => cleanup());
    subscriptions.forEach((cleanup) => {
      try {
        cleanup();
      } catch {
        /* A series may already have been removed by its host. */
      }
    });
    charts.forEach((chart, i) => {
      if (isChartLive(chart)) chart.removeSeries(anchors[i]);
    });
  };
}
