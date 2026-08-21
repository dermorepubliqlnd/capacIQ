// Phase 2 (2026-08-20): hours-native, capacity-aware forward scheduler for
// Utilization.tsx's "today and future" columns. Reuses the day-by-day walk
// idea from taskScheduling.ts's `capacityBasedScenario`, but that function
// only returns a single task's final due date/wholeDays -- it doesn't give
// us the full per-day, per-task, per-project breakdown a whole-team grid
// needs to render every cell. Rather than modify that live, shared module,
// this is a fresh implementation of the same forward-walk idea with the
// extra bookkeeping the grid needs. Do not import taskScheduling.ts here;
// keep this module self-contained.

import { addDays, isWorkingDay, parseLocalDate, toISO, type HolidaySet } from "./workingDays";

// Unifies what used to be two separate PM-overhead mechanisms (Day
// Planner's manual-entry default of 0.5h/day, and Utilization's old
// points-based 0.1pt/day ~= 0.75h-equivalent with a combined 0.3pt/day ~=
// 2.25h cap across all owned projects). Phase 2 replaces both with one
// flat allowance: every project a person owns gets this many hours/day of
// PM overhead on its own working days, with NO combined cross-project cap
// -- if you own three active projects, that's 3 * 0.5h = 1.5h/day of PM
// time, uncapped. Intentional per Sandra's Phase 2 sign-off.
export const PROJECT_PM_DAILY_HOURS = 0.5;

export interface SchedPersonRow {
  id: string;
  daily_capacity_hours: number;
}
export interface SchedTaskRow {
  id: string;
  project_id: string;
  parent_task_id: string | null;
  assignee_id: string | null;
  status: string | null;
  start_date: string | null;
  current_due_date: string;
  estimated_hours: number | null;
}
export interface SchedProjectRow {
  id: string;
  owner_id: string | null;
  start_date: string | null;
  end_date: string | null;
}
export interface SchedAvailabilityRow {
  person_id: string;
  date: string;
  status: "off" | "half_day";
}

function halfDayTag(personId: string, dateStr: string, availability: SchedAvailabilityRow[]): "off" | "half_day" | null {
  // "off" beats "half_day" if somehow both exist for the same person/date
  // (shouldn't happen given the UI only lets you set one at a time, but
  // this keeps the precedence explicit rather than accidental).
  let sawHalf = false;
  for (const a of availability) {
    if (a.person_id !== personId || a.date !== dateStr) continue;
    if (a.status === "off") return "off";
    if (a.status === "half_day") sawHalf = true;
  }
  return sawHalf ? "half_day" : null;
}

/** A single day's raw capacity for a person, accounting for weekends,
 * holidays, and an Off/Half-day tag -- everything the grid's existing
 * blocked-day rendering already knows how to special-case, exposed here as
 * a plain number for callers (like the forward walk below) that just need
 * the figure. */
export function capacityOnDate(person: SchedPersonRow, dateStr: string, holidaySet: HolidaySet, availability: SchedAvailabilityRow[]): number {
  const d = parseLocalDate(dateStr);
  if (!isWorkingDay(d, holidaySet)) return 0;
  const tag = halfDayTag(person.id, dateStr, availability);
  if (tag === "off") return 0;
  return person.daily_capacity_hours * (tag === "half_day" ? 0.5 : 1);
}

/** Convenience for a caller that already has the specific availability row
 * (or lack thereof) for one date in hand and just wants the number, without
 * re-scanning the whole availability array. */
export function dailyCapacityHoursFor(person: SchedPersonRow, availabilityRow: SchedAvailabilityRow | undefined): number {
  if (availabilityRow?.status === "off") return 0;
  return person.daily_capacity_hours * (availabilityRow?.status === "half_day" ? 0.5 : 1);
}

export interface ForwardScheduleArgs {
  personId: string;
  fromDateStr: string;
  tasks: SchedTaskRow[];
  parentTaskIds: Set<string>;
  isCompleteStatus: (status: string | null) => boolean;
  projects: SchedProjectRow[];
  person: SchedPersonRow;
  holidaySet: HolidaySet;
  availability: SchedAvailabilityRow[];
  maxDaysGuard?: number;
}

export interface ForwardScheduleDay {
  capacity: number;
  pmHours: Map<string, number>;
  taskHours: Map<string, number>;
  totalHours: number;
}

export interface ForwardScheduleResult {
  perDay: Map<string, ForwardScheduleDay>;
  taskDueDates: Map<string, string>;
  // First date the forward walk actually consumed hours toward this task
  // (added 2026-08-21 for WBS Timeline's capacity-aware "Projected" Gantt,
  // which needs a start AND end per task to draw a bar -- Utilization.tsx's
  // grid only ever needed the end date, so this was never tracked before).
  taskStartDates: Map<string, string>;
}

function maxDate(a: Date, b: Date): Date {
  return a > b ? a : b;
}

export function buildForwardSchedule(args: ForwardScheduleArgs): ForwardScheduleResult {
  const {
    personId,
    fromDateStr,
    tasks,
    parentTaskIds,
    isCompleteStatus,
    projects,
    person,
    holidaySet,
    availability,
    maxDaysGuard = 365,
  } = args;

  const perDay = new Map<string, ForwardScheduleDay>();
  const fromDate = parseLocalDate(fromDateStr);

  // Owned, currently-active (has a start/end window) projects -- same
  // "no dates, no PM time yet" convention as the rest of the app.
  const ownedProjects = projects.filter((p) => p.owner_id === personId && p.start_date && p.end_date);

  // Pre-populate every working day in the guard window with PM overhead so
  // task consumption below has a real "remaining capacity" to subtract
  // from, even on days no task ever gets scheduled.
  for (let i = 0, d = new Date(fromDate); i < maxDaysGuard; i++, d = addDays(d, 1)) {
    if (!isWorkingDay(d, holidaySet)) continue;
    const dateStr = toISO(d);
    const capacity = capacityOnDate(person, dateStr, holidaySet, availability);
    const pmHours = new Map<string, number>();
    let pmTotal = 0;
    for (const p of ownedProjects) {
      if (dateStr >= (p.start_date as string) && dateStr <= (p.end_date as string)) {
        pmHours.set(p.id, PROJECT_PM_DAILY_HOURS);
        pmTotal += PROJECT_PM_DAILY_HOURS;
      }
    }
    perDay.set(dateStr, { capacity, pmHours, taskHours: new Map(), totalHours: pmTotal });
  }

  // Filter + sort the task queue.
  const effectiveStart = (t: SchedTaskRow): Date => {
    const raw = parseLocalDate(t.start_date ?? t.current_due_date);
    return maxDate(raw, fromDate);
  };
  const queue = tasks
    .filter(
      (t) =>
        t.assignee_id === personId &&
        !parentTaskIds.has(t.id) &&
        !isCompleteStatus(t.status) &&
        (t.estimated_hours ?? 0) > 0
    )
    .sort((a, b) => {
      const aStart = effectiveStart(a).getTime();
      const bStart = effectiveStart(b).getTime();
      if (aStart !== bStart) return aStart - bStart;
      if (a.current_due_date !== b.current_due_date) return a.current_due_date < b.current_due_date ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const taskDueDates = new Map<string, string>();
  const taskStartDates = new Map<string, string>();
  const lastGuardDate = toISO(addDays(fromDate, Math.max(0, maxDaysGuard - 1)));

  for (const task of queue) {
    let remaining = task.estimated_hours ?? 0;
    let d = effectiveStart(task);
    let firstWorkedDate: string | null = null;
    let lastWorkedDate: string | null = null;
    let guard = 0;
    while (remaining > 0 && guard < maxDaysGuard) {
      guard++;
      if (isWorkingDay(d, holidaySet)) {
        const dateStr = toISO(d);
        let day = perDay.get(dateStr);
        if (!day) {
          // Outside the pre-populated window (shouldn't normally happen
          // since we pre-populate the full guard window from fromDateStr,
          // but guard defensively in case a task's effective start lands
          // past it due to clock skew edge cases).
          const capacity = capacityOnDate(person, dateStr, holidaySet, availability);
          day = { capacity, pmHours: new Map(), taskHours: new Map(), totalHours: 0 };
          perDay.set(dateStr, day);
        }
        const free = Math.max(0, day.capacity - day.totalHours);
        if (free > 0) {
          const consume = Math.min(free, remaining);
          day.taskHours.set(task.id, (day.taskHours.get(task.id) ?? 0) + consume);
          day.totalHours += consume;
          remaining -= consume;
          if (!firstWorkedDate) firstWorkedDate = dateStr;
          lastWorkedDate = dateStr;
        }
      }
      if (remaining > 0) d = addDays(d, 1);
    }
    taskDueDates.set(task.id, lastWorkedDate ?? lastGuardDate);
    taskStartDates.set(task.id, firstWorkedDate ?? lastWorkedDate ?? lastGuardDate);
  }

  return { perDay, taskDueDates, taskStartDates };
}
