import { useEffect, useState } from 'react';
import {
  BACKDATED_SOURCES,
  fetchBackdatedPreview,
  normalizeHms,
  type BackdatedEntry,
  type BackdatedPreview,
} from '../lib/backdatedEntry';

interface Props {
  value: BackdatedEntry;
  onChange: (next: BackdatedEntry) => void;
  /** The instrument to preview the chosen second's prices for; omitted for a multi-leg basket. */
  preview?: { exchange?: string; type: string; symbol: string } | null;
}

const muted = 'var(--text-muted, #888)';
const border = 'var(--border, #2a2d3e)';

/**
 * "Entry: Now | Earlier today". With "Now" (the default) it renders only the toggle and the order
 * behaves exactly as it always has; "Earlier today" reveals the HH:MM:SS entry and the price source.
 */
export default function BackdatedEntryControl({ value, onChange, preview }: Props) {
  const [quote, setQuote] = useState<BackdatedPreview | null>(null);
  const [error, setError] = useState('');

  const symbol = preview?.symbol;
  const type = preview?.type;
  const exchange = preview?.exchange;
  useEffect(() => {
    setQuote(null);
    setError('');
    if (!value.enabled || !symbol || !type || !/^\d{2}:\d{2}(:\d{2})?$/.test(value.time)) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      fetchBackdatedPreview({ exchange, type, symbol, time: value.time }, ctl.signal)
        .then(setQuote)
        .catch((e: Error) => {
          if (e.name !== 'AbortError') setError(e.message);
        });
    }, 400);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [value.enabled, value.time, symbol, type, exchange]);

  const pill = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: '5px 0',
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    background: active ? 'rgba(59,130,246,.15)' : 'transparent',
    color: active ? '#60a5fa' : muted,
    border: `1px solid ${active ? 'rgba(59,130,246,.4)' : border}`,
  });

  const chosen =
    quote && (value.source === 'vwap' ? (quote.vwap ?? quote.close) : quote[value.source]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, color: muted, width: 38 }}>Entry</span>
        <button
          type="button"
          style={pill(!value.enabled)}
          onClick={() => onChange({ ...value, enabled: false })}
        >
          Now
        </button>
        <button
          type="button"
          style={pill(value.enabled)}
          onClick={() => onChange({ ...value, enabled: true })}
          title="Enter as if the order filled at an earlier second today, then track it live"
        >
          Earlier today
        </button>
      </div>

      {value.enabled && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, color: muted, width: 38 }}>At</span>
            <input
              type="time"
              step={1}
              value={value.time}
              onChange={(e) => onChange({ ...value, time: normalizeHms(e.target.value) })}
              style={{
                flex: 1,
                padding: '5px 8px',
                background: 'transparent',
                border: `1px solid ${border}`,
                borderRadius: 4,
                color: 'inherit',
                fontSize: 12,
                colorScheme: 'dark',
              }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 11, color: muted, width: 42 }}>Price</span>
            {BACKDATED_SOURCES.map((s) => (
              <button
                key={s.id}
                type="button"
                style={pill(value.source === s.id)}
                onClick={() => onChange({ ...value, source: s.id })}
              >
                {s.label}
              </button>
            ))}
          </div>
          {preview && (
            <div style={{ fontSize: 11, color: muted, lineHeight: 1.5 }}>
              {error ? (
                <span style={{ color: '#f87171' }}>{error}</span>
              ) : quote ? (
                <>
                  <span>
                    O {quote.open.toFixed(2)} · H {quote.high.toFixed(2)} · L {quote.low.toFixed(2)}{' '}
                    · C {quote.close.toFixed(2)}
                    {quote.vwap != null && ` · VWAP ${quote.vwap.toFixed(2)}`}
                  </span>
                  <br />
                  <span style={{ color: 'var(--text-primary, #fff)', fontWeight: 600 }}>
                    Fills at ₹{chosen?.toFixed(2)}
                  </span>
                  {!quote.exact &&
                    ` · no trade at ${normalizeHms(value.time)}, using ${quote.actual_time}`}
                  {value.source === 'vwap' &&
                    quote.vwap_fallback &&
                    ' · no volume that minute, using Close'}
                </>
              ) : (
                'Reading that second…'
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
