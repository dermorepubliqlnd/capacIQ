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
// "Very Heavy" (added Phase 12, 2026-08-20): Effort is no longer
// independently set by users -- it's now fully computed from
// tasks.estimated_hours via effort_level_thresholds (see
// supabase/phase12_migration.sql's derive_effort_level()), which added
// this 4th tier for tasks estimated over 24 hours.
export const TASK_EFFORT_OPTIONS = ["Light", "Moderate", "Heavy", "Very Heavy"];

// NOTE (2026-08-31): the old TASK_EFFORT_POINTS map (Light 0.5 / Moderate 1
// / Heavy 2) lived here and is now DELETED along with the rest of the
// retired points-based utilization model (utilizationCalc.ts). It had no
// "Very Heavy" key -- deliberately, since that level arrived after the
// points model was already being retired -- but two live callers on the
// Projects page were still reading it as a task WEIGHT
// (`TASK_EFFORT_POINTS[t.effort] ?? 0`), so every Very Heavy task silently
// scored 0: it was skipped by actualProgress (a project of large tasks
// reported "Health unavailable") and sorted as blank under the Effort sort.
// Effort is derived from estimated_hours (see effort_level_thresholds), so
// both now use hours / the TASK_EFFORT_OPTIONS band order directly.

// Fallback tones if task_effort_colors hasn't loaded yet (or a level is
// missing a row) — matches the seeded defaults in the DB. Sandra can
// recolor each level herself from the Tasks toolbar (Full Access only);
// the DB values always win once loaded.
export const TASK_EFFORT_DEFAULT_TONES: Record<string, string> = {
  Light: "success",
  Moderate: "warning",
  Heavy: "danger",
  "Very Heavy": "danger",
};

export const PROJECT_PRIORITY_OPTIONS = ["Low", "Medium", "High"];

// Small directional symbols shown before the Priority text everywhere it's
// displayed (table pill, Board column header, Timeline/Calendar chip, bulk
// edit picker) -- Sandra: prefix Low/Medium/High with down/flat/up marks
// so priority reads at a glance without needing to parse the word itself.
export const PROJECT_PRIORITY_SYMBOLS: Record<string, string> = {
  Low: "↓", // ↓ green (see priorityTone in Projects.tsx)
  Medium: "→", // → amber
  High: "↑", // ↑ red
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
// SUPERSEDED 2026-09-03: Phase is now an admin-configurable list
// (project_phases table) and Status->Phase mapping is now Sandra-
// editable (project_status_phase_mapping table, Site Settings), not
// these hardcoded arrays -- see ProjectPhaseOption's comment in
// Projects.tsx. Kept here only as the migration's one-time seed data
// reference / historical record; nothing imports these anymore.
// 2026-09-03 (Sandra: "for not started allow selection of the phase only
// matching with not started") -- narrowed from ["Backlog", "Queued"] to
// just Queued, so a Not Started project's Phase dropdown offers a single
// option instead of two. "Backlog" stays a valid value in PROJECT_PHASE_
// ALL below (Paused/Cancelled keep the full phase list since their Phase
// is frozen wherever it was, and an older project may still have Backlog
// saved) -- it's just no longer offered for new Not Started selections.
export const PROJECT_PHASE_NOT_STARTED = ["Queued"];
export const PROJECT_PHASE_IN_PROGRESS = ["Scoping", "Design", "Development", "Evaluation", "Delivery"];
export const PROJECT_PHASE_COMPLETED = ["Done"];
export const PROJECT_PHASE_ALL = ["Backlog", ...PROJECT_PHASE_NOT_STARTED, ...PROJECT_PHASE_IN_PROGRESS, ...PROJECT_PHASE_COMPLETED];

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
  "Level 2": "warning",
  "Level 3": "danger",
};

// Mountain-tier glyphs shown before the Complexity text, mirroring
// PROJECT_PRIORITY_SYMBOLS' pattern -- Sandra: a rising-triangle "mountain"
// motif (flat/small -> tall/sharp) colored green/amber/red per level.
export const PROJECT_EFFORT_LEVEL_SYMBOLS: Record<string, string> = {
  "Level 1": "△", // △ green
  "Level 2": "◭", // ◭ amber
  "Level 3": "▲", // ▲ red
};

export function effortLevelLabel(level: string | null): string {
  if (!level) return "";
  const symbol = PROJECT_EFFORT_LEVEL_SYMBOLS[level];
  return symbol ? `${symbol} ${level}` : level;
}

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
