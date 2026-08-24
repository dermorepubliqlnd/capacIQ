import { Fragment, useEffect, useMemo, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight, ChevronDown, Minus, Circle, CheckCircle2, TrendingUp, Gauge, AlertTriangle } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { TASK_STATUS_GROUPED, statusGroupOf } from "../lib/notionOptions";
import { buildHolidaySet } from "../lib/workingDays";
import {
  PROJECT_PM_DAILY_HOURS,
  buildForwardSchedule,
  type SchedTaskRow,
  type SchedProjectRow,
  type SchedAvailabilityRow,
} from "../lib/capacityScheduler";
import { tierOf, UTIL_LEGEND } from "../lib/utilizationBands";

interface PersonRow {
  id: string;
  name: string;
  daily_capacity_hours: number;
  is_active: boolean;
}
interface ProjectRow {
  id: string;
  name: string;
  owner_id: string | null;
  start_date: string | null;
  end_date: string | null;
  // Optional (2026-08-24): threaded into SchedProjectRow so the forward
  // scheduler can give already-baselined work precedence over Draft
  // projects, same as WBS Planning -- see capacityScheduler.ts's
  // SchedProjectRow for the rationale.
  wbs_status?: string | null;
}
interface TaskRow {
  id: string;
  project_id: string;
  parent_task_id: string | null;
  name: string;
  assignee_id: string | null;
  status: string | null;
  start_date: string | null;
  current_due_date: string;
  estimated_hours: number | null;
  is_archived: boolean;
  sort_order: number | null;
  work_type_id: string | null;
}
interface AvailabilityRow {
  id: string;
  person_id: string;
  date: string;
  status: "off" | "half_day";
}
interface HolidayRow {
  id: string;
  date: string;
  name: string;
  category: "legal_ph" | "local" | "internal";
}
// Ownership/assignment history (2026-08-14): a transfer should freeze
// everything already elapsed under the ORIGINAL owner/assignee, only
// shifting future days to the new one. Mirrors supabase/policies.sql
// "Migration 2026-08-14b" and src/lib/utilizationCalc.ts's own shape.
interface OwnerHistoryRow {
  project_id: string;
  person_id: string;
  effective_from: string;
  effective_to: string | null;
}
interface AssigneeHistoryRow {
  task_id: string;
  person_id: string;
  effective_from: string;
  effective_to: string | null;
}
// Deletion history archive (2026-08-14c, hours-native since Phase 2
// 2026-08-20): when a task/project is permanently deleted, its
// already-elapsed Utilization hours are archived (supabase/policies.sql
// "Migration 2026-08-14c", table shape updated by the Phase 2 migration)
// as raw per-person-per-day numbers before the row disappears --
// deliberately no task/project name retained ("just the numbers", Sandra's
// explicit choice for this scope).
interface DeletedHourRow {
  person_id: string;
  date: string;
  hours: number;
}

// Same local-timezone date helpers used everywhere else in the app — never
// `new Date("YYYY-MM-DD")` directly (parses as UTC midnight, can shift a
// day in negative-UTC timezones).
function toISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function startOfWeek(d: Date): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = r.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(r, diff);
}
function parseLocalDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}
const WEEKDAY_LABEL = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const RANGE_OPTIONS = [1, 2, 4] as const;
// Scaled up ~1.25x from the original 46/220 for a roomier grid — keep
// these two in lockstep with the same constants in DayPlanner.tsx so the
// two grids stay visually matched.
const CELL_W = 58;
const LABEL_W = 275;
// Weekly-mode columns need more room than a daily cell (two lines: avg %
// and a "planned / available" hours summary underneath).
const WEEK_CELL_W = 108;

// Icon per band tier -- utilizationBands.ts intentionally stays decoupled
// from any icon library (see its own header comment), so the key->icon
// mapping lives here instead.
const TIER_ICONS: Record<string, typeof Minus> = {
  unallocated: Minus,
  available: Circle,
  healthy: CheckCircle2,
  high: TrendingUp,
  full: Gauge,
  overloaded: AlertTriangle,
};
const LEGEND_ICON_BY_LABEL: Record<string, typeof Minus> = {
  Unallocated: Minus,
  Available: Circle,
  Healthy: CheckCircle2,
  High: TrendingUp,
  Full: Gauge,
  Overloaded: AlertTriangle,
};

function rollupCellStyle(i: number): CSSProperties {
  return {
    width: CELL_W,
    minWidth: CELL_W,
    textAlign: "center",
    padding: "9px 3px",
    borderBottom: "1px solid var(--border)",
    borderLeft: i % 7 === 0 ? "1px solid var(--border)" : undefined,
  };
}
function subCellStyle(i: number): CSSProperties {
  return {
    width: CELL_W,
    minWidth: CELL_W,
    textAlign: "center",
    padding: "5px 3px",
    borderBottom: "1px solid var(--border)",
    borderLeft: i % 7 === 0 ? "1px solid var(--border)" : undefined,
  };
}
function rollupWeekCellStyle(wi: number): CSSProperties {
  return {
    width: WEEK_CELL_W,
    minWidth: WEEK_CELL_W,
    textAlign: "center",
    padding: "9px 3px",
    borderBottom: "1px solid var(--border)",
    borderLeft: wi === 0 ? undefined : "1px solid var(--border)",
  };
}
function subWeekCellStyle(wi: number): CSSProperties {
  return {
    width: WEEK_CELL_W,
    minWidth: WEEK_CELL_W,
    textAlign: "center",
    padding: "5px 3px",
    borderBottom: "1px solid var(--border)",
    borderLeft: wi === 0 ? undefined : "1px solid var(--border)",
  };
}

// Every open task's Planned Effort Hours are spread evenly across its own
// Mon-Fri working days between start and due date (fallback: the due date
// itself, if that window is entirely a weekend) -- this is what makes the
// grid date-aware instead of lumping a task's whole effort into every day.
// Used for PAST dates only (see capacityScheduler.ts's buildForwardSchedule
// for today-and-future).
function taskWorkingDays(t: TaskRow): string[] {
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

// A project's own working-day window, for PM-overhead hours -- unlike
// tasks there's no due-date fallback: a project with no start/end date set
// simply doesn't contribute PM hours yet (same "set your dates" nudge used
// everywhere else in the app).
function projectWorkingDays(p: ProjectRow): string[] {
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

export default function Utilization() {
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [availability, setAvailability] = useState<AvailabilityRow[]>([]);
  const [holidays, setHolidays] = useState<HolidayRow[]>([]);
  const [workTypes, setWorkTypes] = useState<{ id: string; is_fixed_schedule: boolean }[]>([]);
  const [ownerHistory, setOwnerHistory] = useState<OwnerHistoryRow[]>([]);
  const [assigneeHistory, setAssigneeHistory] = useState<AssigneeHistoryRow[]>([]);
  const [deletedHours, setDeletedHours] = useState<DeletedHourRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Phase 8 (2026-08-21): Sandra -- "the current view is locked on a show
  // option and isn't flawless... default should always be 4 weeks from
  // today's date, with the option to scroll further back and forth. We
  // can back-track dates as far as Jan 2026 only, not locked into a
  // certain x-week timeframe." Anchor is now literally today (not the
  // Monday of the current week -- that snap was the "locked" feeling),
  // default range is 4 weeks, and backward navigation is clamped so you
  // can never scroll earlier than 2026-01-01.
  const [weekOffset, setWeekOffset] = useState(0);
  const [rangeWeeks, setRangeWeeks] = useState<(typeof RANGE_OPTIONS)[number]>(4);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<"daily" | "weekly">("daily");
  // Phase 7 (2026-08-21): Sandra's ask -- Capacity-Based smoothing spreads
  // overflow hours into future free days specifically so a person rarely
  // shows over 100%, which was quietly hiding real over-allocation and
  // costing her the evidence to argue for more headcount when the team is
  // genuinely over-utilized. "Actual" (the new default, relabeled from
  // "Realistic" 2026-08-24 to match the WBS Planning snapshot's own
  // Actual/Full Effort/Capacity-Based/Manual vocabulary) shows the raw
  // planned/estimated hours against each day's actual window with no
  // capacity ceiling -- the same uncapped math already used for past
  // dates -- for every date, past and future. "Capacity-Based" (relabeled
  // from "Capacity-Smoothed") keeps the original forward-scheduler view
  // for anyone who wants to see the deferred/idealized plan instead --
  // same underlying buildForwardSchedule engine WBS Planning's own
  // Capacity-Based mode uses, so the name now actually matches what it
  // computes.
  const [smoothed, setSmoothed] = useState(false);

  async function loadAll() {
    setLoading(true);
    const [{ data: p }, { data: pr }, { data: tk }, { data: av }, { data: hol }, { data: wts }, { data: ownHist }, { data: assHist }, { data: delHrs }, { data: settings }] = await Promise.all([
      supabase.from("people").select("id,name,daily_capacity_hours,is_active").eq("is_active", true).order("name"),
      supabase.from("projects").select("id,name,owner_id,start_date,end_date,wbs_status").eq("is_archived", false),
      supabase.from("tasks").select("id,project_id,parent_task_id,name,assignee_id,status,start_date,current_due_date,estimated_hours,is_archived,sort_order,work_type_id").eq("is_archived", false),
      supabase.from("person_availability").select("*"),
      supabase.from("holidays").select("*"),
      supabase.from("work_types").select("id,is_fixed_schedule"),
      supabase.from("project_owner_history").select("project_id,person_id,effective_from,effective_to"),
      supabase.from("task_assignee_history").select("task_id,person_id,effective_from,effective_to"),
      supabase.from("deleted_person_day_hours").select("person_id,date,hours"),
      supabase.from("app_settings").select("historical_locking_enabled").eq("id", true).single(),
    ]);
    setPeople((p as PersonRow[]) ?? []);
    setProjects((pr as ProjectRow[]) ?? []);
    setTasks((tk as TaskRow[]) ?? []);
    setAvailability((av as AvailabilityRow[]) ?? []);
    setHolidays((hol as HolidayRow[]) ?? []);
    setWorkTypes((wts as { id: string; is_fixed_schedule: boolean }[]) ?? []);
    // Sandra, 2026-08-14: "we're still playing around with the system" --
    // a global off switch (app_settings.historical_locking_enabled,
    // default false) for freezing past ownership/assignee attribution.
    // While off, leave these empty so ownerMatchesOnDate/
    // assigneeMatchesOnDate fall back to each project/task's CURRENT
    // owner_id/assignee_id everywhere below (their pre-history behavior).
    const historicalLockingEnabled = (settings as { historical_locking_enabled?: boolean } | null)?.historical_locking_enabled ?? false;
    setOwnerHistory(historicalLockingEnabled ? (ownHist as OwnerHistoryRow[]) ?? [] : []);
    setAssigneeHistory(historicalLockingEnabled ? (assHist as AssigneeHistoryRow[]) ?? [] : []);
    setDeletedHours((delHrs as DeletedHourRow[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    loadAll();
  }, []);

  // Earliest anchor date is fixed (Sandra: "we can back-track dates as
  // far as Jan 2026 only") -- clamp any backward navigation so the
  // visible window never starts before it.
  const EARLIEST_ANCHOR = useMemo(() => new Date(2026, 0, 1), []);
  const todayRaw = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);
  const minWeekOffset = useMemo(
    () => Math.ceil((EARLIEST_ANCHOR.getTime() - todayRaw.getTime()) / (7 * 24 * 60 * 60 * 1000)),
    [EARLIEST_ANCHOR, todayRaw]
  );
  function clampWeekOffset(next: number): number {
    return Math.max(next, minWeekOffset);
  }

  const days = useMemo(() => {
    const base = addDays(todayRaw, weekOffset * 7);
    return Array.from({ length: rangeWeeks * 7 }, (_, i) => addDays(base, i));
  }, [weekOffset, rangeWeeks, todayRaw]);

  function jumpToDate(dateStr: string) {
    if (!dateStr) return;
    const [y, m, d] = dateStr.split("-").map(Number);
    const chosen = new Date(y, (m ?? 1) - 1, d ?? 1);
    const diffWeeks = Math.round((chosen.getTime() - todayRaw.getTime()) / (7 * 24 * 60 * 60 * 1000));
    setWeekOffset(clampWeekOffset(diffWeeks));
  }
  const weeks: Date[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));

  const holidayByDate = useMemo(() => {
    const m = new Map<string, HolidayRow>();
    holidays.forEach((h) => m.set(h.date, h));
    return m;
  }, [holidays]);

  const holidaySet = useMemo(() => buildHolidaySet(holidays.map((h) => h.date)), [holidays]);
  const today = useMemo(() => toISO(new Date()), []);

  function availabilityFor(personId: string, dateStr: string): AvailabilityRow | undefined {
    return availability.find((a) => a.person_id === personId && a.date === dateStr);
  }
  function dayBlocked(personId: string, dateStr: string, dow: number): "holiday" | "off" | "weekend" | null {
    if (dow === 0 || dow === 6) return "weekend";
    if (holidayByDate.has(dateStr)) return "holiday";
    if (availabilityFor(personId, dateStr)?.status === "off") return "off";
    return null;
  }

  // 2026-07-28: parent tasks (tasks with their own sub-tasks) are excluded
  // from utilization hours -- a parent's own span/hours are already just a
  // rollup of its children (see WBS Planning's parentAssigneeState / the
  // Effort "N/A" treatment for parents), so counting a parent's own
  // Estimated Hours+Assignee here on top of its children's would
  // double-count whoever it's assigned to. `parentTaskIds` is every id
  // that appears as some other task's own parent_task_id.
  const parentTaskIds = new Set(tasks.filter((t) => t.parent_task_id).map((t) => t.parent_task_id as string));
  // "Ever associated" -- 2026-08-14: a person's expandable sub-rows now
  // list every task/project their history shows they EVER held, not just
  // whoever currently holds it. Each sub-row's own per-date value is then
  // gated by history too (assigneeMatchesOnDate/ownerMatchesOnDate below),
  // so a transferred task/project correctly shows nonzero only across the
  // date range this specific person actually held it -- the old assignee's
  // sub-row goes to 0 the day it moves on, the new assignee's sub-row
  // starts contributing from that same day, and the two together always
  // sum to the task/project's real total (no double-count, no gap). This
  // history-aware attribution only applies to PAST dates -- see
  // buildForwardSchedule's own current-assignee-only filtering for today
  // and future dates.
  function historicalOwnerIds(projectId: string): Set<string> {
    return new Set(ownerHistory.filter((h) => h.project_id === projectId).map((h) => h.person_id));
  }
  function historicalAssigneeIds(taskId: string): Set<string> {
    return new Set(assigneeHistory.filter((h) => h.task_id === taskId).map((h) => h.person_id));
  }
  function ownerMatchesOnDate(p: ProjectRow, personId: string, dateStr: string): boolean {
    const rows = ownerHistory.filter((h) => h.project_id === p.id);
    if (rows.length === 0) return p.owner_id === personId;
    return rows.some((h) => h.person_id === personId && h.effective_from <= dateStr && (h.effective_to === null || h.effective_to >= dateStr));
  }
  function assigneeMatchesOnDate(t: TaskRow, personId: string, dateStr: string): boolean {
    const rows = assigneeHistory.filter((h) => h.task_id === t.id);
    if (rows.length === 0) return t.assignee_id === personId;
    return rows.some((h) => h.person_id === personId && h.effective_from <= dateStr && (h.effective_to === null || h.effective_to >= dateStr));
  }

  // Deletion archive: folds archived hours from permanently-deleted
  // tasks/projects into a person's daily total, and flags whether they
  // have any at all (to show the generic "Deleted items" sub-row below --
  // generic because no task/project name was retained for these).
  function deletedHoursFor(personId: string, dateStr: string): number {
    return deletedHours.filter((d) => d.person_id === personId && d.date === dateStr).reduce((sum, d) => sum + Number(d.hours), 0);
  }
  function hasDeletedHistory(personId: string): boolean {
    return deletedHours.some((d) => d.person_id === personId);
  }

  function openTasksFor(personId: string): TaskRow[] {
    return tasks.filter(
      (t) =>
        (t.assignee_id === personId || historicalAssigneeIds(t.id).has(personId)) &&
        !parentTaskIds.has(t.id) &&
        statusGroupOf(TASK_STATUS_GROUPED, t.status) !== "complete"
    );
  }
  function ownedProjectsFor(personId: string): ProjectRow[] {
    return projects.filter((p) => p.owner_id === personId || historicalOwnerIds(p.id).has(personId));
  }

  // A task's hours on a specific PAST date for a specific person -- 0 if
  // that date isn't one of the task's own working days (out of window, or
  // hours not set yet), OR if history says this person didn't actually
  // hold the assignment on that specific date (post-transfer split).
  function taskHoursOnDate(t: TaskRow, dateStr: string, forPersonId?: string): number {
    const hours = t.estimated_hours ?? 0;
    if (hours === 0) return 0;
    const workingDays = taskWorkingDays(t);
    if (!workingDays.includes(dateStr)) return 0;
    if (forPersonId && !assigneeMatchesOnDate(t, forPersonId, dateStr)) return 0;
    return hours / workingDays.length;
  }

  // PM-overhead hours for everything a person owns on a given PAST date.
  // Phase 2 (2026-08-20): unifies what used to be two separate mechanisms
  // (Day Planner's manual 0.5h/day default, and this page's old
  // points-based combined-cap model) into one flat allowance -- each owned
  // project gets PROJECT_PM_DAILY_HOURS/day on its own working days, with
  // NO combined cap across projects. "Owns" is evaluated per-date via
  // history, not the project's current owner_id, so a transferred
  // project's PM overhead splits correctly across the handoff date instead
  // of retroactively moving in full.
  function pmHoursFor(personId: string, dateStr: string): { total: number; perProject: Map<string, number> } {
    const owned = ownedProjectsFor(personId).filter((p) => ownerMatchesOnDate(p, personId, dateStr) && projectWorkingDays(p).includes(dateStr));
    const perProject = new Map(owned.map((p) => [p.id, PROJECT_PM_DAILY_HOURS]));
    return { total: owned.length * PROJECT_PM_DAILY_HOURS, perProject };
  }

  function dailyHoursFor(personId: string, dateStr: string): number {
    const taskHours = openTasksFor(personId).reduce((sum, t) => sum + taskHoursOnDate(t, dateStr, personId), 0);
    return taskHours + pmHoursFor(personId, dateStr).total + deletedHoursFor(personId, dateStr);
  }

  function dailyCapacityFor(person: PersonRow, halfDay: boolean): number {
    return person.daily_capacity_hours * (halfDay ? 0.5 : 1);
  }

  // Phase 2: today-and-future days route through the new capacity-aware
  // forward scheduler instead of the even-split calc above -- one schedule
  // built per person, memoized, covering `today` through a full year out
  // (maxDaysGuard) so a queued-up task's projected due date resolves even
  // if it falls past the currently-visible week range.
  const isCompleteStatus = (status: string | null) => statusGroupOf(TASK_STATUS_GROUPED, status) === "complete";
  const schedulesByPerson = useMemo(() => {
    const fixedWorkTypeIds = new Set(workTypes.filter((w) => w.is_fixed_schedule).map((w) => w.id));
    const schedTasks: SchedTaskRow[] = tasks.map((t) => ({
      id: t.id,
      project_id: t.project_id,
      parent_task_id: t.parent_task_id,
      assignee_id: t.assignee_id,
      status: t.status,
      start_date: t.start_date,
      current_due_date: t.current_due_date,
      estimated_hours: t.estimated_hours,
      sort_order: t.sort_order,
      is_fixed_schedule: !!t.work_type_id && fixedWorkTypeIds.has(t.work_type_id),
    }));
    const schedProjects: SchedProjectRow[] = projects.map((p) => ({ id: p.id, owner_id: p.owner_id, start_date: p.start_date, end_date: p.end_date, wbs_status: p.wbs_status }));
    const schedAvailability: SchedAvailabilityRow[] = availability.map((a) => ({ person_id: a.person_id, date: a.date, status: a.status }));
    const map = new Map<string, ReturnType<typeof buildForwardSchedule>>();
    people.forEach((person) => {
      map.set(
        person.id,
        buildForwardSchedule({
          personId: person.id,
          fromDateStr: today,
          tasks: schedTasks,
          parentTaskIds,
          isCompleteStatus,
          projects: schedProjects,
          person: { id: person.id, daily_capacity_hours: person.daily_capacity_hours },
          holidaySet,
          availability: schedAvailability,
          maxDaysGuard: 365,
        })
      );
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [people, tasks, projects, availability, holidaySet, today, workTypes]);

  // Single source of truth for a rollup cell's numeric hours value, for
  // BOTH the daily grid and the weekly aggregation below -- past dates use
  // the even-split calc, today/future dates read the forward schedule.
  function valueForDate(person: PersonRow, dateStr: string): number {
    if (dateStr < today || !smoothed) return dailyHoursFor(person.id, dateStr);
    return schedulesByPerson.get(person.id)?.perDay.get(dateStr)?.totalHours ?? 0;
  }
  function pmValueForDate(person: PersonRow, projectId: string, dateStr: string): number {
    if (dateStr < today || !smoothed) return pmHoursFor(person.id, dateStr).perProject.get(projectId) ?? 0;
    return schedulesByPerson.get(person.id)?.perDay.get(dateStr)?.pmHours.get(projectId) ?? 0;
  }
  function taskValueForDate(person: PersonRow, t: TaskRow, dateStr: string): number {
    if (dateStr < today || !smoothed) return taskHoursOnDate(t, dateStr, person.id);
    return schedulesByPerson.get(person.id)?.perDay.get(dateStr)?.taskHours.get(t.id) ?? 0;
  }

  interface WeekStats {
    avgPct: number;
    plannedHours: number;
    availableHours: number;
    peakPct: number;
    overloadedDays: number;
    workingDaysCount: number;
  }
  function weekStatsForPerson(person: PersonRow, week: Date[]): WeekStats {
    let workingDaysCount = 0;
    let plannedHours = 0;
    let availableHours = 0;
    let peakPct = 0;
    let overloadedDays = 0;
    let pctSum = 0;
    week.forEach((d) => {
      const dateStr = toISO(d);
      const dow = d.getDay();
      if (dayBlocked(person.id, dateStr, dow)) return;
      const av = availabilityFor(person.id, dateStr);
      const capacity = dailyCapacityFor(person, av?.status === "half_day");
      const value = valueForDate(person, dateStr);
      const pct = capacity > 0 ? (value / capacity) * 100 : value > 0 ? 999 : 0;
      workingDaysCount++;
      plannedHours += value;
      availableHours += capacity;
      pctSum += pct;
      if (pct > peakPct) peakPct = pct;
      if (pct > 100) overloadedDays++;
    });
    return {
      avgPct: workingDaysCount > 0 ? pctSum / workingDaysCount : 0,
      plannedHours,
      availableHours,
      peakPct,
      overloadedDays,
      workingDaysCount,
    };
  }
  function weekSum(week: Date[], getValue: (dateStr: string) => number): number {
    return week.reduce((sum, d) => sum + getValue(toISO(d)), 0);
  }

  const columnCount = viewMode === "daily" ? days.length : weeks.length;

  return (
    <div>
      <h1>Utilization</h1>
      <p className="subtitle">
        Same grid as the Day Planner, but auto-computed: each task's Planned Effort Hours are spread across its own start-to-due window
        for past dates, and queue for real daily capacity (routing around a person's other work) from today forward, plus a small
        project-ownership allowance. Set effort hours and dates on tasks in Projects &amp; Tasks — this view updates automatically.
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        <button
          onClick={() => setWeekOffset((w) => clampWeekOffset(w - rangeWeeks))}
          className="planner-nav-btn"
          disabled={weekOffset <= minWeekOffset}
          title={weekOffset <= minWeekOffset ? "Can't go earlier than Jan 2026" : `Previous ${rangeWeeks} week${rangeWeeks > 1 ? "s" : ""}`}
          style={weekOffset <= minWeekOffset ? { opacity: 0.4, cursor: "default" } : undefined}
        >
          <ChevronLeft size={14} />
        </button>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--navy)", minWidth: 150 }}>
          {days[0].toLocaleDateString("en-US", { month: "short", day: "numeric" })} –{" "}
          {days[days.length - 1].toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
        </span>
        <button onClick={() => setWeekOffset((w) => w + rangeWeeks)} className="planner-nav-btn" title={`Next ${rangeWeeks} week${rangeWeeks > 1 ? "s" : ""}`}>
          <ChevronRight size={14} />
        </button>
        {weekOffset !== 0 && (
          <button
            onClick={() => setWeekOffset(0)}
            style={{ fontSize: 11, color: "var(--accent)", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}
          >
            Today
          </button>
        )}

        <div style={{ width: 1, height: 18, background: "var(--border)" }} />

        <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--muted)" }}>
          Show
          <select
            value={rangeWeeks}
            onChange={(e) => setRangeWeeks(Number(e.target.value) as (typeof RANGE_OPTIONS)[number])}
            style={{ fontSize: 11, fontWeight: 600, color: "var(--navy)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "3px 6px" }}
          >
            {RANGE_OPTIONS.map((w) => (
              <option key={w} value={w}>
                {w} week{w > 1 ? "s" : ""}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--muted)" }}>
          Jump to
          <input
            type="date"
            min="2026-01-01"
            onChange={(e) => jumpToDate(e.target.value)}
            style={{ fontSize: 11, color: "var(--navy)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "3px 6px" }}
          />
        </label>

        <div style={{ width: 1, height: 18, background: "var(--border)" }} />

        <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
          {(["daily", "weekly"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              style={{
                fontSize: 11,
                fontWeight: 600,
                textTransform: "capitalize",
                padding: "4px 10px",
                border: "none",
                cursor: "pointer",
                background: viewMode === mode ? "var(--accent)" : "transparent",
                color: viewMode === mode ? "#fff" : "var(--muted)",
              }}
            >
              {mode}
            </button>
          ))}
        </div>

        <div style={{ width: 1, height: 18, background: "var(--border)" }} />

        <div
          style={{ display: "flex", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}
          title={
            smoothed
              ? "Capacity-Based: overflow hours are deferred into future free days -- rarely shows over 100%."
              : "Actual: raw planned hours against each day's actual window, no capacity ceiling -- shows true over-allocation."
          }
        >
          {([false, true] as const).map((isSmoothed) => (
            <button
              key={String(isSmoothed)}
              onClick={() => setSmoothed(isSmoothed)}
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: "4px 10px",
                border: "none",
                cursor: "pointer",
                background: smoothed === isSmoothed ? "var(--accent)" : "transparent",
                color: smoothed === isSmoothed ? "#fff" : "var(--muted)",
              }}
            >
              {isSmoothed ? "Capacity-Based" : "Actual"}
            </button>
          ))}
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflowX: "auto", overflowY: "visible" }}>
        {loading ? (
          <div style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>Loading…</div>
        ) : (
          <table style={{ borderCollapse: "collapse", width: "max-content" }}>
            <thead>
              <tr>
                <th
                  style={{
                    position: "sticky",
                    left: 0,
                    zIndex: 2,
                    background: "var(--surface)",
                    width: LABEL_W,
                    minWidth: LABEL_W,
                    borderBottom: "1px solid var(--border)",
                  }}
                />
                {viewMode === "daily"
                  ? weeks.map((week, wi) => (
                      <th
                        key={wi}
                        colSpan={7}
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: "var(--muted)",
                          textTransform: "uppercase",
                          letterSpacing: 0.3,
                          padding: "8px 5px",
                          borderBottom: "1px solid var(--border)",
                          borderLeft: "1px solid var(--border)",
                        }}
                      >
                        Week of {week[0].toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      </th>
                    ))
                  : weeks.map((week, wi) => (
                      <th
                        key={wi}
                        style={{
                          width: WEEK_CELL_W,
                          minWidth: WEEK_CELL_W,
                          fontSize: 11,
                          fontWeight: 600,
                          color: "var(--navy)",
                          padding: "8px 5px",
                          borderBottom: "1px solid var(--border)",
                          borderLeft: wi === 0 ? undefined : "1px solid var(--border)",
                        }}
                      >
                        {week[0].toLocaleDateString("en-US", { month: "short", day: "numeric" })} –{" "}
                        {week[6].toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      </th>
                    ))}
              </tr>
              {viewMode === "daily" && (
                <tr>
                  <th
                    style={{
                      position: "sticky",
                      left: 0,
                      zIndex: 2,
                      background: "var(--surface)",
                      width: LABEL_W,
                      minWidth: LABEL_W,
                      borderBottom: "1px solid var(--border)",
                      textAlign: "left",
                      padding: "5px 13px",
                      fontSize: 13,
                      color: "var(--muted)",
                    }}
                  >
                    Person
                  </th>
                  {days.map((d, i) => {
                    const dow = d.getDay();
                    const weekend = dow === 0 || dow === 6;
                    return (
                      <th
                        key={i}
                        style={{
                          width: CELL_W,
                          minWidth: CELL_W,
                          padding: "5px 3px",
                          fontSize: 12,
                          fontWeight: 600,
                          color: weekend ? "var(--muted)" : "var(--navy)",
                          background: weekend ? "var(--hover-bg)" : undefined,
                          borderBottom: "1px solid var(--border)",
                          borderLeft: i % 7 === 0 ? "1px solid var(--border)" : undefined,
                        }}
                      >
                        {WEEKDAY_LABEL[dow]} {d.getDate()}
                      </th>
                    );
                  })}
                </tr>
              )}
              {viewMode === "weekly" && (
                <tr>
                  <th
                    style={{
                      position: "sticky",
                      left: 0,
                      zIndex: 2,
                      background: "var(--surface)",
                      width: LABEL_W,
                      minWidth: LABEL_W,
                      borderBottom: "1px solid var(--border)",
                      textAlign: "left",
                      padding: "5px 13px",
                      fontSize: 13,
                      color: "var(--muted)",
                    }}
                  >
                    Person
                  </th>
                  {weeks.map((_, wi) => (
                    <th key={wi} style={{ borderBottom: "1px solid var(--border)", borderLeft: wi === 0 ? undefined : "1px solid var(--border)" }} />
                  ))}
                </tr>
              )}
            </thead>
            <tbody>
              {people.length === 0 ? (
                <tr>
                  <td colSpan={1 + columnCount} style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>
                    No active people found.
                  </td>
                </tr>
              ) : (
                people.map((person) => {
                  const isExpanded = expanded.includes(person.id);
                  const ownedProjects = ownedProjectsFor(person.id);
                  const assignedTasks = openTasksFor(person.id);
                  return (
                    <Fragment key={person.id}>
                      <tr style={{ background: "#fafbfc" }}>
                        <td
                          style={{
                            position: "sticky",
                            left: 0,
                            zIndex: 1,
                            background: "#fafbfc",
                            padding: "8px 13px",
                            fontSize: 12,
                            fontWeight: 600,
                            color: "var(--navy)",
                            borderBottom: "1px solid var(--border)",
                            cursor: "pointer",
                            whiteSpace: "nowrap",
                          }}
                          onClick={() => setExpanded((prev) => (isExpanded ? prev.filter((id) => id !== person.id) : [...prev, person.id]))}
                        >
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                            {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                            {person.name}
                          </span>
                        </td>
                        {viewMode === "daily"
                          ? days.map((d, i) => {
                              const dateStr = toISO(d);
                              const dow = d.getDay();
                              const blocked = dayBlocked(person.id, dateStr, dow);

                              if (blocked === "holiday") {
                                const h = holidayByDate.get(dateStr)!;
                                return (
                                  <td key={i} title={h.name} style={{ ...rollupCellStyle(i), background: "#eef1f5", color: "var(--muted)", fontSize: 11, fontWeight: 600 }}>
                                    Holiday
                                  </td>
                                );
                              }
                              if (blocked === "weekend") {
                                return <td key={i} style={{ ...rollupCellStyle(i), background: "var(--hover-bg)" }} />;
                              }
                              const av = availabilityFor(person.id, dateStr);
                              if (blocked === "off") {
                                return (
                                  <td key={i} style={{ ...rollupCellStyle(i), background: "#f1f2f4", color: "var(--muted)", fontSize: 12, fontWeight: 600 }}>
                                    Off
                                  </td>
                                );
                              }
                              const value = valueForDate(person, dateStr);
                              const capacity = dailyCapacityFor(person, av?.status === "half_day");
                              const pct = capacity > 0 ? (value / capacity) * 100 : value > 0 ? 999 : 0;
                              const tier = tierOf(pct);
                              const Icon = TIER_ICONS[tier.key] ?? Minus;
                              return (
                                <td
                                  key={i}
                                  style={{
                                    ...rollupCellStyle(i),
                                    background: tier.bg,
                                    color: tier.fg,
                                    fontSize: 12.5,
                                    fontWeight: 600,
                                  }}
                                  title={tier.label}
                                >
                                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                                    <Icon size={13} />
                                    <span>
                                      {tier.key === "unallocated" ? "–" : `${Math.round(pct)}%`}
                                      {av?.status === "half_day" && <span style={{ fontSize: 9, marginLeft: 2 }}>½</span>}
                                    </span>
                                  </div>
                                </td>
                              );
                            })
                          : weeks.map((week, wi) => {
                              const stats = weekStatsForPerson(person, week);
                              const tier = tierOf(stats.avgPct);
                              const Icon = TIER_ICONS[tier.key] ?? Minus;
                              const title =
                                stats.workingDaysCount === 0
                                  ? "No working days this week"
                                  : `${Math.round(stats.avgPct)}% ${tier.label} · Planned ${stats.plannedHours.toFixed(1)}h / ${stats.availableHours.toFixed(1)}h · Peak day ${Math.round(
                                      stats.peakPct
                                    )}% · Overloaded days: ${stats.overloadedDays}`;
                              return (
                                <td
                                  key={wi}
                                  style={{
                                    ...rollupWeekCellStyle(wi),
                                    background: stats.workingDaysCount === 0 ? undefined : tier.bg,
                                    color: stats.workingDaysCount === 0 ? "var(--muted)" : tier.fg,
                                    fontSize: 12.5,
                                    fontWeight: 600,
                                  }}
                                  title={title}
                                >
                                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                                    <Icon size={13} />
                                    <span>{stats.workingDaysCount === 0 ? "–" : `${Math.round(stats.avgPct)}%`}</span>
                                    <span style={{ fontSize: 9, fontWeight: 500, opacity: 0.75 }}>
                                      {stats.plannedHours.toFixed(1)}h / {stats.availableHours.toFixed(1)}h
                                    </span>
                                  </div>
                                </td>
                              );
                            })}
                      </tr>
                      {isExpanded &&
                        (ownedProjects.length === 0 && assignedTasks.length === 0 && !hasDeletedHistory(person.id) ? (
                          <tr>
                            <td
                              style={{
                                position: "sticky",
                                left: 0,
                                background: "var(--surface)",
                                padding: "5px 13px 5px 35px",
                                fontSize: 11,
                                color: "var(--muted)",
                                borderBottom: "1px solid var(--border)",
                              }}
                            >
                              No owned projects or assigned tasks.
                            </td>
                            {viewMode === "daily"
                              ? days.map((_, i) => <td key={i} style={subCellStyle(i)} />)
                              : weeks.map((_, wi) => <td key={wi} style={subWeekCellStyle(wi)} />)}
                          </tr>
                        ) : (
                          <>
                            {ownedProjects.map((p) => {
                              const workingDays = projectWorkingDays(p);
                              return (
                                <tr key={`pm-${p.id}`}>
                                  <td
                                    title={workingDays.length === 0 ? `${p.name} — set start/due dates to count project-management time` : `${p.name} — project management`}
                                    style={{
                                      position: "sticky",
                                      left: 0,
                                      zIndex: 1,
                                      background: "var(--surface)",
                                      padding: "5px 13px 5px 35px",
                                      fontSize: 11,
                                      color: "var(--text-secondary)",
                                      borderBottom: "1px solid var(--border)",
                                      whiteSpace: "nowrap",
                                      maxWidth: LABEL_W,
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                    }}
                                  >
                                    {p.name}
                                    <span style={{ fontSize: 9.5, fontWeight: 600, color: "var(--muted)", marginLeft: 6 }}>(PM)</span>
                                  </td>
                                  {viewMode === "daily"
                                    ? days.map((d, i) => {
                                        const dateStr = toISO(d);
                                        const dow = d.getDay();
                                        const blocked = dayBlocked(person.id, dateStr, dow);
                                        const win = workingDays.includes(dateStr);
                                        const value = win ? pmValueForDate(person, p.id, dateStr) : 0;
                                        return (
                                          <td key={i} style={{ ...subCellStyle(i), background: blocked ? "var(--hover-bg)" : !win ? "#f7f8fa" : undefined, fontSize: 12, color: "var(--muted)" }}>
                                            {value > 0 ? value.toFixed(2) : ""}
                                          </td>
                                        );
                                      })
                                    : weeks.map((week, wi) => {
                                        const value = weekSum(week, (dateStr) => (workingDays.includes(dateStr) ? pmValueForDate(person, p.id, dateStr) : 0));
                                        return (
                                          <td key={wi} style={{ ...subWeekCellStyle(wi), fontSize: 12, color: "var(--muted)" }}>
                                            {value > 0 ? value.toFixed(2) : ""}
                                          </td>
                                        );
                                      })}
                                </tr>
                              );
                            })}
                            {assignedTasks.map((t) => {
                              const proj = projects.find((p) => p.id === t.project_id);
                              const workingDays = taskWorkingDays(t);
                              return (
                                <tr key={t.id}>
                                  <td
                                    title={!t.estimated_hours ? `${t.name} — no effort hours set yet` : t.name}
                                    style={{
                                      position: "sticky",
                                      left: 0,
                                      zIndex: 1,
                                      background: "var(--surface)",
                                      padding: "5px 13px 5px 35px",
                                      fontSize: 11,
                                      color: "var(--text-secondary)",
                                      borderBottom: "1px solid var(--border)",
                                      whiteSpace: "nowrap",
                                      maxWidth: LABEL_W,
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                    }}
                                  >
                                    {t.name}
                                    {proj && <span style={{ fontSize: 9.5, fontWeight: 600, color: "var(--muted)", marginLeft: 6 }}>{proj.name}</span>}
                                    {!t.estimated_hours && <span style={{ fontSize: 9.5, color: "var(--warning-text)", marginLeft: 6 }}>no effort</span>}
                                  </td>
                                  {viewMode === "daily"
                                    ? days.map((d, i) => {
                                        const dateStr = toISO(d);
                                        const dow = d.getDay();
                                        const blocked = dayBlocked(person.id, dateStr, dow);
                                        const win = dateStr >= today ? true : workingDays.includes(dateStr);
                                        const value = taskValueForDate(person, t, dateStr);
                                        return (
                                          <td key={i} style={{ ...subCellStyle(i), background: blocked ? "var(--hover-bg)" : !win ? "#f7f8fa" : undefined, fontSize: 12, color: "var(--muted)" }}>
                                            {value > 0 ? value.toFixed(1) : ""}
                                          </td>
                                        );
                                      })
                                    : weeks.map((week, wi) => {
                                        const value = weekSum(week, (dateStr) => taskValueForDate(person, t, dateStr));
                                        return (
                                          <td key={wi} style={{ ...subWeekCellStyle(wi), fontSize: 12, color: "var(--muted)" }}>
                                            {value > 0 ? value.toFixed(1) : ""}
                                          </td>
                                        );
                                      })}
                                </tr>
                              );
                            })}
                            {hasDeletedHistory(person.id) && (
                              <tr>
                                <td
                                  title="Hours from tasks/projects that have since been permanently deleted — numbers only, no name retained"
                                  style={{
                                    position: "sticky",
                                    left: 0,
                                    zIndex: 1,
                                    background: "var(--surface)",
                                    padding: "5px 13px 5px 35px",
                                    fontSize: 11,
                                    color: "var(--muted)",
                                    fontStyle: "italic",
                                    borderBottom: "1px solid var(--border)",
                                    whiteSpace: "nowrap",
                                    maxWidth: LABEL_W,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                  }}
                                >
                                  Deleted items
                                </td>
                                {viewMode === "daily"
                                  ? days.map((d, i) => {
                                      const dateStr = toISO(d);
                                      const dow = d.getDay();
                                      const blocked = dayBlocked(person.id, dateStr, dow);
                                      const value = deletedHoursFor(person.id, dateStr);
                                      return (
                                        <td key={i} style={{ ...subCellStyle(i), background: blocked ? "var(--hover-bg)" : undefined, fontSize: 12, color: "var(--muted)" }}>
                                          {value > 0 ? value.toFixed(2) : ""}
                                        </td>
                                      );
                                    })
                                  : weeks.map((week, wi) => {
                                      const value = weekSum(week, (dateStr) => deletedHoursFor(person.id, dateStr));
                                      return (
                                        <td key={wi} style={{ ...subWeekCellStyle(wi), fontSize: 12, color: "var(--muted)" }}>
                                          {value > 0 ? value.toFixed(2) : ""}
                                        </td>
                                      );
                                    })}
                              </tr>
                            )}
                          </>
                        ))}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 12, alignItems: "center" }}>
        {UTIL_LEGEND.map(({ pct, label, tone }) => {
          const Icon = LEGEND_ICON_BY_LABEL[label] ?? Minus;
          return (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11 }}>
              <span className={`status-pill ${tone}`} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <Icon size={11} />
                {pct}
              </span>
              <span style={{ color: "var(--muted)" }}>{label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
