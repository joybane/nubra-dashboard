import type { PaperPosition } from '../types';

export interface TodayPositionSummary {
  open: PaperPosition[];
  closed: PaperPosition[];
  totalPnlPaise: number;
}

export function isOnLocalDay(ns: number | undefined | null, day: Date = new Date()): boolean {
  if (!ns) return true;
  const timestamp = new Date(ns / 1_000_000);
  return (
    timestamp.getFullYear() === day.getFullYear() &&
    timestamp.getMonth() === day.getMonth() &&
    timestamp.getDate() === day.getDate()
  );
}

export function openPositionPnlPaise(position: PaperPosition): number {
  const side = (position.order_side || '').includes('BUY') ? 1 : -1;
  return (
    side * ((position.last_traded_price || 0) - (position.avg_price || 0)) * (position.qty || 0)
  );
}

export function summarizeTodayPositions(
  openPositions: PaperPosition[],
  closedPositions: PaperPosition[],
  day: Date = new Date(),
): TodayPositionSummary {
  const open = openPositions.filter((position) => isOnLocalDay(position.entry_time, day));
  const closed = closedPositions.filter(
    (position) => isOnLocalDay(position.exit_time, day) || isOnLocalDay(position.entry_time, day),
  );
  const openPnl = open.reduce((sum, position) => sum + openPositionPnlPaise(position), 0);
  const closedPnl = closed.reduce(
    (sum, position) => sum + (position.realised_pnl || position.pnl || 0),
    0,
  );

  return { open, closed, totalPnlPaise: openPnl + closedPnl };
}
