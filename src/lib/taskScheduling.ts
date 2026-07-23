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
