import { useCallback, useEffect, useState } from 'react';
import { fmtPrice } from '../lib/utils';

interface SnapshotMeta {
  snapshot_id: string;
  basket_group_id: string;
  strategy_name: string | null;
  underlying: string | null;
  trade_date: string;
  total_pnl: number;   // paise
  leg_count: number;
  source: string;
  created_at: number;
  updated_at: number;
}

interface Props {
  onOpen: (basketGroupId: string, strategyName: string, snapshotId: string) => void;
}

export default function SavedStrategiesTab({ onOpen }: Props) {
  const [snaps, setSnaps] = useState<SnapshotMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/paper/strategy/snapshots');
      if (res.ok) {
        const d = await res.json() as { snapshots?: SnapshotMeta[] };
        setSnaps(d.snapshots || []);
      }
    } catch (e) {
      console.warn('[SavedStrategies] load failed:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const del = useCallback(async (id: string) => {
    try { await fetch(`/paper/strategy/snapshot/${id}`, { method: 'DELETE' }); }
    catch (e) { console.warn('[SavedStrategies] delete failed:', e); }
    setConfirmId(null);
    load();
  }, [load]);

  if (loading) {
    return <div className="flex h-full items-center justify-center text-[12px] text-[var(--text-muted)]">Loading…</div>;
  }
  if (snaps.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-[var(--text-muted)]">
        No saved strategies yet. Open a strategy chart and click <span className="mx-1 font-semibold text-[var(--text-primary)]">Save</span>,
        or they'll be captured automatically after market close.
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-[12px]">
        <thead className="sticky top-0 bg-[var(--bg-secondary)] text-[var(--text-muted)] text-[11px]">
          <tr className="border-b border-[var(--border)]">
            <th className="text-left font-medium px-3 py-1.5">Date</th>
            <th className="text-left font-medium px-3 py-1.5">Strategy</th>
            <th className="text-left font-medium px-3 py-1.5">Underlying</th>
            <th className="text-right font-medium px-3 py-1.5">Legs</th>
            <th className="text-right font-medium px-3 py-1.5">P&amp;L</th>
            <th className="text-left font-medium px-3 py-1.5">Saved</th>
            <th className="text-right font-medium px-3 py-1.5">Actions</th>
          </tr>
        </thead>
        <tbody>
          {snaps.map(s => {
            const pnl = s.total_pnl / 100;
            return (
              <tr key={s.snapshot_id} className="border-b border-[var(--border)] hover:bg-[var(--bg-hover)]">
                <td className="px-3 py-1.5 whitespace-nowrap">{s.trade_date}</td>
                <td className="px-3 py-1.5 font-medium text-[var(--text-primary)]">{s.strategy_name || s.basket_group_id}</td>
                <td className="px-3 py-1.5 text-[var(--text-muted)]">{s.underlying || '—'}</td>
                <td className="px-3 py-1.5 text-right text-[var(--text-muted)]">{s.leg_count}</td>
                <td className={`px-3 py-1.5 text-right font-semibold ${pnl >= 0 ? 'text-[var(--green)]' : 'text-[var(--red)]'}`}>
                  {pnl >= 0 ? '+' : '-'}₹{fmtPrice(Math.abs(pnl))}
                </td>
                <td className="px-3 py-1.5 text-[10px] uppercase text-[var(--text-muted)]">{s.source}</td>
                <td className="px-3 py-1.5">
                  <div className="flex items-center justify-end gap-1.5">
                    <button
                      onClick={() => onOpen(s.basket_group_id, s.strategy_name || s.basket_group_id, s.snapshot_id)}
                      className="px-2 py-0.5 rounded text-[11px] font-semibold border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--accent)] transition-colors">
                      Open
                    </button>
                    {confirmId === s.snapshot_id ? (
                      <>
                        <button onClick={() => del(s.snapshot_id)}
                          className="px-2 py-0.5 rounded text-[11px] font-semibold bg-[var(--red)]/15 text-[var(--red)] border border-[var(--red)]/40">
                          Confirm
                        </button>
                        <button onClick={() => setConfirmId(null)}
                          className="px-2 py-0.5 rounded text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button onClick={() => setConfirmId(s.snapshot_id)}
                        title="Delete snapshot"
                        className="px-2 py-0.5 rounded text-[11px] font-semibold border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--red)] hover:border-[var(--red)]/40 transition-colors">
                        Delete
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
