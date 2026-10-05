/** Three bids stacked best to worst on a hard floor. Square ends: nothing on this desk is rounded but a button. */
export const Mark = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 32 32" aria-hidden="true" shapeRendering="crispEdges">
    <rect x="2" y="4" width="28" height="5" fill="currentColor" />
    <rect x="2" y="12" width="20" height="5" fill="currentColor" opacity="0.6" />
    <rect x="2" y="20" width="12" height="5" fill="currentColor" opacity="0.3" />
    <rect x="2" y="28" width="28" height="2" fill="#0056b3" />
  </svg>
);
