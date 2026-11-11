/**
 * The Strangle Max Loss report (the published NIFTY/SENSEX artifact, saved as
 * `.signal-cache/<UND>/max-loss-report.html`) shown inside the Trade Explorer tab.
 *
 * The file on disk stays exactly as published. When it is served, one hook is added at the top
 * of the report's own `openDay(date, key, list)`, the single function every day-click in the
 * report goes through: inside the dashboard the click is handed to the Trade Explorer, which opens
 * that day with the same strike choice. Opened on its own, the report behaves as before.
 */
export const MAX_LOSS_REPORT_FILE = 'max-loss-report.html';
export const OPEN_DAY_MESSAGE = 'max-loss-report:open-day';

const OPEN_DAY = 'async function openDay(date, key, list) {';

const HOOK =
  ' if (window.parent !== window) {' +
  ` window.parent.postMessage({ type: '${OPEN_DAY_MESSAGE}', date, key: key || 'otm2',` +
  ' list: Array.isArray(list) ? list : [] }, location.origin); return; }';

/** The report with its day-clicks routed to the Trade Explorer; null when the hook point is gone. */
export function withExplorerHook(html: string): string | null {
  const at = html.indexOf(OPEN_DAY);
  if (at < 0 || html.indexOf(OPEN_DAY, at + 1) >= 0) return null;
  const end = at + OPEN_DAY.length;
  return html.slice(0, end) + HOOK + html.slice(end);
}
