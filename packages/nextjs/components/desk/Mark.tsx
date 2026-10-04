/** Three bids stacked best to worst, and the floor the fallback holds beneath them. */
export const Mark = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
    <rect x="3" y="4" width="26" height="5.5" rx="1.5" fill="var(--color-primary)" />
    <rect x="3" y="12" width="20" height="5.5" rx="1.5" fill="currentColor" opacity="0.5" />
    <rect x="3" y="20" width="14" height="5.5" rx="1.5" fill="currentColor" opacity="0.28" />
    <rect x="2" y="28" width="28" height="2" rx="1" fill="currentColor" />
  </svg>
);
