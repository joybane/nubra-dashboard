import { useEffect, useRef, useState } from 'react';

interface UpdateState {
  running: boolean;
  underlying: string | null;
  phase: 'idle' | 'download' | 'run' | 'groups' | 'done' | 'error';
  message: string;
  finishedAt: number | null;
}

/**
 * "Update data" for the Trade Explorer: downloads new days, re-runs the backtest with the saved
 * settings and rebuilds the saved run (server/signalBacktest/explorerUpdate.ts). When it finishes,
 * `onUpdated` reloads the tab's data.
 */
export default function TradeExplorerUpdate({
  underlying,
  onUpdated,
}: {
  underlying: string;
  onUpdated: () => void;
}) {
  const [state, setState] = useState<UpdateState | null>(null);
  const seenFinish = useRef<number | null>(null);
  const updatedRef = useRef(onUpdated);
  updatedRef.current = onUpdated;

  // Poll while an update runs (also picks up one started before the tab was opened).
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const s = (await (
          await fetch('/api/signal-backtest/explorer/update')
        ).json()) as UpdateState;
        if (stop) return;
        if (seenFinish.current == null) seenFinish.current = s.finishedAt ?? 0;
        setState(s);
        if (s.phase === 'done' && s.finishedAt && s.finishedAt !== seenFinish.current) {
          seenFinish.current = s.finishedAt;
          updatedRef.current();
        }
        if (s.running) timer = setTimeout(poll, 2000);
      } catch {
        /* the button still works; the next click polls again */
      }
    };
    void poll();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [state?.running]);

  const start = async () => {
    const res = await fetch('/api/signal-backtest/explorer/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ underlying }),
    });
    setState((await res.json()) as UpdateState);
  };

  const running = !!state?.running;
  const showMessage =
    state &&
    (running ||
      (state.underlying === underlying && (state.phase === 'done' || state.phase === 'error')));
  return (
    <span className="te-update">
      <button
        type="button"
        disabled={running}
        onClick={() => void start()}
        title="Download new days, re-run the backtest with the saved settings and refresh everything in this tab"
      >
        {running ? 'Updating…' : 'Update data'}
      </button>
      {showMessage && (
        <span className={`te-update-msg ${state.phase === 'error' ? 'is-error' : ''}`}>
          {running && state.underlying !== underlying ? `${state.underlying}: ` : ''}
          {state.message}
        </span>
      )}
    </span>
  );
}
