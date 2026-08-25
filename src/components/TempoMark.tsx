// Tempo brand mark (2026-08-25 rebrand from CapacIQ; refined same day per
// Sandra's feedback on round 1) -- a bold geometric "T" whose top/right
// sweeps into a forward-pointing arrowhead (motion, progress, execution).
// Round 2 fixes: (1) visible seams between the bar/arrow/stem shapes --
// caused by each <path> mapping the gradient to its OWN bounding box
// (SVG's default objectBoundingBox units); switched to
// gradientUnits="userSpaceOnUse" with fixed coordinates so all three
// shapes sample one continuous gradient. (2) the vertical stem read
// thicker than the horizontal bar -- both now use the same 18-unit
// stroke thickness. (3) "lean forward a bit" -- a subtle skewX(-7) shear
// on the whole mark, the classic forward-motion cue.
export default function TempoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <linearGradient id="tempoMarkGrad" gradientUnits="userSpaceOnUse" x1="0" y1="100" x2="100" y2="0">
          <stop offset="0%" stopColor="#4FE3F5" />
          <stop offset="100%" stopColor="#62F5B2" />
        </linearGradient>
      </defs>
      <g transform="skewX(-7)">
        <path d="M14,20 h41 v18 h-41 Z" fill="url(#tempoMarkGrad)" />
        <path d="M54,16 L88,29 L54,42 Z" fill="url(#tempoMarkGrad)" />
        <path d="M26,37 h18 v45 h-18 Z" fill="url(#tempoMarkGrad)" />
      </g>
    </svg>
  );
}
