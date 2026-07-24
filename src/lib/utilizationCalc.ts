// Shared utilization math (Sandra, 2026-07-24): a fresh module, NOT a
// refactor of the already-shipped, live-verified Utilization.tsx (its own
// local copies of this same logic are deliberately left untouched, same
// "don't touch working code in the same pass" convention already used for
// workingDays.ts/taskScheduling.ts elsewhere in this app). This exists so
// the WBS planning page can show the same points/tier-based utilization
// picture Utilization.tsx shows, instead of the raw Day-Planner-hours grid
// it originally had -- and, critically, so WBS can feed it DRAFT
// (not-yet-saved) task data for a live "what happens if I assign this"
// preview, which Utilization.tsx itself has no reason to need.
//
// If a future session wants Utilization.tsx itself to import from here
// instead of keeping its own copies, that's a deliberate, separate
// refactor -- not a side effect of this one.

import { TASK_EFFORT_POINTS, TASK_STATUS_GROUPED, statusGroupOf } from "./notionOptions";
import { addDays, parseLocalDate, toISO } from "./workingDays";

export interface UtilTaskRow {
  id: string;
  project_id: string;
  assignee_id: string | null;
  status: string | null;
  start_date: string | null;
  current_due_date: string;
  effort: string | null;
}
export interface UtilProjectRow {
  id: string;
  owner_id: string | null;
  start_date: string | null;
  end_date: string | null;
}
export interface UtilPersonRow {
  id: string;
  daily_capacity_hours: number;
}

// A "standard" workday, used only to normalize daily point-capacity -- a
// person whose own daily capacity equals this has a capacity of exactly 1
// point/day (one Heavy/2-pt task every other day). Matches Utilization.tsx.
export const STANDARD_DAILY_HOURS = 7.5;

// Project-ownership "PM overhead," expressed in points -- mirrors
// Utilization.tsx's own constants exactly (0.5h/day, capped 2h/day).
export const PROJECT_PM_POINTS_PER_DAY = 0.1;
export const PROJECT_PM_POINTS_CAP_PER_DAY = 0.3;

/** Every open task's effort points are spread evenly across its own
 * Mon-Fri working days between start and due date (fallback: the due date
 * itself, if that window is entirely a weekend). */
export function taskWorkingDays(t: UtilTaskRow): string[] {
  const windowStart = parseLocalDate(t.start_date ?? t.current_due_date);
  const windowEnd = parseLocalDate(t.current_due_date);
  if (windowEnd < windowStart) return [t.current_due_date];
  const days: string[] = [];
  for (let d = new Date(windowStart); d <= windowEnd; d = addDays(d, 1)) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) days.push(toISO(d));
  }
  return days.length ? days : [t.current_due_date];
}

/** A project's own working-day window, for PM-overhead points -- unlike
 * tasks there's no due-date fallback: a project with no start/end date
 * set simply doesn't contribute PM points yet. */
export function projectWorkingDays(p: UtilProjectRow): string[] {
  if (!p.start_date || !p.end_date) return [];
  const windowStart = parseLocalDate(p.start_date);
  const windowEnd = parseLocalDate(p.end_date);
  if (windowEnd < windowStart) return [];
  const days: string[] = [];
  for (let d = new Date(windowStart); d <= windowEnd; d = addDays(d, 1)) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) days.push(toISO(d));
  }
  return days;
}

function isOpenTask(t: UtilTaskRow): boolean {
  return statusGroupOf(TASK_STATUS_GROUPED, t.status) !== "complete";
}

/** A task's points on a specific date -- 0 if that date isn't one of its
 * own working days (out of window, or effort not set yet). */
export function taskPointsOnDate(t: UtilTaskRow, dateStr: string): number {
  const points = t.effort ? TASK_EFFORT_POINTS[t.effort] ?? 0 : 0;
  if (points === 0) return 0;
  const workingDays = taskWorkingDays(t);
  if (!workingDays.includes(dateStr)) return 0;
  return points / workingDays.length;
}

/** PM-overhead points for everything a person owns on a given date, with
 * the combined cap applied proportionally across projects. */
export function pmPointsFor(personId: string, dateStr: string, projects: UtilProjectRow[]): { total: number; perProject: Map<string, number> } {
  const owned = projects.filter((p) => p.owner_id === personId && projectWorkingDays(p).includes(dateStr));
  const rawTotal = owned.length * PROJECT_PM_POINTS_PER_DAY;
  const scale = rawTotal > PROJECT_PM_POINTS_CAP_PER_DAY && rawTotal > 0 ? PROJECT_PM_POINTS_CAP_PER_DAY / rawTotal : 1;
  const perProject = new Map(owned.map((p) => [p.id, PROJECT_PM_POINTS_PER_DAY * scale]));
  return { total: Math.min(rawTotal, PROJECT_PM_POINTS_CAP_PER_DAY), perProject };
}

/** Total points a person is carrying on a given date, across every open
 * task assigned to them (in the supplied `tasks` list -- callers control
 * what's "real" vs "draft" by what they pass in here) plus PM overhead. */
export function dailyPointsFor(personId: string, dateStr: string, tasks: UtilTaskRow[], projects: UtilProjectRow[]): number {
  const taskPoints = tasks
    .filter((t) => t.assignee_id === personId && isOpenTask(t))
    .reduce((sum, t) => sum + taskPointsOnDate(t, dateStr), 0);
  return taskPoints + pmPointsFor(personId, dateStr, projects).total;
}

export function dailyCapacityFor(person: UtilPersonRow, halfDay: boolean): number {
  return (person.daily_capacity_hours / STANDARD_DAILY_HOURS) * (halfDay ? 0.5 : 1);
}

// The 5 tiers Sandra specified, verbatim thresholds: 0 = grey, 1-59% =
// light green, 60-80% = green, 81-100% = yellow, >100% = red. Matches
// Utilization.tsx's own tierOf exactly (colors only -- no icon component
// dependency here, callers pick their own icon/rendering).
export function tierOf(pct: number): { key: string; label: string; bg?: string; fg: string } {
  if (pct <= 0) return { key: "none", label: "No project", fg: "var(--muted)" };
  if (pct < 60) return { key: "available", label: "Available", bg: "var(--available-bg)", fg: "var(--available-text)" };
  if (pct <= 80) return { key: "healthy", label: "Healthy", bg: "var(--success-bg)", fg: "var(--success-text)" };
  if (pct <= 100) return { key: "near_full", label: "Near full capacity", bg: "var(--warning-bg)", fg: "var(--warning-text)" };
  return { key: "overloaded", label: "Overloaded", bg: "var(--danger-bg)", fg: "var(--danger-text)" };
}
