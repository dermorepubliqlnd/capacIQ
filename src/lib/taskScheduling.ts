// Per-task 3-scenario due-date calculator for the WBS planning feature.
// Given a task's own Start date + Estimated hours, computes what the Due
// date would be under each of three planning modes. Deliberately does NOT
// infer sequencing/parallelism from the task hierarchy -- per Sandra, the
// planner sets each task's own Start date directly, so two tasks sharing a
// start date are naturally "parallel" and one started after another's due
// date is naturally sequential. This module is a pure calculator; data
// fetching (holidays, a person's real allocations) is the caller's job.

import { addDays, addWorkingDays, isWorkingDay, parseLocalDate, toISO, type HolidaySet } from "./workingDays";

export const FULL_CAPACITY_DAILY_HOURS = 7.5;
export const STANDARD_DAILY_HOURS = 4;

export interface ScenarioResult {
  /** Unrounded hours/rate figure, e.g. 15h / 4h-per-day = 3.75 -- shown as
   * a reported duration/comparison metric, NOT used directly as a date. */
  rawDays: number;
  /** Whole working days actually scheduled (Math.ceil(rawDays), min 1) --
   * this is what the due date is computed from. */
  wholeDays: number;
  dueDate: string;
}

function rateScenario(hours: number, startDateStr: string, dailyHours: number, holidays: HolidaySet): ScenarioResult {
  const rawDays = hours > 0 ? hours / dailyHours : 0;
  const wholeDays = hours > 0 ? Math.max(1, Math.ceil(rawDays)) : 0;
  const start = parseLocalDate(startDateStr);
  const due = wholeDays > 0 ? addWorkingDays(start, wholeDays, holidays) : addWorkingDays(start, 1, holidays);
  return { rawDays: Math.round(rawDays * 100) / 100, wholeDays, dueDate: toISO(due) };
}

/** Full Capacity: a person working a full 7.5h/day on this task alone. */
export function fullCapacityScenario(hours: number, startDateStr: string, holidays: HolidaySet): ScenarioResult {
  return rateScenario(hours, startDateStr, FULL_CAPACITY_DAILY_HOURS, holidays);
}

/** Standard: a conservative 4h/day planning assumption (leaves headroom
 * for meetings, other tasks, context switching). */
export function standardScenario(hours: number, startDateStr: string, holidays: HolidaySet): ScenarioResult {
  return rateScenario(hours, startDateStr, STANDARD_DAILY_HOURS, holidays);
}

/**
 * Capacity-Based: walks forward day by day from startDateStr, consuming a
 * specific person's real remaining free hours each working day (via
 * `remainingHoursOnDate`, supplied by the caller -- typically
 * `person.daily_capacity_hours` minus whatever Day Planner already has
 * allocated to them that day, mirroring `personTotalFor` in
 * DayPlanner.tsx) until the required `hours` are exhausted.
 *
 * Unlike the two rate-based scenarios, there's no clean fractional "raw
 * days" figure here (daily capacity varies day to day), so `rawDays` and
 * `wholeDays` are the same value: the real count of working days the
 * person actually had to spend on it.
 */
export function capacityBasedScenario(
  hours: number,
  startDateStr: string,
  holidays: HolidaySet,
  remainingHoursOnDate: (dateStr: string) => number,
  maxDaysGuard = 365
): ScenarioResult {
  let d = parseLocalDate(startDateStr);
  while (!isWorkingDay(d, holidays)) d = addDays(d, 1);
  if (hours <= 0) return { rawDays: 0, wholeDays: 0, dueDate: toISO(d) };

  let remainingWork = hours;
  let daysUsed = 0;
  let lastWorkedDate = toISO(d);
  let guard = 0;
  while (remainingWork > 0 && guard < maxDaysGuard) {
    guard++;
    if (isWorkingDay(d, holidays)) {
      const free = Math.max(0, remainingHoursOnDate(toISO(d)));
      if (free > 0) {
        remainingWork -= free;
        daysUsed++;
        lastWorkedDate = toISO(d);
      }
    }
    if (remainingWork > 0) d = addDays(d, 1);
  }
  return { rawDays: daysUsed, wholeDays: daysUsed, dueDate: lastWorkedDate };
}

export interface ScenarioSet {
  fullCapacity: ScenarioResult;
  standard: ScenarioResult;
  capacityBased: ScenarioResult | null; // null until a person is chosen
}

/** Convenience: compute the two rate-based scenarios together (Capacity-
 * Based needs a person picked first, so it's left out here and computed
 * separately once one's chosen on the WBS page). */
export function computeRateScenarios(hours: number, startDateStr: string, holidays: HolidaySet): Pick<ScenarioSet, "fullCapacity" | "standard"> {
  return {
    fullCapacity: fullCapacityScenario(hours, startDateStr, holidays),
    standard: standardScenario(hours, startDateStr, holidays),
  };
}

export interface FullCapacityQueueTask {
  id: string;
  estimatedHours: number;
  /** This task's own recorded Start -- used ONLY to order the queue
   * (whichever task's stored Start is earliest goes first). Every task
   * has one of these (even an untouched sibling that was never
   * dependency-linked to anything -- it still got SOME default value
   * when it was created), so it must NOT also act as a hard floor, or
   * every such sibling would keep its old, pre-packing placement and
   * never actually pack -- see `floorDateStr` below for the field that
   * DOES act as a real floor. */
  ownStartDateStr: string;
  /** A REAL constraint this task can't start before -- set this ONLY
   * when it's genuinely load-bearing (e.g. this task has an actual
   * Depends-on link, and this is the dependency-derived "day after the
   * predecessor's End" floor). Leave undefined for an ordinary,
   * unconstrained sibling -- undefined means "pack wherever the shared
   * cursor naturally lands," never "pull the cursor forward to here."
   * Bugfix (2026-08-26, Sandra: Joseph's Task 3/4 still weren't
   * packing): the original version conflated this with
   * `ownStartDateStr` -- treating EVERY task's stored Start as a hard
   * floor accidentally preserved every untouched sibling's old,
   * independent placement instead of ever letting it pack into an
   * earlier task's leftover same-day capacity, defeating the entire
   * feature for the exact "two ordinary siblings, no dependency
   * between them" case it was built for. */
  floorDateStr?: string;
  sortOrder?: number | null;
  isFixedSchedule?: boolean;
}

export interface FullCapacityQueueResult {
  starts: Map<string, string>;
  ends: Map<string, string>;
}

/**
 * Theoretical/Full-Capacity same-person, same-project day-packing walk.
 * (2026-08-26, Sandra: two of Joseph's tasks, 3h then 7.5h -- "if Jo
 * still has 4.5 hours left for Aug 5, then this next task can start on
 * the same day with overflow to the following day.")
 *
 * Queues every one of a person's own tasks (the caller filters to ONE
 * project -- Theoretical stays project-scoped, unlike Capacity-Based
 * which is deliberately cross-project) and walks them forward at a flat
 * `dailyHours` ceiling (7.5h by default), packing multiple tasks into
 * the same working day when there's room left and splitting a single
 * task across a day boundary when there isn't, instead of the old
 * per-task-independent calc (`fullCapacityScenario`) which gave every
 * task its own untouched Start regardless of a same-person predecessor's
 * leftover capacity that same day.
 *
 * Unlike `buildForwardSchedule` (capacityScheduler.ts, used by
 * Capacity-Based/Utilization), a task's `floorDateStr` -- set ONLY for a
 * genuinely dependency-constrained task, see FullCapacityQueueTask's doc
 * comment -- can push the shared cursor forward, but it never holds a
 * LATER-queued task back from filling an EARLIER task's same-day
 * leftover capacity, and an ORDINARY (non-dependency) task has no floor
 * at all, so it always packs wherever the cursor naturally lands. That's
 * intentional -- Capacity-Based's per-task floor reflects "honor what's
 * already been declared", which is right for a more conservative,
 * already-committed-aware reference; Theoretical is the optimistic
 * "what if every available hour got used" reference, so it should
 * actively close gaps between ordinary siblings.
 */
export function packFullCapacityQueue(
  tasks: FullCapacityQueueTask[],
  holidays: HolidaySet,
  dailyHours: number = FULL_CAPACITY_DAILY_HOURS,
  maxDaysGuard = 365
): FullCapacityQueueResult {
  const starts = new Map<string, string>();
  const ends = new Map<string, string>();
  if (tasks.length === 0) return { starts, ends };

  const ordered = [...tasks].sort((a, b) => {
    if (a.ownStartDateStr !== b.ownStartDateStr) return a.ownStartDateStr < b.ownStartDateStr ? -1 : 1;
    if (a.sortOrder != null && b.sortOrder != null && a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // Runs one shared-cursor walk over `queue` -- consecutive tasks in the
  // SAME queue pack into each other's leftover same-day capacity; each
  // call to this function starts a fresh cursor (used to keep
  // Fixed-Schedule tasks from sharing a cursor with anything else, and
  // with each other).
  function walk(queue: FullCapacityQueueTask[], startCursor: { date: Date; remaining: number }, guardState: { n: number }) {
    let cursorDate = startCursor.date;
    let cursorRemaining = startCursor.remaining;
    while (!isWorkingDay(cursorDate, holidays)) {
      cursorDate = addDays(cursorDate, 1);
      cursorRemaining = dailyHours;
    }
    for (const task of queue) {
      if (task.floorDateStr) {
        const ownFloor = parseLocalDate(task.floorDateStr);
        if (ownFloor.getTime() > cursorDate.getTime()) {
          cursorDate = ownFloor;
          cursorRemaining = dailyHours;
          while (!isWorkingDay(cursorDate, holidays)) {
            cursorDate = addDays(cursorDate, 1);
            cursorRemaining = dailyHours;
          }
        }
      }
      let remaining = task.estimatedHours;
      let firstDate: string | null = null;
      let lastDate: string | null = null;
      while (remaining > 0 && guardState.n < maxDaysGuard) {
        guardState.n++;
        if (!isWorkingDay(cursorDate, holidays) || cursorRemaining <= 0) {
          cursorDate = addDays(cursorDate, 1);
          cursorRemaining = dailyHours;
          continue;
        }
        const consume = Math.min(cursorRemaining, remaining);
        if (!firstDate) firstDate = toISO(cursorDate);
        lastDate = toISO(cursorDate);
        cursorRemaining -= consume;
        remaining -= consume;
      }
      starts.set(task.id, firstDate ?? toISO(cursorDate));
      ends.set(task.id, lastDate ?? toISO(cursorDate));
    }
  }

  const guardState = { n: 0 };
  // Fixed-Schedule tasks first, each independently at the full daily
  // ceiling (never shares/crowds a day with anything else) -- same
  // "honest overallocation, never silently deferred" assumption
  // buildForwardSchedule's own fixedQueue pass uses.
  const fixed = ordered.filter((t) => t.isFixedSchedule);
  const flexible = ordered.filter((t) => !t.isFixedSchedule);
  for (const t of fixed) {
    walk([t], { date: parseLocalDate(t.ownStartDateStr), remaining: dailyHours }, guardState);
  }

  if (flexible.length) {
    // Don't let flexible tasks double-book a day a Fixed task already
    // claimed -- start the shared flexible cursor the working day after
    // the latest Fixed task's own end, if any Fixed tasks exist.
    let cursorStart = { date: parseLocalDate(flexible[0].ownStartDateStr), remaining: dailyHours };
    if (fixed.length) {
      const lastFixedEnd = fixed.reduce<string | null>((max, t) => {
        const e = ends.get(t.id);
        return e && (!max || e > max) ? e : max;
      }, null);
      if (lastFixedEnd && lastFixedEnd >= toISO(cursorStart.date)) {
        cursorStart = { date: addDays(parseLocalDate(lastFixedEnd), 1), remaining: dailyHours };
      }
    }
    walk(flexible, cursorStart, guardState);
  }

  return { starts, ends };
}
