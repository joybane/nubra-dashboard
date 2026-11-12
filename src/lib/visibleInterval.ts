// ─────────────────────────────────────────────────────────────────────────────
// Polling that rests while nobody can see it.
//
// The dashboard's display polls (positions, orders, watchlist prices, tracker badges…) used to run
// every 2–5 s for as long as the tab existed — minimised, behind another window, overnight. Each
// tick is a request to this server and, for chain reads, often one to the broker too.
//
// Only for polls whose sole job is to refresh what is on screen. Anything that must keep
// *recording* while unseen — the OI snapshot loop, the greek-overlay fallback that stores history —
// keeps a plain setInterval. Stop-loss / target rules run on the server and never depended on these.
// ─────────────────────────────────────────────────────────────────────────────

/** True while the page is not visible (minimised window, background tab). */
export function isPageHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden === true;
}

/**
 * Like setInterval, but skips ticks while the page is hidden and fires once as soon as it is
 * shown again, so the view is current the moment you look at it instead of up to `ms` later.
 * Returns the cleanup function — return it straight from a useEffect.
 */
export function setVisibleInterval(fn: () => void, ms: number): () => void {
  const id = setInterval(() => {
    if (!isPageHidden()) fn();
  }, ms);
  const onVisibility = () => {
    if (!isPageHidden()) fn();
  };
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    clearInterval(id);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
