interface BrandMarkProps {
  compact?: boolean;
  product?: string;
  className?: string;
}

export default function BrandMark({
  compact = false,
  product = 'PRO',
  className = '',
}: BrandMarkProps) {
  return (
    <span
      className={`brodha-brand ${compact ? 'is-compact' : ''} ${className}`.trim()}
      aria-label={`bRODHa ${product}`}
    >
      <svg className="brodha-brand-mark" viewBox="0 0 34 34" aria-hidden="true">
        <rect x="1" y="1" width="32" height="32" rx="8" className="brodha-mark-frame" />
        <path
          className="brodha-mark-glyph"
          d="M10 8h8.1c4.2 0 6.7 1.8 6.7 5 0 1.8-.9 3.2-2.5 4 2.1.7 3.2 2.2 3.2 4.3 0 3.3-2.7 5.7-7.3 5.7H10V8Zm7.7 7.2c1.8 0 2.8-.7 2.8-2s-1-1.9-2.8-1.9h-3.5v3.9h3.5Zm.5 8.4c2 0 3.1-.8 3.1-2.3 0-1.4-1.1-2.2-3.1-2.2h-4v4.5h4Z"
        />
        <path className="brodha-mark-signal" d="M27 7v7" />
      </svg>
      {!compact && (
        <span className="brodha-brand-copy">
          <strong>bRODHa</strong>
          <small>{product}</small>
        </span>
      )}
    </span>
  );
}
