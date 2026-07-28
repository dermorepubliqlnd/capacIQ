// Shared WBS status metadata for the Draft / Baseline Locked / Revision in
// Progress / Changed After Baseline / Closed workflow (see
// [[project_capaciq_wbs_planning]]). Extracted out of WbsPlanning.tsx
// (Phase 4, 2026-07-28) so the Projects & Tasks page's WBS Status column
// can render the exact same labels/colors instead of re-declaring them --
// one status vocabulary, two places it's shown.
export type WbsStatus = "draft" | "baseline_locked" | "revision_in_progress" | "changed_after_baseline" | "closed";

// Round 1 of the WBS UI redesign (Sandra, 2026-07-29): softened every tint
// to a subtle, low-saturation background instead of the previous flat
// gray-for-everything scheme -- and, since Baseline Locked and Changed
// After Baseline previously shared byte-identical colors (only the label
// text told them apart), each status now gets its own distinct soft tone
// reusing colors already established elsewhere in the app (accent blue,
// warning amber, the purple already used for other status pills) rather
// than inventing new hex values.
export const WBS_STATUS_META: Record<WbsStatus, { label: string; hint: string; color: string; bg: string; border: string }> = {
  draft: {
    label: "Draft",
    hint: "Plan freely -- nothing is committed yet.",
    color: "var(--text-secondary)",
    bg: "var(--surface)",
    border: "var(--border)",
  },
  baseline_locked: {
    label: "Baseline Locked",
    hint: "This is the official commitment. Start a Revision to change it.",
    color: "var(--accent)",
    bg: "#eaf1fb",
    border: "#cfe0f5",
  },
  revision_in_progress: {
    label: "Revision in Progress",
    hint: "Editing is unlocked for this revision only.",
    color: "var(--warning-text, #b45309)",
    bg: "var(--warning-bg, #fff7ed)",
    border: "#f3dfb8",
  },
  changed_after_baseline: {
    label: "Changed After Baseline",
    hint: "A revision has been applied -- this differs from the original Baseline.",
    color: "#7b4fb0",
    bg: "#f3ecfa",
    border: "#e2d3f0",
  },
  closed: {
    label: "Closed",
    hint: "Final Scope is locked. This project cannot be reopened.",
    color: "var(--muted)",
    bg: "var(--hover-bg, #f3f4f6)",
    border: "var(--border)",
  },
};
