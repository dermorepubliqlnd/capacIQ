// Sandra's 6-tier utilization band system (Phase 2, 2026-08-20), replacing
// the old 5-tier one (0 / 1-59 / 60-80 / 81-100 / 100+). Splits the old top
// "81-100%" tier into "High" (81-95%) and "Full" (96-100%), giving a person
// right at the edge of their day a visibly different signal than someone
// genuinely overloaded past 100%.
//
// 2026-08-31: this is now the ONLY tier scale in the app. WbsPlanning.tsx's
// Utilization snapshot was still importing a superseded 5-tier `tierOf` from
// utilizationCalc.ts, so a 98% day read "Full" (blue) on the Utilization page
// and "Near full capacity" (yellow) on the WBS snapshot. That module is gone.

export interface UtilTier {
  key: string;
  label: string;
  bg?: string;
  fg: string;
}

/** The integer percentage a cell should PRINT.
 *
 * Bugfix (2026-08-31): the bands used to branch on the raw float while the
 * cell printed `Math.round(pct)`, so 100.4% rendered as a red "Overloaded"
 * cell labelled "100%", and 59.5% rendered "60%" in the Available colour --
 * the number and the colour disagreed at every boundary. Both now derive
 * from this one rounded value. A genuinely non-zero allocation never rounds
 * down to "0%" (which would read as Unallocated); it floors at 1%. */
export function displayPct(pct: number): number {
  if (pct <= 0) return 0;
  return Math.max(1, Math.round(pct));
}

export function tierOf(pct: number): UtilTier {
  const shown = displayPct(pct);
  if (shown <= 0) return { key: "unallocated", label: "Unallocated", fg: "var(--muted)" };
  if (shown < 60) return { key: "available", label: "Available", bg: "var(--available-bg)", fg: "var(--available-text)" };
  if (shown <= 80) return { key: "healthy", label: "Healthy", bg: "var(--success-bg)", fg: "var(--success-text)" };
  if (shown <= 95) return { key: "high", label: "High", bg: "var(--warning-bg)", fg: "var(--warning-text)" };
  // Reuses the existing .status-pill.accent tone (src/index.css) rather
  // than introducing a brand-new CSS var for a single tier.
  if (shown <= 100) return { key: "full", label: "Full", bg: "#eaf1fb", fg: "var(--accent)" };
  return { key: "overloaded", label: "Overloaded", bg: "var(--danger-bg)", fg: "var(--danger-text)" };
}

// Legend labels are written to match the branches above EXACTLY (the old
// "100%+" read as if 100 itself were overloaded -- 100 is Full; only 101+
// is Overloaded).
export const UTIL_LEGEND = [
  { pct: "0%", label: "Unallocated", tone: "neutral" },
  { pct: "1–59%", label: "Available", tone: "available" },
  { pct: "60–80%", label: "Healthy", tone: "success" },
  { pct: "81–95%", label: "High", tone: "warning" },
  { pct: "96–100%", label: "Full", tone: "accent" },
  { pct: "101%+", label: "Overloaded", tone: "danger" },
];
