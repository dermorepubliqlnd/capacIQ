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
    // 2026-08-27 (Sandra: rename Lock Baseline -> Start Project, remove
    // Re-baseline): re-baselining (Phase 24, 2026-08-26) is removed again
    // -- there is no more UI path to re-trigger request_baseline_approval/
    // decide_baseline_request once a project has left Draft. Editing
    // continues to be open; it just no longer resets the Baseline.
    hint: "This is the official commitment. You can keep editing -- close the project once work is complete.",
    color: "var(--accent)",
    bg: "#eaf1fb",
    border: "#cfe0f5",
  },
  // Legacy status, no longer set by any Phase 6 action -- kept only so
  // any project that happened to be mid-revision before Phase 6 shipped
  // still renders sensibly (none were, as of 2026-08-21, but the value
  // stays valid in the DB check constraint for old history/back-compat).
  revision_in_progress: {
    label: "Revision in Progress",
    hint: "Editing is unlocked for this revision only.",
    color: "var(--warning-text, #b45309)",
    bg: "var(--warning-bg, #fff7ed)",
    border: "#f3dfb8",
  },
  changed_after_baseline: {
    label: "Changed After Baseline",
    hint: "Edited since the Baseline was locked. Baselines are locked once by design -- variance tracking measures against the original baseline.",
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

// 2026-09-03 (Sandra: "can WBS Status also update to Awaiting Baseline
// Approval if it's queued for approval") -- display-only overlay, not a
// new wbs_status enum value: a project stays literally "draft" in the DB
// the whole time a Start Project request is pending (decide_baseline_
// request is what actually flips it), so every RPC/RLS policy/guardrail
// keyed off the literal "draft" string keeps working unchanged. This is
// the one place that swaps in a friendlier label + its own tone (reusing
// the warning/amber hue, same as Revision in Progress) wherever the
// badge is shown, whenever a project both IS draft and has a pending
// request -- callers pass that one boolean in, they don't need to know
// anything about baseline requests themselves.
export function wbsStatusMetaFor(status: WbsStatus, hasPendingBaselineRequest: boolean) {
  if (status === "draft" && hasPendingBaselineRequest) {
    return {
      label: "Awaiting Baseline Approval",
      hint: "Start Project has been requested -- waiting on an approver to lock this in as the Baseline.",
      color: "var(--warning-text, #b45309)",
      bg: "var(--warning-bg, #fff7ed)",
      border: "#f3dfb8",
    };
  }
  return WBS_STATUS_META[status];
}
