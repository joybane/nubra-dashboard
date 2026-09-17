export type IconName = 'trade' | 'strategy' | 'research' | 'monitor' | 'search' | 'layout' | 'sun' | 'moon' | 'logout' | 'command' | 'density' | 'expand' | 'restore' | 'reset' | 'close';
const paths: Record<IconName, string> = {
  trade: 'M5 3v18M2 8h6v8H2zM12 3v18M9 5h6v7H9zM19 3v18M16 11h6v6h-6z',
  strategy: 'M4 17l5-5 4 3 7-9M15 6h5v5M3 21h18',
  research: 'M4 4h16v16H4zM8 15v-4M12 15V7M16 15v-6',
  monitor: 'M3 5h18v13H3zM8 22h8M12 18v4M6 12h3l2-4 3 7 2-3h2',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  layout: 'M3 3h18v18H3zM11 3v18M11 12h10',
  sun: 'M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  moon: 'M21 13A9 9 0 0 1 11 3a9 9 0 1 0 10 10',
  logout: 'M10 4H4v16h6M9 12h12M17 8l4 4-4 4',
  command: 'M9 7V5a2 2 0 1 0-2 2h10a2 2 0 1 0-2-2v14a2 2 0 1 0 2-2H7a2 2 0 1 0 2 2V7',
  density: 'M4 5h16M4 12h16M4 19h16',
  expand: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5',
  restore: 'M3 9h6V3M15 3v6h6M3 15h6v6M15 21v-6h6',
  reset: 'M3 10a9 9 0 1 1 1 8M3 4v6h6',
  close: 'M6 6l12 12M18 6L6 18',
};
export default function UiIcon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
