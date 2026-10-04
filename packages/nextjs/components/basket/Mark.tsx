/** Target bar above, actual bar below, the same three tokens, slightly out of line: the product in one glyph. */
export const Mark = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
    <rect x="2" y="7" width="13" height="6" rx="1.5" fill="var(--seg-0)" />
    <rect x="16" y="7" width="8" height="6" rx="1.5" fill="var(--seg-1)" />
    <rect x="25" y="7" width="5" height="6" rx="1.5" fill="var(--seg-2)" />
    <rect x="2" y="19" width="10" height="6" rx="1.5" fill="var(--seg-0)" />
    <rect x="13" y="19" width="11" height="6" rx="1.5" fill="var(--seg-1)" />
    <rect x="25" y="19" width="5" height="6" rx="1.5" fill="var(--seg-2)" />
  </svg>
);
