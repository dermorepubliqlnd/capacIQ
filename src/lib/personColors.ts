// Per-person color, used first for the WBS Gantt chart (Sandra,
// 2026-07-24: "is it possible to assign colors to users? ... why I want
// to have a visual cue if someone has too much overlapping tasks" --
// coloring Gantt bars by assignee instead of by scheduling mode makes an
// overloaded person's overlapping bars visually obvious at a glance).
// `people.color` is a nullable hex string, settable in User Management
// (Admin.tsx); until someone customizes it, `colorForPerson` falls back
// to a deterministic default drawn from this palette -- deterministic
// (hashed from the person's own id) rather than random, so the same
// person always gets the same default color across reloads/sessions
// without needing to persist anything until they actually customize it.

export const DEFAULT_PERSON_PALETTE: string[] = [
  "#3b82f6", // blue
  "#ef4444", // red
  "#22c55e", // green
  "#f59e0b", // amber
  "#a855f7", // purple
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#84cc16", // lime
  "#f97316", // orange
  "#6366f1", // indigo
];

// A task with no assignee yet gets this flat neutral gray -- deliberately
// outside the palette above so "unassigned" never gets confused for a
// real person's color.
export const UNASSIGNED_BAR_COLOR = "#9ca3af";

export function defaultColorFor(personId: string): string {
  let hash = 0;
  for (let i = 0; i < personId.length; i++) {
    hash = (hash * 31 + personId.charCodeAt(i)) >>> 0;
  }
  return DEFAULT_PERSON_PALETTE[hash % DEFAULT_PERSON_PALETTE.length];
}

export function colorForPerson(person: { id: string; color?: string | null } | null | undefined): string {
  if (!person) return UNASSIGNED_BAR_COLOR;
  return person.color || defaultColorFor(person.id);
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
export function isValidHex(value: string): boolean {
  return HEX_RE.test(value.trim());
}
