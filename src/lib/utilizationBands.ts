// Phase 2 (2026-08-20): Sandra's new 6-tier utilization band system,
// replacing the old 5-tier one (0 / 1-59 / 60-80 / 81-100 / 100+). Splits
// the old top "81-100%" tier into "High" (81-95%) and "Full" (96-100%),
// giving a person right at the edge of their day a visibly different
// signal than someone genuinely overloaded past 100%.
//
// Deliberately its own module (not folded into Utilization.tsx or
// utilizationCalc.ts) so Utilization.tsx can import it directly while
// utilizationCalc.ts (the WBS draft-preview module, out of scope this
// round) keeps its own old 5-tier tierOf untouched.

export interface UtilTier {
  key: string;
  label: string;
  bg?: string;
  fg: string;
}

export function tierOf(pct: number): UtilTier {
  if (pct <= 0) return { key: "unallocated", label: "Unallocated", fg: "var(--muted)" };
  if (pct < 60) return { key: "available", label: "Available", bg: "var(--available-bg)", fg: "var(--available-text)" };
  if (pct <= 80) return { key: "healthy", label: "Healthy", bg: "var(--success-bg)", fg: "var(--success-text)" };
  if (pct <= 95) return { key: "high", label: "High", bg: "var(--warning-bg)", fg: "var(--warning-text)" };
  // Reuses the existing .status-pill.accent tone (src/index.css) rather
  // than introducing a brand-new CSS var for a single tier.
  if (pct <= 100) return { key: "full", label: "Full", bg: "#eaf1fb", fg: "var(--accent)" };
  return { key: "overloaded", label: "Overloaded", bg: "var(--danger-bg)", fg: "var(--danger-text)" };
}

export const UTIL_LEGEND = [
  { pct: "0%", label: "Unallocated", tone: "neutral" },
  { pct: "1–59%", label: "Available", tone: "available" },
  { pct: "60–80%", label: "Healthy", tone: "success" },
  { pct: "81–95%", label: "High", tone: "warning" },
  { pct: "96–100%", label: "Full", tone: "accent" },
  { pct: "100%+", label: "Overloaded", tone: "danger" },
];
