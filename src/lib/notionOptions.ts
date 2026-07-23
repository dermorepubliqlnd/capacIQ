// Option lists mirrored from the Notion "L&D Project Tracker" (Projects and
// Tasks databases) so CapacIQ's dropdowns match the taxonomy the team
// already uses. Alphabetized within each group per request, except Priority
// which is kept in severity order (Low/Medium/High) since alphabetizing a
// severity scale would be actively confusing (High would sort before Low).

export interface OptionGroup {
  label: string;
  options: string[];
}

export const PROJECT_CATEGORY_OPTIONS = [
  "Compliance & Safety",
  "L&D Improvments",
  "Leadership",
  "Onboarding",
  "Operational Support",
  "Professional Development",
  "Technical & Systems",
];

export const PROJECT_EFFORT_LEVEL_OPTIONS = ["Level 1", "Level 2", "Level 3"];

// Task Effort: a lightweight, fun sizing scale used to auto-compute weekly
// capacity (see Capacity page) without relying on estimated/actual hours.
// Each level carries a fixed point value; a person's week-of-work is summed
// in points and compared against their point capacity.
export const TASK_EFFORT_OPTIONS = ["Light", "Moderate", "Heavy"];

export const TASK_EFFORT_POINTS: Record<string, number> = {
  Light: 0.5,
  Moderate: 1,
  Heavy: 2,
};

// Fallback tones if task_effort_colors hasn't loaded yet (or a level is
// missing a row) — matches the seeded defaults in the DB. Sandra can
// recolor each level herself from the Tasks toolbar (Full Access only);
// the DB values always win once loaded.
export const TASK_EFFORT_DEFAULT_TONES: Record<string, string> = {
  Light: "success",
  Moderate: "warning",
  Heavy: "danger",
};

export const PROJECT_PRIORITY_OPTIONS = ["Low", "Medium", "High"];

// Small directional symbols shown before the Priority text everywhere it's
// displayed (table pill, Board column header, Timeline/Calendar chip, bulk
// edit picker) -- Sandra: prefix Low/Medium/High with down/flat/up marks
// so priority reads at a glance without needing to parse the word itself.
export const PROJECT_PRIORITY_SYMBOLS: Record<string, string> = {
  Low: "↓", // ↓
  Medium: "—", // —
  High: "↑", // ↑
};

export function priorityLabel(priority: string | null): string {
  if (!priority) return "";
  const symbol = PROJECT_PRIORITY_SYMBOLS[priority];
  return symbol ? `${symbol} ${priority}` : priority;
}

// Redesigned 2026-07-23: Project Status used to be one 11-value field
// conflating lifecycle ("is this moving") with pipeline stage ("where is
// it in production"), which is why Paused sat awkwardly next to Design in
// the same dropdown. Now split into two properties -- PROJECT_STATUS_
// OPTIONS (below, a small fixed lifecycle set) and PROJECT_PHASE_* (the
// pipeline stage, cascading off Status -- see PROJECT_PHASE_OPTIONS_BY_
// STATUS). Paused and Cancelled deliberately have NO phase of their own:
// Phase just freezes at whatever it already was when a project stops, so
// you can see both that it stopped and where it stopped. "Merged" was
// retired entirely per Sandra (no replacement value; existing Merged rows
// were migrated to Completed/Done, see supabase/policies.sql).
export const PROJECT_STATUS_OPTIONS = ["Not Started", "In Progress", "Completed", "Paused", "Cancelled"];

// Task "Status" is unrelated to the above -- still the original simple
// 3-value grouped property (see TASK_STATUS_GROUPED below), untouched by
// this redesign.

// Simplified to exactly 3 task statuses per request (Notion's Task DB had
// Archived/Cancelled as separate "Complete" values, but with the app's own
// archive/restore system now covering that, a task's own status only needs
// to track its actual progress).
export const TASK_STATUS_GROUPED: OptionGroup[] = [
  { label: "To-do", options: ["Not Started"] },
  { label: "In Progress", options: ["In Progress"] },
  { label: "Complete", options: ["Done"] },
];

function flatten(groups: OptionGroup[]): string[] {
  return groups.flatMap((g) => g.options);
}

export const TASK_STATUS_OPTIONS = flatten(TASK_STATUS_GROUPED);

// Pipeline phases, keyed by which Status they're available under. Not
// Started and Completed are effectively fixed single choices (Completed
// is always exactly "Done") -- Not Started still gets a real 2-way choice
// since Sandra wanted Backlog (not yet scheduled) kept distinct from
// Queued (next up), rather than collapsed into one default value. Paused
// and Cancelled get the FULL combined list, since their phase is whatever
// real pipeline stage the project had already reached before it stopped
// -- not a fixed value, and not restricted to just the "in progress"
// subset (a project can be cancelled before it ever left Backlog/Queued,
// or even after reaching Done in rare cases).
export const PROJECT_PHASE_NOT_STARTED = ["Backlog", "Queued"];
export const PROJECT_PHASE_IN_PROGRESS = ["Scoping", "Design", "Development", "Evaluation", "Delivery"];
export const PROJECT_PHASE_COMPLETED = ["Done"];
export const PROJECT_PHASE_ALL = [...PROJECT_PHASE_NOT_STARTED, ...PROJECT_PHASE_IN_PROGRESS, ...PROJECT_PHASE_COMPLETED];

export const PROJECT_PHASE_OPTIONS_BY_STATUS: Record<string, string[]> = {
  "Not Started": PROJECT_PHASE_NOT_STARTED,
  "In Progress": PROJECT_PHASE_IN_PROGRESS,
  Completed: PROJECT_PHASE_COMPLETED,
  Paused: PROJECT_PHASE_ALL,
  Cancelled: PROJECT_PHASE_ALL,
};

// When Status changes, Phase cascades: Completed always forces "Done";
// Not Started/In Progress snap Phase to a sensible default UNLESS it's
// already a valid value for the new Status (so toggling back and forth,
// e.g. In Progress -> Paused -> In Progress, doesn't lose the specific
// phase); Paused/Cancelled never touch Phase at all -- it freezes exactly
// where it was, which is the whole point of the design.
export function nextPhaseForStatus(currentPhase: string | null, newStatus: string): string | null {
  if (newStatus === "Completed") return "Done";
  if (newStatus === "Not Started") return PROJECT_PHASE_NOT_STARTED.includes(currentPhase ?? "") ? currentPhase : "Queued";
  if (newStatus === "In Progress") return PROJECT_PHASE_IN_PROGRESS.includes(currentPhase ?? "") ? currentPhase : "Scoping";
  return currentPhase; // Paused / Cancelled: frozen, unchanged
}

// Status tones: a plain lifecycle progression, neutral -> accent ->
// success, with the two "stopped" states (Paused/Cancelled) keeping their
// pre-existing colors from the old combined field (purple/danger) so
// they still read as clearly distinct from the "moving forward" states.
export const PROJECT_STATUS_TONES: Record<string, string> = {
  "Not Started": "neutral",
  "In Progress": "accent",
  Completed: "success",
  Paused: "purple",
  Cancelled: "danger",
};

// Phase tones: unchanged from the old per-exact-value Status colors for
// every value that carries over (Backlog/Queued/Scoping/Design/
// Development/Evaluation/Delivery/Done) -- same rationale as before,
// matches the team's existing Notion color coding. "warning" (orange) is
// shared by Scoping/Evaluation and "pink" only by Design, since the
// app's tone palette doesn't have as many distinct hues as Notion's full
// color picker -- flag to Sandra if tighter differentiation is wanted.
export const PROJECT_PHASE_TONES: Record<string, string> = {
  Backlog: "neutral",
  Queued: "neutral",
  Scoping: "warning",
  Design: "pink",
  Development: "gold",
  Delivery: "accent",
  Evaluation: "warning",
  Done: "success",
};

export function statusGroupOf(groups: OptionGroup[], value: string | null): "to_do" | "in_progress" | "complete" | null {
  if (!value) return null;
  const idx = groups.findIndex((g) => g.options.includes(value));
  if (idx === 0) return "to_do";
  if (idx === 1) return "in_progress";
  if (idx === 2) return "complete";
  return null;
}

export const TASK_PHASE_OPTIONS = ["Delivery", "Design", "Development"];

// Tone mapping for color-coded pills, loosely matching each option's color
// in the source Notion databases (translated to this app's pill palette).
export const PROJECT_CATEGORY_TONES: Record<string, string> = {
  "Onboarding": "warning",
  "Compliance & Safety": "warning",
  "Technical & Systems": "success",
  "Leadership": "purple",
  "Professional Development": "pink",
  "Operational Support": "danger",
  "L&D Improvments": "neutral",
};

export const PROJECT_EFFORT_LEVEL_TONES: Record<string, string> = {
  "Level 1": "success",
  "Level 2": "accent",
  "Level 3": "warning",
};

export const TASK_PHASE_TONES: Record<string, string> = {
  Design: "warning",
  Development: "accent",
  Delivery: "success",
};

// Flat-color emoji badges per Category, auto-assigned to each project (no
// manual icon picking needed) — reuses the same tone colors as the pills.
export const PROJECT_CATEGORY_ICONS: Record<string, { emoji: string; tone: string }> = {
  "Onboarding": { emoji: "\ud83d\udc4b", tone: "warning" },
  "Compliance & Safety": { emoji: "\ud83d\udee1\ufe0f", tone: "warning" },
  "Technical & Systems": { emoji: "\ud83d\udcbb", tone: "success" },
  "Leadership": { emoji: "\ud83d\udc51", tone: "purple" },
  "Professional Development": { emoji: "\ud83d\udcc8", tone: "pink" },
  "Operational Support": { emoji: "\ud83d\udee0\ufe0f", tone: "danger" },
  "L&D Improvments": { emoji: "\u2728", tone: "neutral" },
};

export const DEFAULT_PROJECT_ICON = { emoji: "\ud83d\udcc1", tone: "neutral" };
