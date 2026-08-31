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
// Single source of truth for the PM-overhead rate and for a project's REAL
// current end date (consolidated 2026-08-31 -- see dailyAllocation.ts).
import { PROJECT_PM_DAILY_HOURS, pmWindowEnd } from "./dailyAllocation";

// Unifies what used to be two separate PM-overhead mechanisms (Day
// Planner's manual-entry default of 0.5h/day, and Utilization's old
// points-based 0.1pt/day ~= 0.75h-equivalent with a combined 0.3pt/day ~=
// 2.25h cap across all owned projects). Phase 2 replaces both with one
// flat allowance: every project a person owns gets this many hours/day of
// PM overhead on its own working days, with NO combined cross-project cap
// -- if you own three active projects, that is 3 * rate = however many
// hours/day of PM time, uncapped. Intentional per Sandra's Phase 2 sign-off.
// Lowered 0.5 -> 0.25 (2026-08-24, Sandra): 30 min/day/project was an
// uncalibrated placeholder feeding directly into the Actual view, which
// exists specifically to expose true overallocation -- an overstated
// PM assumption was manufacturing overload that was not real work. Still
// uncapped per Sandra's call to revisit a combined cap only if a
// multi-project owner still looks overloaded from overhead alone.
// Lives in dailyAllocation.ts now (one constant for the grid, the scheduler
// AND the SQL deletion archive, which used to carry its own stale 0.5).
// Re-exported here so existing importers keep working unchanged.
export { PROJECT_PM_DAILY_HOURS };

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
  // Optional (2026-08-21): WBS row order, used ONLY as a tie-break when
  // two tasks for the same person land on the exact same effective
  // start AND due date (e.g. a same-day AM/PM training pair) -- see the
  // queue sort below. Falls back to `id` comparison when absent, same
  // as before this field existed.
  sort_order?: number | null;
  // Optional (2026-08-21, Phase 3 -- Fixed-Schedule work types): true
  // when this task's Work Type is flagged is_fixed_schedule (e.g.
  // Training Delivery). Fixed tasks are placed onto their own calendar
  // day(s) FIRST, using the person's full raw daily capacity as the
  // per-day ceiling (same assumption as Full Effort) -- never deferred
  // by competing work. Flexible tasks are queued afterward against
  // whatever capacity is left once fixed tasks (and PM overhead) have
  // already claimed their share, so genuine overallocation on a fixed
  // task's day shows up honestly instead of quietly pushing hours to
  // tomorrow. Missing/false behaves exactly as before this field
  // existed (fully flexible, deferrable).
  is_fixed_schedule?: boolean | null;
}
export interface SchedProjectRow {
  id: string;
  owner_id: string | null;
  start_date: string | null;
  end_date: string | null;
  // Optional (2026-08-24, Sandra: "whatever is committed/locked in the
  // baseline [should take] precedence before deciding on Capacity-Based"):
  // a project's wbs_status ('draft' | 'baseline_locked' |
  // 'changed_after_baseline' | 'revision_in_progress' | 'closed').
  // Missing/undefined is treated as committed (not draft) so callers that
  // don't pass this (Day Planner has none of its own; any caller that
  // predates this field) see zero behavior change -- only an EXPLICIT
  // 'draft' demotes a project's tasks in the queue below.
  wbs_status?: string | null;
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
  // WBS Planning bugfix (2026-08-26, Sandra: a 08/03-started task showed
  // its Forecasted End as today (08/26) instead of 08/04): `fromDateStr`
  // was always "today" AND every task's effective start was floored at
  // it (see `effectiveStart` below), so a task whose own stored
  // start_date is already in the past got silently pushed forward to
  // today before the walk even began -- correct for Utilization.tsx's
  // "today and future" grid (this scheduler's original, still-default
  // use case, see the file header), wrong for WBS Planning's own
  // Forecasted/Capacity-Based table, which should schedule from a
  // task's REAL Start date even when that's in the past (e.g. backdated
  // test data, or a task that's simply running late). Defaults to true
  // (old behavior, unchanged) so Utilization.tsx's own call is
  // unaffected; WbsPlanning.tsx's call opts out.
  floorEffectiveStartAtFromDate?: boolean;
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
    floorEffectiveStartAtFromDate = true,
  } = args;

  const perDay = new Map<string, ForwardScheduleDay>();
  const fromDate = parseLocalDate(fromDateStr);

  // Owned, currently-active (has a start date) projects -- same
  // "no dates, no PM time yet" convention as the rest of the app.
  //
  // Fix (2026-08-31): the window's END is now derived via pmWindowEnd (the
  // later of projects.end_date and the project's own latest task due date)
  // instead of reading the persisted projects.end_date alone. That column is
  // the frozen COMMITTED envelope once timelines_locked is true -- nothing
  // re-syncs it from tasks after that -- so a started project whose tasks run
  // past it silently stopped charging its owner PM overhead partway through
  // ("PM overhead on 9/10 is not reflecting when the tasks list is until sept
  // 10"). Same derivation the grid's own even-spread path now uses.
  //
  // Closed projects are skipped outright: closure does not mark their tasks
  // Done (decide_wbs_closure only flips wbs_status), and this scheduler only
  // ever covers today-and-future, so a closed project would otherwise keep
  // charging PM overhead against future capacity forever.
  const ownedProjects = projects
    .filter((p) => p.owner_id === personId && p.start_date && p.wbs_status !== "closed")
    .map((p) => ({ id: p.id, start_date: p.start_date as string, end_date: pmWindowEnd(p, tasks) }))
    .filter((p): p is { id: string; start_date: string; end_date: string } => !!p.end_date);

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
    return floorEffectiveStartAtFromDate ? maxDate(raw, fromDate) : raw;
  };
  // Closed projects' still-open tasks are excluded for the same reason their
  // PM overhead is (see ownedProjects above): closure does not mark tasks
  // Done, so they would keep eating a person's future capacity indefinitely.
  const closedProjectIdSet = new Set(projects.filter((p) => p.wbs_status === "closed").map((p) => p.id));
  const eligible = tasks.filter(
    (t) =>
      t.assignee_id === personId &&
      !parentTaskIds.has(t.id) &&
      !isCompleteStatus(t.status) &&
      !closedProjectIdSet.has(t.project_id) &&
      (t.estimated_hours ?? 0) > 0
  );
  // Bugfix (2026-08-24, Sandra -- Utlization Conflict Test: "whatever is
  // committed/locked in the baseline [should take] precedence before
  // deciding on capacity based"): a brand-new Draft-project task (never
  // baselined) was winning shared capacity over an already-baseline-
  // locked task purely because its own Start floor happened to be
  // earlier -- e.g. a just-created "Stress Test" task deferred a real,
  // committed "Post-Training Eval" task instead of the other way around.
  // Committed work (any wbs_status other than 'draft' -- baseline_locked,
  // changed_after_baseline, revision_in_progress, closed) now always
  // gets first claim on a person's shared capacity; Draft-project tasks
  // only fill in whatever's left over, and among themselves (or among
  // several committed tasks) the existing Start-floor/due-date/sort_order
  // ordering below still decides who goes first.
  const draftProjectIds = new Set(projects.filter((p) => p.wbs_status === "draft").map((p) => p.id));
  const isDraftTask = (t: SchedTaskRow): boolean => draftProjectIds.has(t.project_id);
  const sortByEffectiveDate = (a: SchedTaskRow, b: SchedTaskRow) => {
      const aDraft = isDraftTask(a) ? 1 : 0;
      const bDraft = isDraftTask(b) ? 1 : 0;
      if (aDraft !== bDraft) return aDraft - bDraft;
      const aStart = effectiveStart(a).getTime();
      const bStart = effectiveStart(b).getTime();
      if (aStart !== bStart) return aStart - bStart;
      if (a.current_due_date !== b.current_due_date) return a.current_due_date < b.current_due_date ? -1 : 1;
      // Bugfix (2026-08-21, Sandra: same-day AM/PM training pair queued in
      // an unpredictable order): previously fell straight to comparing
      // raw task UUIDs here, which has no relationship to anything a user
      // controls -- effectively arbitrary which of two same-day, same-
      // person tasks got "first dibs" on the day's capacity (and which
      // one showed a full clean number vs. a partial-plus-overflow). Sort
      // by the WBS table's own row order first when both tasks have one;
      // only fall back to the id comparison if sort_order is missing or
      // tied (e.g. one side is a cross-project task with no comparable
      // ordering against this project's own rows).
      if (a.sort_order != null && b.sort_order != null && a.sort_order !== b.sort_order) {
        return a.sort_order - b.sort_order;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };

  const fixedQueue = eligible.filter((t) => t.is_fixed_schedule).sort(sortByEffectiveDate);
  const flexQueue = eligible.filter((t) => !t.is_fixed_schedule).sort(sortByEffectiveDate);

  const taskDueDates = new Map<string, string>();
  const taskStartDates = new Map<string, string>();
  const lastGuardDate = toISO(addDays(fromDate, Math.max(0, maxDaysGuard - 1)));

  // Fixed-Schedule tasks placed FIRST, independently of each other and of
  // the flexible queue below: each one's own daily ceiling is the
  // person's full raw capacity for that date (capacityOnDate), NOT
  // `day.capacity - day.totalHours` -- so it never gets crowded out or
  // deferred by PM overhead, another fixed task, or flexible work
  // already sitting on that day. Stamping still adds into the SAME
  // shared `day.totalHours` the flexible loop reads afterward, so if two
  // fixed sessions (or a fixed session + PM overhead) really do add up
  // to more than the day's capacity, that overage is real and visible --
  // exactly the "honest overallocation instead of deferring" behavior
  // this phase exists for.
  for (const task of fixedQueue) {
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
        const dayCeiling = capacityOnDate(person, dateStr, holidaySet, availability);
        if (!day) {
          day = { capacity: dayCeiling, pmHours: new Map(), taskHours: new Map(), totalHours: 0 };
          perDay.set(dateStr, day);
        }
        if (dayCeiling > 0) {
          const consume = Math.min(dayCeiling, remaining);
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

  for (const task of flexQueue) {
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
