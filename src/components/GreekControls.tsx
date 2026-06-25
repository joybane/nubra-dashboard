// ── Aggregate Vega / Theta overlay controls (shared by Chart + Tracker views) ────
import type { GreekOverlayApi } from '../hooks/useGreekOverlay';
import { formatExpiry } from '../lib/utils';

export function Segmented<T extends string>({ value, options, onChange }: {
  value: T; options: { v: T; label: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-md overflow-hidden border border-[var(--border)]">
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`px-2 py-1 text-[11px] font-medium transition-colors ${
            value === o.v ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function GreekButton({ api, label }: { api: GreekOverlayApi; label: string }) {
  return (
    <div className="relative flex items-stretch">
      <button
        onClick={api.toggle}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-l text-xs font-medium border border-r-0 transition-all ${
          api.on ? 'bg-[var(--accent)] border-[var(--accent)] text-white' : 'bg-[var(--bg-hover)] border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
        }`}
      >
        <span className={`w-3 h-3 rounded-sm border flex items-center justify-center shrink-0 ${api.on ? 'bg-white/30 border-white/60' : 'border-current opacity-60'}`}>
          {api.on && <span className="text-[8px] font-bold leading-none">✓</span>}
        </span>
        {label}
      </button>
      <button
        onClick={api.openSettings}
        className={`px-1.5 py-1 rounded-r text-xs font-medium border border-l-0 transition-all ${
          api.on ? 'bg-[var(--accent)] border-[var(--accent)] text-white hover:opacity-80' : 'bg-[var(--bg-hover)] border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
        }`}
      >
        ▾
      </button>

      {api.showPopup && (
        <div className="absolute top-full right-0 mt-1 z-50 w-[300px] max-h-[80vh] overflow-y-auto bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl">
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
            <span className="text-[13px] font-semibold text-[var(--text-primary)]">{label} Settings</span>
            <button onClick={() => api.setShowPopup(false)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-lg leading-none">×</button>
          </div>

          <div className="px-4 py-3 flex flex-col gap-3">
            <div>
              <div className="text-[10px] font-semibold tracking-wider text-[var(--text-muted)] mb-1.5">METHOD</div>
              <Segmented value={api.method} onChange={api.setMethod} options={[
                { v: 'mine', label: 'Mine' }, { v: 'industry', label: 'Industry' }, { v: 'both', label: 'Both' },
              ]} />
            </div>
            <div>
              <div className="text-[10px] font-semibold tracking-wider text-[var(--text-muted)] mb-1.5">BASKET</div>
              <Segmented value={api.basket} onChange={api.setBasket} options={[
                { v: 'fixed', label: 'Fixed' }, { v: 'floating', label: 'Floating' },
              ]} />
            </div>
            <div>
              <div className="text-[10px] font-semibold tracking-wider text-[var(--text-muted)] mb-1.5">SERIES</div>
              <Segmented value={api.seriesMode} onChange={api.setSeriesMode} options={[
                { v: 'totals', label: 'Totals' }, { v: 'diff', label: 'Difference' }, { v: 'both', label: 'Both' },
              ]} />
            </div>

            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={api.showCalls} onChange={(e) => api.setShowCalls(e.target.checked)} className="accent-[var(--accent)] w-3.5 h-3.5 shrink-0" />
                <span className="text-[12px] text-[var(--text-primary)]">CE</span>
                <span className="w-3.5 h-3.5 rounded-sm" style={{ backgroundColor: api.ceColor }} />
              </label>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={api.showPuts} onChange={(e) => api.setShowPuts(e.target.checked)} className="accent-[var(--accent)] w-3.5 h-3.5 shrink-0" />
                <span className="text-[12px] text-[var(--text-primary)]">PE</span>
                <span className="w-3.5 h-3.5 rounded-sm" style={{ backgroundColor: api.peColor }} />
              </label>
            </div>

            {api.expiries.length > 0 && (
              <div>
                <div className="text-[10px] font-semibold tracking-wider text-[var(--text-muted)] mb-1.5">
                  EXPIRY <span className="font-normal normal-case text-[9px]">· shift-click for a range</span>
                </div>
                <div className="flex flex-col gap-1 max-h-[120px] overflow-y-auto">
                  {api.expiries.map((exp) => (
                    <label
                      key={exp}
                      onClick={(e) => { e.preventDefault(); api.toggleExpiry(exp, e.shiftKey); }}
                      className="flex items-center gap-2 cursor-pointer select-none"
                    >
                      <input type="checkbox" readOnly checked={api.selExpiries.includes(exp)} className="accent-[var(--accent)] w-3.5 h-3.5 shrink-0" />
                      <span className="text-[12px] text-[var(--text-primary)]">{formatExpiry(exp)}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div>
              <div className="text-[10px] font-semibold tracking-wider text-[var(--text-muted)] mb-1.5">
                HISTORIC DAY <span className="font-normal normal-case text-[9px]">· reconstruct any past session</span>
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
              <div className="text-[10px] text-amber-500">Historical Greeks unavailable — series starts from now.</div>
            )}
            {api.histState === 'loading' && (
              <div className="text-[10px] text-[var(--text-muted)]">Loading history…</div>
            )}
            {api.histState === 'ok' && (
              <div className="text-[10px] text-[var(--text-muted)]">
                {api.greekDate === api.latestDay
                  ? `${api.histGranularity} reconstructed (last sessions); live = per-tick`
                  : `Through ${api.greekDate} (${api.histGranularity}, last sessions); past — no live`}
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-[var(--border)]">
            <button onClick={() => api.setShowPopup(false)} className="px-3 py-1.5 text-[12px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">Close</button>
            <button onClick={api.applySettings} className="px-4 py-1.5 rounded-lg bg-[var(--accent)] text-white text-[12px] font-medium hover:bg-[var(--accent-dim)] transition-colors">Apply Expiry</button>
          </div>
        </div>
      )}
    </div>
  );
}
