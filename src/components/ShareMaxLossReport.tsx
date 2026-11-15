import { useState } from 'react';

export interface ReportInfo {
  ok: boolean;
  mtime?: number;
  bytes?: number;
  through?: string;
  builtAt?: string;
}

/**
 * Shares the Strangle Max Loss report as one standalone HTML file (all data inside, opens in any
 * browser). Uses the system share sheet where the browser offers file sharing, otherwise saves it.
 */
export default function ShareMaxLossReport({
  underlying,
  info,
}: {
  underlying: string;
  info: ReportInfo | null;
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'saved' | 'shared' | 'error'>('idle');
  const [note, setNote] = useState('');
  const name = `${underlying} Strangle Max Loss${info?.through ? ` to ${info.through}` : ''}.html`;

  const share = async () => {
    setState('busy');
    setNote('');
    try {
      const res = await fetch(
        `/api/signal-backtest/max-loss-report?underlying=${underlying}&raw=1`,
      );
      if (!res.ok) throw new Error(`the report could not be read (${res.status})`);
      const blob = await res.blob();
      const file = new File([blob], name, { type: 'text/html' });
      const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
      if (nav.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: `${underlying} Strangle Max Loss` });
          setState('shared');
          return;
        } catch (e) {
          if ((e as DOMException).name === 'AbortError') {
            setState('idle');
            return;
          }
          // Share sheet refused the file: fall through to saving it.
        }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setState('saved');
      setNote(`Saved "${name}" to your downloads; send it as an attachment.`);
    } catch (e) {
      setState('error');
      setNote(String((e as Error).message ?? e));
    }
  };

  return (
    <span className="flex items-center gap-2">
      {info?.through && <span className="text-[var(--text-muted)]">data to {info.through}</span>}
      <button
        type="button"
        className="rounded border border-[var(--accent)] px-2 py-1 font-semibold text-[var(--accent)] disabled:opacity-60"
        disabled={state === 'busy' || !info?.ok}
        onClick={() => void share()}
        title="Share this report as one HTML file that opens in any browser"
      >
        {state === 'busy' ? 'Preparing…' : 'Share report'}
      </button>
      {info?.bytes != null && (
        <span className="text-[var(--text-muted)]">{(info.bytes / 1048576).toFixed(1)} MB</span>
      )}
      {state === 'shared' && <span className="text-[var(--text-muted)]">Shared.</span>}
      {note && (
        <span className={state === 'error' ? 'text-[var(--red)]' : 'text-[var(--text-muted)]'}>
          {note}
        </span>
      )}
    </span>
  );
}
