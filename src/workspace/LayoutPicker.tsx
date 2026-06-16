import type { LayoutType } from '../types';

interface LayoutPickerProps {
  current:  LayoutType;
  onChange: (layout: LayoutType) => void;
}

const LAYOUTS: { id: LayoutType; icon: string; label: string }[] = [
  { id: 'single', icon: '▣',  label: 'Single' },
  { id: 'hsplit', icon: '⬛⬛', label: 'H-Split' },
  { id: 'vsplit', icon: '🔲', label: 'V-Split' },
  { id: 'grid',   icon: '⊞',  label: '2×2 Grid' },
  { id: 'tleft',  icon: '⬛|□', label: 'T-Left' },
  { id: 'tright', icon: '□|⬛', label: 'T-Right' },
];

export default function LayoutPicker({ current, onChange }: LayoutPickerProps) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] text-[var(--text-muted)] mr-1">Layout:</span>
      {LAYOUTS.map(({ id, icon, label }) => (
        <button
          key={id}
          title={label}
          onClick={() => onChange(id)}
          className={`px-1.5 py-0.5 rounded text-[12px] transition-all ${
            current === id
              ? 'bg-[var(--accent)] text-white'
              : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]'
          }`}
        >
          {icon}
        </button>
      ))}
    </div>
  );
}
