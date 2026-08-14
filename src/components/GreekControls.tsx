// ── Aggregate Vega / Theta overlay controls (shared by Chart + Tracker views) ────
import type { GreekOverlayApi } from '../hooks/useGreekOverlay';
import { formatExpiry } from '../lib/utils';

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { v: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-md overflow-hidden border border-[var(--border)]">
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`px-2 py-1 text-[11px] font-medium transition-colors ${
            value === o.v
              ? 'bg-[var(--accent)] text-white'
              : 'bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * IV rank / percentile against a DTE-matched year of history.
 *
 * Both numbers are shown because they answer different questions and disagree usefully: rank
 * places the reading in the historical RANGE (one crisis print can pin an end of it), percentile
 * places it in the DISTRIBUTION. When they diverge, the range has an outlier in it.
 *
 * Every "no answer" case prints why. A blank or a plausible-looking 50 would both be worse than
 * "only 8 historical sessions at 32+ DTE".
 */
function IvRankPanel({ api }: { api: GreekOverlayApi }) {
  // Rank is a statement about the level of vol; RR and Fly are skew/smile, so there is nothing
  // meaningful to rank them against here.
  if (api.ivMeasure !== 'atm') {
    return (
      <div className="mt-2.5 pt-2.5 border-t border-[var(--border)] text-[9px] text-[var(--text-muted)]">
        IV rank applies to the ATM level — switch to ATM to see it.
      </div>
    );
  }

  const bar = (label: string, pct: number, color: string) => (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] text-[var(--text-secondary)]">{label}</span>
        <span className="text-[12px] font-semibold tabular-nums" style={{ color }}>
          {pct.toFixed(0)}%
        </span>
      </div>
      <div className="h-1 mt-0.5 rounded-full bg-[var(--bg-hover)] overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
    </div>
  );

  return (
    <div className="mt-2.5 pt-2.5 border-t border-[var(--border)]">
      <div className="text-[10px] font-semibold tracking-wider text-[var(--text-muted)] mb-1.5">
        IV RANK{' '}
        <span className="font-normal normal-case text-[9px]">· vs 1y at matched maturity</span>
      </div>

      {api.ivRankNote && (
        <div className="text-[9px] text-amber-500 leading-relaxed">
          No baseline: {api.ivRankNote}
        </div>
      )}

      {!api.ivRankNote && !api.ivRank && (
        <div className="text-[9px] text-[var(--text-muted)]">Loading baseline…</div>
      )}

      {api.ivRank && !api.ivRank.ok && (
        <div className="text-[9px] text-amber-500 leading-relaxed">
          {api.ivRank.gap.reason === 'thin-sample'
            ? `${api.ivRank.gap.detail} — not enough to rank against.`
            : api.ivRank.gap.detail}
        </div>
      )}

      {api.ivRank?.ok && (
        <div className="flex flex-col gap-1.5">
          {bar('Rank (in range)', api.ivRank.stats.rank, '#38bdf8')}
          {bar('Percentile (in distribution)', api.ivRank.stats.percentile, '#a78bfa')}
          <div className="text-[9px] text-[var(--text-muted)] leading-relaxed mt-0.5">
            {api.ivRank.stats.current.toFixed(2)} now · range {api.ivRank.stats.min.toFixed(2)}–
            {api.ivRank.stats.max.toFixed(2)} · median {api.ivRank.stats.median.toFixed(2)}
            <br />
            {api.ivRank.stats.count} sessions at {api.ivRank.stats.bucket.label} ({api.ivRankDte}{' '}
            DTE selected) · {api.ivRank.stats.from} → {api.ivRank.stats.to}
          </div>
          {api.selExpiries.length > 1 && (
            <div className="text-[9px] text-amber-500 leading-relaxed">
              {api.selExpiries.length} expiries plotted — the line is their mean, but the rank uses
              the nearest one&apos;s maturity.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function GreekButton({ api, label }: { api: GreekOverlayApi; label: string }) {
  return (
    <div className="relative flex items-stretch">
      <button
        onClick={api.toggle}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-l text-xs font-medium border border-r-0 transition-all ${
          api.on
            ? 'bg-[var(--accent)] border-[var(--accent)] text-white'
            : 'bg-[var(--bg-hover)] border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
        }`}
      >
        <span
          className={`w-3 h-3 rounded-sm border flex items-center justify-center shrink-0 ${api.on ? 'bg-white/30 border-white/60' : 'border-current opacity-60'}`}
        >
          {api.on && <span className="text-[8px] font-bold leading-none">✓</span>}
        </span>
        {label}
      </button>
      <button
        onClick={api.openSettings}
        className={`px-1.5 py-1 rounded-r text-xs font-medium border border-l-0 transition-all ${
          api.on
            ? 'bg-[var(--accent)] border-[var(--accent)] text-white hover:opacity-80'
            : 'bg-[var(--bg-hover)] border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
        }`}
      >
        ▾
      </button>

      {api.showPopup && (
        <div className="absolute top-full right-0 mt-1 z-50 w-[300px] max-h-[80vh] overflow-y-auto bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl">
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
            <span className="text-[13px] font-semibold text-[var(--text-primary)]">
              {label} Settings
            </span>
            <button
              onClick={() => api.setShowPopup(false)}
              className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-lg leading-none"
            >
              ×
            </button>
          </div>

          <div className="px-4 py-3 flex flex-col gap-3">
            {/* IV has no method/basket/CE-PE dimension — it's one constant-delta line. */}
            {api.isIv ? (
              <div>
                <div className="text-[10px] font-semibold tracking-wider text-[var(--text-muted)] mb-1.5">
                  MEASURE{' '}
                  <span className="font-normal normal-case text-[9px]">
                    · interpolated at constant delta
                  </span>
                </div>
                <Segmented
                  value={api.ivMeasure}
                  onChange={api.setIvMeasure}
                  options={[
                    { v: 'atm', label: 'ATM' },
                    { v: 'rr25', label: '25Δ RR' },
                    { v: 'fly25', label: '25Δ Fly' },
                  ]}
                />
                <div className="text-[9px] text-[var(--text-muted)] mt-1.5 leading-relaxed">
                  {api.ivMeasure === 'atm' &&
                    'Vol level at 50Δ. Spot-invariant, unlike a fixed-strike IV series.'}
                  {api.ivMeasure === 'rr25' &&
                    'Skew: 25Δ call IV − 25Δ put IV. Negative = puts bid over calls.'}
                  {api.ivMeasure === 'fly25' &&
                    'Smile: mean 25Δ wing IV − ATM IV. Higher = fatter tails.'}
                </div>
                <IvRankPanel api={api} />
              </div>
            ) : (
              <>
                <div>
                  <div className="text-[10px] font-semibold tracking-wider text-[var(--text-muted)] mb-1.5">
                    METHOD
                  </div>
                  <Segmented
                    value={api.method}
                    onChange={api.setMethod}
                    options={[
                      { v: 'mine', label: 'Mine' },
                      { v: 'industry', label: 'Industry' },
                      { v: 'both', label: 'Both' },
                    ]}
                  />
                </div>
                <div>
                  <div className="text-[10px] font-semibold tracking-wider text-[var(--text-muted)] mb-1.5">
                    BASKET
                  </div>
                  <Segmented
                    value={api.basket}
                    onChange={api.setBasket}
                    options={[
                      { v: 'fixed', label: 'Fixed' },
                      { v: 'floating', label: 'Floating' },
                    ]}
                  />
                </div>
                <div>
                  <div className="text-[10px] font-semibold tracking-wider text-[var(--text-muted)] mb-1.5">
                    COMPOSITION{' '}
                    <span className="font-normal normal-case text-[9px]">
                      · when the basket changes
                    </span>
                  </div>
                  <Segmented
                    value={api.composition}
                    onChange={api.setComposition}
                    options={[
                      { v: 'chained', label: 'Chained' },
                      { v: 'raw', label: 'Raw' },
                    ]}
                  />
                  <div className="text-[9px] text-[var(--text-muted)] mt-1.5 leading-relaxed">
                    {api.composition === 'chained'
                      ? 'Splices out the step a strike makes joining or leaving, so only Greek movement moves the line. The level is a chained figure, like a back-adjusted future.'
                      : 'Plain sum of whatever is in the basket right now — the true level, but it steps whenever a strike joins or leaves.'}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] font-semibold tracking-wider text-[var(--text-muted)] mb-1.5">
                    BASELINE{' '}
                    <span className="font-normal normal-case text-[9px]">· where t₀ sits</span>
                  </div>
                  <Segmented
                    value={api.baseline}
                    onChange={api.setBaseline}
                    options={[
                      { v: 'session', label: 'Session' },
                      { v: 'window', label: 'Window' },
                    ]}
                  />
                  <div className="text-[9px] text-[var(--text-muted)] mt-1.5 leading-relaxed">
                    {api.baseline === 'session'
                      ? "Re-anchors each day: fixed basket re-locks at the day's first tick and Δ returns to zero."
                      : 'One anchor for the whole loaded window — Δ runs cumulatively across days.'}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] font-semibold tracking-wider text-[var(--text-muted)] mb-1.5">
                    SERIES
                  </div>
                  <Segmented
                    value={api.seriesMode}
                    onChange={api.setSeriesMode}
                    options={[
                      { v: 'totals', label: 'Totals' },
                      { v: 'diff', label: 'Difference' },
                      { v: 'both', label: 'Both' },
                    ]}
                  />
                </div>

                <div className="flex items-center gap-4">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={api.showCalls}
                      onChange={(e) => api.setShowCalls(e.target.checked)}
                      className="accent-[var(--accent)] w-3.5 h-3.5 shrink-0"
                    />
                    <span className="text-[12px] text-[var(--text-primary)]">CE</span>
                    <span
                      className="w-3.5 h-3.5 rounded-sm"
                      style={{ backgroundColor: api.ceColor }}
                    />
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={api.showPuts}
                      onChange={(e) => api.setShowPuts(e.target.checked)}
                      className="accent-[var(--accent)] w-3.5 h-3.5 shrink-0"
                    />
                    <span className="text-[12px] text-[var(--text-primary)]">PE</span>
                    <span
                      className="w-3.5 h-3.5 rounded-sm"
                      style={{ backgroundColor: api.peColor }}
                    />
                  </label>
                </div>
              </>
            )}

            {api.expiries.length > 0 && (
              <div>
                <div className="text-[10px] font-semibold tracking-wider text-[var(--text-muted)] mb-1.5">
                  EXPIRY{' '}
                  <span className="font-normal normal-case text-[9px]">
                    · shift-click for a range
                  </span>
                </div>
                <div className="flex flex-col gap-1 max-h-[120px] overflow-y-auto">
                  {api.expiries.map((exp) => (
                    <label
                      key={exp}
                      onClick={(e) => {
                        e.preventDefault();
                        api.toggleExpiry(exp, e.shiftKey);
                      }}
                      className="flex items-center gap-2 cursor-pointer select-none"
                    >
                      <input
                        type="checkbox"
                        readOnly
                        checked={api.selExpiries.includes(exp)}
                        className="accent-[var(--accent)] w-3.5 h-3.5 shrink-0"
                      />
                      <span className="text-[12px] text-[var(--text-primary)]">
                        {formatExpiry(exp)}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div>
              <div className="text-[10px] font-semibold tracking-wider text-[var(--text-muted)] mb-1.5">
                HISTORIC DAY{' '}
                <span className="font-normal normal-case text-[9px]">
                  · reconstruct any past session
                </span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={api.greekDate}
                  max={api.latestDay || undefined}
                  onChange={(e) => e.target.value && api.setGreekDate(e.target.value)}
                  className="flex-1 px-2 py-1 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-md text-[12px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
                />
                <button
                  onClick={() => api.latestDay && api.setGreekDate(api.latestDay)}
                  disabled={!api.latestDay || api.greekDate === api.latestDay}
                  className="px-2.5 py-1 rounded-md text-[11px] font-medium border border-[var(--border)] bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40"
                  title="Jump to the latest session (live)"
                >
                  Latest
                </button>
              </div>
            </div>

            {api.histState === 'nogreeks' && (
              <div className="text-[10px] text-amber-500">
                Historical Greeks unavailable — series starts from now.
              </div>
            )}
            {api.histState === 'loading' && (
              <div className="text-[10px] text-[var(--text-muted)]">Loading history…</div>
            )}
            {(api.histState === 'ok' || api.histState === 'partial') && (
              <div className="text-[10px] text-[var(--text-muted)]">
                {api.greekDate === api.latestDay
                  ? `${api.histGranularity} reconstructed (last sessions); live = per-tick`
                  : `Through ${api.greekDate} (${api.histGranularity}, last sessions); past — no live`}
              </div>
            )}
            {api.histState === 'partial' && (
              <div className="text-[10px] text-amber-500">
                {api.droppedLegs} leg{api.droppedLegs === 1 ? '' : 's'} dropped — no finite IV
                (stale or sub-intrinsic prints). Gaps are real, not smoothed over.
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-[var(--border)]">
            <button
              onClick={() => api.setShowPopup(false)}
              className="px-3 py-1.5 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              Close
            </button>
            <button
              onClick={api.applySettings}
              className="px-4 py-1.5 rounded-lg bg-[var(--accent)] text-white text-[12px] font-medium hover:bg-[var(--accent-dim)] transition-colors"
            >
              Apply Expiry
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
