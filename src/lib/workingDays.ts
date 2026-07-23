// Shared holiday-aware working-day math. Consolidates logic that was
// previously duplicated (weekend-only, no holiday awareness) in
// Utilization.tsx and DayPlanner.tsx. New code (the WBS planning feature)
// uses this; the older duplicated copies are left as-is for now to avoid
// touching already-shipped, working behavior in the same pass.

// Local-timezone date parsing/formatting — avoids the classic
// `new Date("YYYY-MM-DD")` UTC-midnight parsing shift. Mirrors the
// equivalent helpers already duplicated per-file elsewhere in the app.
export function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.slice(0, 10).split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

export function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addDays(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}

/** A holiday lookup, keyed by "YYYY-MM-DD". Build once from the `holidays`
 * table (all categories count -- legal, local, and internal all block a
 * working day the same way project/task scheduling already treats them
 * as non-working in Utilization's tint logic). */
export type HolidaySet = Set<string>;

export function buildHolidaySet(holidayDates: string[]): HolidaySet {
  return new Set(holidayDates.map((d) => d.slice(0, 10)));
}

export function isWorkingDay(d: Date, holidays: HolidaySet): boolean {
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return false;
  if (holidays.has(toISO(d))) return false;
  return true;
}

/** Walks forward from `start` (inclusive) counting `numWorkingDays` working
 * days and returns the date the last one lands on. `numWorkingDays` is
 * expected to already be a whole number (round up fractional effort-day
 * counts with `Math.ceil` before calling this) -- a task that needs "2
 * working days" starting Monday returns Tuesday (day 1 = Monday, day 2 =
 * Tuesday); a task needing "1 working day" returns the start date itself
 * if the start date is already a working day, otherwise the next one. */
export function addWorkingDays(start: Date, numWorkingDays: number, holidays: HolidaySet): Date {
  let d = new Date(start);
  // Snap the start itself forward to a working day first (a task can't
  // meaningfully "start" on a weekend/holiday).
  while (!isWorkingDay(d, holidays)) d = addDays(d, 1);
  if (numWorkingDays <= 0) return d;
  let remaining = numWorkingDays - 1; // the start day itself counts as day 1
  while (remaining > 0) {
    d = addDays(d, 1);
    if (isWorkingDay(d, holidays)) remaining--;
  }
  return d;
}

/** All working-day date strings (inclusive) between two dates. Returns the
 * end date alone if the window is entirely a weekend/holiday, matching the
 * existing single-day fallback convention used in Utilization.tsx. */
export function workingDaysBetween(start: Date, end: Date, holidays: HolidaySet): string[] {
  if (end < start) return [toISO(end)];
  const days: string[] = [];
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    if (isWorkingDay(d, holidays)) days.push(toISO(d));
  }
  return days.length ? days : [toISO(end)];
}
