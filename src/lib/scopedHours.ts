// Shared "Scoped Hours" spread-across-window engine (2026-08-25).
// Ported from Utilization.tsx's taskWorkingDays/taskHoursOnDate (the same
// math that already powers the WBS Utilization panel's Theoretical/
// Forecasted preview) so Work Schedule's new "Scoped" tab and the new
// Scoped-vs-Logged Overview page compute it identically instead of each
// re-deriving their own version. A task's Scoped Hours (estimated_hours)
// are spread evenly across its own start-to-due working-day window
// (weekends excluded); if start_date is unset the window collapses to the
// due date alone, same fallback as Utilization.tsx.
export interface ScopedTaskLike {
  id: string;
  start_date: string | null;
  current_due_date: string;
  estimated_hours: number | null;
}

function parseLocalDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDaysLocal(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function toISOLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function taskWorkingDays(t: ScopedTaskLike): string[] {
  const windowStart = parseLocalDate(t.start_date ?? t.current_due_date);
  const windowEnd = parseLocalDate(t.current_due_date);
  if (windowEnd < windowStart) return [t.current_due_date];
  const days: string[] = [];
  for (let d = new Date(windowStart); d <= windowEnd; d = addDaysLocal(d, 1)) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) days.push(toISOLocal(d));
  }
  return days.length ? days : [t.current_due_date];
}

// A task's Scoped Hours on one specific date -- 0 if that date isn't one
// of the task's own working days, or if the task has no Scoped Hours set.
export function scopedHoursOnDate(t: ScopedTaskLike, dateStr: string): number {
  const hours = t.estimated_hours ?? 0;
  if (hours === 0) return 0;
  const workingDays = taskWorkingDays(t);
  if (!workingDays.includes(dateStr)) return 0;
  return hours / workingDays.length;
}
