// Tempo brand mark (2026-08-25 rebrand from CapacIQ) -- a bold geometric
// "T" whose top/right sweeps into a forward-pointing arrowhead (motion,
// progress, execution), rendered as inline SVG so it stays crisp at any
// size and can sit on both light (Login) and dark (sidebar) backgrounds.
// Gradient per brand brief: #4FE3F5 -> #62F5B2.
export default function TempoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <linearGradient id="tempoMarkGrad" x1="0%" y1="100%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#4FE3F5" />
          <stop offset="100%" stopColor="#62F5B2" />
        </linearGradient>
      </defs>
      <path
        d="M15,22 h34 a3,3 0 0 1 3,3 v10 a3,3 0 0 1 -3,3 h-34 a3,3 0 0 1 -3,-3 v-10 a3,3 0 0 1 3,-3 Z"
        fill="url(#tempoMarkGrad)"
      />
      <path d="M52,18 L84,30 L52,42 Z" fill="url(#tempoMarkGrad)" />
      <path
        d="M30,38 h14 a3,3 0 0 1 3,3 v38 a3,3 0 0 1 -3,3 h-14 a3,3 0 0 1 -3,-3 v-38 a3,3 0 0 1 3,-3 Z"
        fill="url(#tempoMarkGrad)"
      />
    </svg>
  );
}
