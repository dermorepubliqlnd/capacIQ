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

export const PROJECT_PRIORITY_OPTIONS = ["Low", "Medium", "High"];

// Notion's "Project Status" and task "Status" are grouped status properties
// (To-do / In Progress / Complete), shown in Notion's status picker as three
// labeled sections. Mirrored the same way here, options alphabetized within
// each group.
export const PROJECT_STATUS_GROUPED: OptionGroup[] = [
  { label: "To-do", options: ["Backlog", "Queued"] },
  { label: "In Progress", options: ["Delivery", "Design", "Development", "Evaluation", "Paused", "Planning"] },
  { label: "Complete", options: ["Canceled", "Done", "Merged"] },
];

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

export const PROJECT_STATUS_OPTIONS = flatten(PROJECT_STATUS_GROUPED);
export const TASK_STATUS_OPTIONS = flatten(TASK_STATUS_GROUPED);

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
