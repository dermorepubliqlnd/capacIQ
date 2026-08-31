// ---------------------------------------------------------------------------
// ONE shared per-person / per-day allocation engine (2026-08-31).
//
// Before this module, the same three concepts were implemented three times
// over, and the three copies disagreed:
//
//   * the day-spread (a task's Scoped Hours spread across its own window)
//     lived in Utilization.tsx (`taskWorkingDays`), utilizationCalc.ts
//     (`taskWorkingDays`, points-based) and scopedHours.ts (`taskWorkingDays`)
//     -- all three weekend-only and holiday-BLIND, while capacityScheduler.ts
//     (today-and-future) was correctly holiday-aware. Net effect: in the
//     default "Actual" mode, hours allocated to a holiday or a person's Time
//     Off day were silently deleted from the grid (Utilization paints those
//     cells "Holiday"/"Off" and never renders a value), so a person's own
//     hours did not add up.
//   * PM overhead lived in Utilization.tsx (`pmHoursFor`), WbsPlanning.tsx
//     (`previewPmHoursFor`), capacityScheduler.ts (inline) -- and NOT AT ALL
//     in HoursOverview.tsx, so "Scoped vs Logged" always read lower than
//     Utilization for any project owner.
//   * the parent-task exclusion (a parent's estimated_hours is a rollup of
//     its children AND it inherits their assignee, so counting it double-
//     counts) was applied globally on Utilization.tsx and HoursOverview.tsx,
//     but only to THIS project's depth-0 parents in WbsPlanning.tsx's
//     Utilization snapshot -- which is why the snapshot showed ~2x the
//     Utilization page for the same person on the same day.
//
// Everything here is deliberately pure (no React, no supabase) so all three
// surfaces -- Utilization.tsx, HoursOverview.tsx and WbsPlanning.tsx's
// Utilization snapshot -- can call the identical functions with the identical
// inputs and, by construction, print the identical number.
// ---------------------------------------------------------------------------

import { TASK_STATUS_GROUPED, statusGroupOf } from "./notionOptions";
import { addDays, isWorkingDay, parseLocalDate, toISO, type HolidaySet } from "./workingDays";

// A "standard" workday. Only still used to express a person's capacity as a
// ratio in a couple of places; the allocation math itself is hours-native.
export const STANDARD_DAILY_HOURS = 7.5;

export interface UtilTaskRow {
  id: string;
  project_id: string;
  assignee_id: string | null;
  status: string | null;
  start_date: string | null;
  current_due_date: string;
  effort?: string | null;
  parent_task_id?: string | null;
  estimated_hours?: number | null;
  sort_order?: number | null;
  work_type_id?: string | null;
}
export interface UtilProjectRow {
  id: string;
  owner_id: string | null;
  start_date: string | null;
  end_date: string | null;
  wbs_status?: string | null;
}
export interface UtilPersonRow {
  id: string;
  daily_capacity_hours: number;
}

// Ownership/assignment history -- mirrors project_owner_history /
// task_assignee_history (supabase/policies.sql, "Migration 2026-08-14b").
export interface OwnerHistoryRow {
  project_id: string;
  person_id: string;
  effective_from: string;
  effective_to: string | null;
}
export interface AssigneeHistoryRow {
  task_id: string;
  person_id: string;
  effective_from: string;
  effective_to: string | null;
}

/** Every id that appears as some OTHER task's parent_task_id, across the
 * whole task list handed in. Callers must pass a GLOBAL task list (every
 * project's tasks), not one project's -- a parent whose children are
 * filtered out of the list would otherwise stop looking like a parent and
 * get counted on top of its own children. */
export function parentTaskIdsOf(tasks: { id: string; parent_task_id?: string | null }[]): Set<string> {
  return new Set(tasks.filter((t) => t.parent_task_id).map((t) => t.parent_task_id as string));
}

export function isOpenTask(t: { status: string | null }): boolean {
  return statusGroupOf(TASK_STATUS_GROUPED, t.status) !== "complete";
}

/** Per-person "Off" dates (half-days deliberately excluded: a half-day is a
 * reduced-capacity working day, not a blocked one, and the grid renders a
 * value on it). */
export type OffDaySet = Set<string>;
export function buildOffDaySet(rows: { person_id: string; date: string; status: "off" | "half_day" }[], personId: string): OffDaySet {
  return new Set(rows.filter((r) => r.person_id === personId && r.status === "off").map((r) => r.date.slice(0, 10)));
}

function isAllocatableDay(d: Date, holidays: HolidaySet, offDays?: OffDaySet): boolean {
  if (!isWorkingDay(d, holidays)) return false;
  return !offDays?.has(toISO(d));
}

/** Nearest day hours can legally land on, searching backward first then
 * forward. Used only for the degenerate case where a task's whole window is
 * non-working (e.g. a one-day task due exactly on a holiday) -- without this
 * the old code dropped the hours onto the due date itself, which the grid
 * then painted "Holiday"/"Off" and never rendered: the hours just vanished. */
function nearestAllocatableDay(from: Date, holidays: HolidaySet, offDays?: OffDaySet): string {
  for (let i = 0; i <= 30; i++) {
    const back = addDays(from, -i);
    if (isAllocatableDay(back, holidays, offDays)) return toISO(back);
    const fwd = addDays(from, i);
    if (isAllocatableDay(fwd, holidays, offDays)) return toISO(fwd);
  }
  return toISO(from);
}

/** The days a task's Scoped Hours spread across: its own start->due window,
 * weekends AND holidays AND the assignee's Time Off excluded. `offDays`
 * is optional so a caller previewing a DRAFT plan (WBS snapshot) can leave
 * per-person availability out if it doesn't have it loaded. */
export function taskAllocationDays(t: UtilTaskRow, holidays: HolidaySet, offDays?: OffDaySet): string[] {
  if (!t.current_due_date) return [];
  const end = parseLocalDate(t.current_due_date.slice(0, 10));
  const start = parseLocalDate((t.start_date ?? t.current_due_date).slice(0, 10));
  if (end < start) return [nearestAllocatableDay(end, holidays, offDays)];
  const days: string[] = [];
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    if (isAllocatableDay(d, holidays, offDays)) days.push(toISO(d));
  }
  return days.length ? days : [nearestAllocatableDay(end, holidays, offDays)];
}

/** A task's hours on one date -- 0 if that date isn't one of its own
 * allocation days, or it has no hours set. */
export function taskHoursOnDate(t: UtilTaskRow, dateStr: string, holidays: HolidaySet, offDays?: OffDaySet): number {
  const hours = t.estimated_hours ?? 0;
  if (hours <= 0) return 0;
  const days = taskAllocationDays(t, holidays, offDays);
  if (!days.includes(dateStr)) return 0;
  return hours / days.length;
}

// --- PM overhead -----------------------------------------------------------

// Every project a person owns costs them this many hours/day of project-
// management overhead on the project's own working days, uncapped across
// projects. Single source of truth (was duplicated as a points constant in
// utilizationCalc.ts and hardcoded as 0.5 in the SQL deletion archive).
export const PROJECT_PM_DAILY_HOURS = 0.25;

/** A project's REAL current end, for PM-overhead purposes.
 *
 * `projects.end_date` alone is not trustworthy here: it is the COMMITTED
 * envelope (frozen at lock time, only movable via an approved extension
 * request -- see enforce_project_date_lock), and the client-side effect that
 * re-derives it from tasks (Projects.tsx) deliberately bails out the moment
 * `timelines_locked` is true, i.e. for every started project. So a project
 * whose tasks now run past its committed end silently stopped accruing PM
 * overhead at the old date -- Sandra's "how come my PM overhead on 9/10 is
 * not reflecting when the tasks list is until sept 10?".
 *
 * Deliberately NOT fixed by making the DB derive projects.end_date from
 * tasks: that column carries governance meaning (task due dates are validated
 * against it, extension requests move it), and auto-widening it would let a
 * locked project's committed envelope drift with no approval trail. The
 * derived value lives here instead, in one shared function every surface
 * calls. */
export function pmWindowEnd(p: UtilProjectRow, projectTasks: { project_id: string; current_due_date: string }[]): string | null {
  let max: string | null = p.end_date ? p.end_date.slice(0, 10) : null;
  for (const t of projectTasks) {
    if (t.project_id !== p.id || !t.current_due_date) continue;
    const end = t.current_due_date.slice(0, 10);
    if (!max || end > max) max = end;
  }
  return max;
}

/** A project's PM-overhead working days. No due-date fallback: a project
 * with no start date set simply doesn't accrue PM time yet. */
export function projectPmDays(
  p: UtilProjectRow,
  projectTasks: { project_id: string; current_due_date: string }[],
  holidays: HolidaySet,
  offDays?: OffDaySet
): string[] {
  if (!p.start_date) return [];
  const endStr = pmWindowEnd(p, projectTasks);
  if (!endStr) return [];
  const start = parseLocalDate(p.start_date.slice(0, 10));
  const end = parseLocalDate(endStr);
  if (end < start) return [];
  const days: string[] = [];
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    if (isAllocatableDay(d, holidays, offDays)) days.push(toISO(d));
  }
  return days;
}

// --- history-aware attribution --------------------------------------------

export function ownerMatchesOnDate(p: UtilProjectRow, personId: string, dateStr: string, history?: OwnerHistoryRow[]): boolean {
  if (!history || history.length === 0) return p.owner_id === personId;
  const rows = history.filter((h) => h.project_id === p.id);
  if (rows.length === 0) return p.owner_id === personId;
  return rows.some((h) => h.person_id === personId && h.effective_from <= dateStr && (h.effective_to === null || h.effective_to >= dateStr));
}
export function assigneeMatchesOnDate(t: UtilTaskRow, personId: string, dateStr: string, history?: AssigneeHistoryRow[]): boolean {
  if (!history || history.length === 0) return t.assignee_id === personId;
  const rows = history.filter((h) => h.task_id === t.id);
  if (rows.length === 0) return t.assignee_id === personId;
  return rows.some((h) => h.person_id === personId && h.effective_from <= dateStr && (h.effective_to === null || h.effective_to >= dateStr));
}

// --- closed projects -------------------------------------------------------

/** A closed project's plan is final, but closure does NOT mark its tasks Done
 * (decide_wbs_closure only flips projects.wbs_status). Its still-open tasks
 * and its owner's PM overhead would otherwise keep eating FUTURE capacity
 * forever. Past dates are left untouched -- that work really did happen. */
export function closedProjectIds(projects: UtilProjectRow[]): Set<string> {
  return new Set(projects.filter((p) => p.wbs_status === "closed").map((p) => p.id));
}

// --- capacity --------------------------------------------------------------

export function dailyCapacityHours(person: UtilPersonRow, halfDay: boolean): number {
  return person.daily_capacity_hours * (halfDay ? 0.5 : 1);
}

// --- the one entry point every surface uses --------------------------------
//
// A tiny factory rather than free functions so the per-task / per-project day
// lists (which are what the old per-cell recomputation made quadratic) are
// computed once per person and reused across every date column. Build one per
// render pass; it holds no state beyond its own caches.

export interface AllocationEngineConfig {
  /** GLOBAL task list (every project). Parent tasks are filtered out here,
   * once, for every caller -- see parentTaskIdsOf. */
  tasks: UtilTaskRow[];
  projects: UtilProjectRow[];
  holidays: HolidaySet;
  /** person_availability rows. Off days remove a day from a person's own
   * allocation window; half-days only halve capacity, so they stay in. */
  availability?: { person_id: string; date: string; status: "off" | "half_day" }[];
  assigneeHistory?: AssigneeHistoryRow[];
  ownerHistory?: OwnerHistoryRow[];
  /** Today's ISO date. Closed projects stop consuming capacity from here on.
   * Omit to apply no closed-project cutoff at all (draft previews). */
  todayStr?: string;
  /** Archived per-person-per-day hours from permanently-deleted work. */
  deletedHours?: { person_id: string; date: string; hours: number }[];
}

export interface DailyAllocation {
  taskHours: Map<string, number>;
  pmHours: Map<string, number>;
  deletedHours: number;
  total: number;
}

export interface AllocationEngine {
  /** The global set of parent-task ids that were excluded. */
  parentTaskIds: Set<string>;
  /** The leaf tasks actually used for allocation. */
  leafTasks: UtilTaskRow[];
  taskDays(personId: string, task: UtilTaskRow): Set<string>;
  pmDays(personId: string, project: UtilProjectRow): Set<string>;
  taskHoursOnDate(personId: string, task: UtilTaskRow, dateStr: string): number;
  pmHoursOnDate(personId: string, project: UtilProjectRow, dateStr: string): number;
  deletedHoursOnDate(personId: string, dateStr: string): number;
  hasDeletedHistory(personId: string): boolean;
  allocationFor(personId: string, dateStr: string): DailyAllocation;
  totalFor(personId: string, dateStr: string): number;
}

export function createAllocationEngine(config: AllocationEngineConfig): AllocationEngine {
  const { tasks, projects, holidays, availability = [], assigneeHistory, ownerHistory, todayStr, deletedHours = [] } = config;

  const parentTaskIds = parentTaskIdsOf(tasks);
  const leafTasks = tasks.filter((t) => !parentTaskIds.has(t.id));
  const openLeafTasks = leafTasks.filter(isOpenTask);
  const closed = closedProjectIds(projects);

  const offByPerson = new Map<string, OffDaySet>();
  function offDaysFor(personId: string): OffDaySet {
    let s = offByPerson.get(personId);
    if (!s) {
      s = buildOffDaySet(availability, personId);
      offByPerson.set(personId, s);
    }
    return s;
  }

  const taskDayCache = new Map<string, Set<string>>();
  function taskDays(personId: string, task: UtilTaskRow): Set<string> {
    const key = `${task.id}|${personId}`;
    let s = taskDayCache.get(key);
    if (!s) {
      s = new Set(taskAllocationDays(task, holidays, offDaysFor(personId)));
      taskDayCache.set(key, s);
    }
    return s;
  }

  const pmDayCache = new Map<string, Set<string>>();
  function pmDays(personId: string, project: UtilProjectRow): Set<string> {
    const key = `${project.id}|${personId}`;
    let s = pmDayCache.get(key);
    if (!s) {
      s = new Set(projectPmDays(project, tasks, holidays, offDaysFor(personId)));
      pmDayCache.set(key, s);
    }
    return s;
  }

  const deletedIndex = new Map<string, number>();
  const deletedPeople = new Set<string>();
  for (const d of deletedHours) {
    const key = `${d.person_id}|${d.date.slice(0, 10)}`;
    deletedIndex.set(key, (deletedIndex.get(key) ?? 0) + Number(d.hours));
    deletedPeople.add(d.person_id);
  }

  function taskHoursOnDateFn(personId: string, task: UtilTaskRow, dateStr: string): number {
    const hours = task.estimated_hours ?? 0;
    if (hours <= 0) return 0;
    if (!isOpenTask(task)) return 0;
    if (todayStr && dateStr >= todayStr && closed.has(task.project_id)) return 0;
    if (!assigneeMatchesOnDate(task, personId, dateStr, assigneeHistory)) return 0;
    const days = taskDays(personId, task);
    if (!days.has(dateStr)) return 0;
    return hours / days.size;
  }

  function pmHoursOnDateFn(personId: string, project: UtilProjectRow, dateStr: string): number {
    if (todayStr && dateStr >= todayStr && project.wbs_status === "closed") return 0;
    if (!ownerMatchesOnDate(project, personId, dateStr, ownerHistory)) return 0;
    return pmDays(personId, project).has(dateStr) ? PROJECT_PM_DAILY_HOURS : 0;
  }

  function deletedHoursOnDate(personId: string, dateStr: string): number {
    return deletedIndex.get(`${personId}|${dateStr}`) ?? 0;
  }

  function allocationFor(personId: string, dateStr: string): DailyAllocation {
    const taskHours = new Map<string, number>();
    for (const t of openLeafTasks) {
      const h = taskHoursOnDateFn(personId, t, dateStr);
      if (h > 0) taskHours.set(t.id, h);
    }
    const pmHours = new Map<string, number>();
    for (const p of projects) {
      const h = pmHoursOnDateFn(personId, p, dateStr);
      if (h > 0) pmHours.set(p.id, h);
    }
    const del = deletedHoursOnDate(personId, dateStr);
    let total = del;
    taskHours.forEach((v) => (total += v));
    pmHours.forEach((v) => (total += v));
    return { taskHours, pmHours, deletedHours: del, total };
  }

  return {
    parentTaskIds,
    leafTasks,
    taskDays,
    pmDays,
    taskHoursOnDate: taskHoursOnDateFn,
    pmHoursOnDate: pmHoursOnDateFn,
    deletedHoursOnDate,
    hasDeletedHistory: (personId: string) => deletedPeople.has(personId),
    allocationFor,
    totalFor: (personId: string, dateStr: string) => allocationFor(personId, dateStr).total,
  };
}
