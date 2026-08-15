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

/**
 * Mark-to-market on the quantity still open, in paise.
 *
 * `qty` from `/paper/positions` is unsigned and the direction lives in `order_side`, so the
 * side factor is what makes this correct for a short.
 */
export function openPositionUnrealisedPnlPaise(position: PaperPosition): number {
  const side = (position.order_side || '').includes('BUY') ? 1 : -1;
  return (
    side * ((position.last_traded_price || 0) - (position.avg_price || 0)) * (position.qty || 0)
  );
}

/**
 * Total P&L on an open position: mark-to-market **plus** anything already booked on it.
 *
 * A position is only "open" in the sense that some quantity remains; part of it may have been
 * squared off earlier, and that realised amount is already sitting on the row. Counting only the
 * unrealised part made the terminal's Day P&L, the per-leg P&L and the group total each disagree
 * with `/paper/pnl` (which has always summed both) by exactly the booked amount.
 *
 * This recomputes from the live LTP rather than trusting the server's `pnl` field, because the
 * `position_ltp` feed updates `last_traded_price` between the 2-second polls.
 */
export function openPositionPnlPaise(position: PaperPosition): number {
  return openPositionUnrealisedPnlPaise(position) + (position.realised_pnl || 0);
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
  // Includes each open position's already-booked realised P&L, so a partially squared-off leg
  // contributes its whole day rather than only the part still marked to market.
  const openPnl = open.reduce((sum, position) => sum + openPositionPnlPaise(position), 0);
  const closedPnl = closed.reduce(
    (sum, position) => sum + (position.realised_pnl || position.pnl || 0),
    0,
  );

  return { open, closed, totalPnlPaise: openPnl + closedPnl };
}
