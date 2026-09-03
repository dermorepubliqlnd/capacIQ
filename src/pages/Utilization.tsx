import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight, ChevronDown, Minus, Circle, CheckCircle2, TrendingUp, Gauge, AlertTriangle } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { TASK_STATUS_GROUPED, statusGroupOf } from "../lib/notionOptions";
import { buildHolidaySet } from "../lib/workingDays";
// One shared allocation engine for all three utilization surfaces
// (this page, Scoped vs Logged, and WBS Planning's Utilization snapshot).
// See src/lib/dailyAllocation.ts for what used to be duplicated here.
import { createAllocationEngine, dailyCapacityHours, parentTaskIdsOf, type UtilTaskRow } from "../lib/dailyAllocation";
import { displayPct, tierOf, UTIL_LEGEND } from "../lib/utilizationBands";

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

// NOTE (2026-08-31): the local weekend-only `taskWorkingDays` /
// `projectWorkingDays` that used to live here are gone. They were
// holiday-blind and Time-Off-blind, so in the default "Actual" mode any hours
// that landed on a holiday or a person's Off day were silently deleted from
// the grid (those cells render "Holiday"/"Off" and never print a value) --
// one of the concrete "utilization disappeared" mechanisms. Both now come
// from src/lib/dailyAllocation.ts, shared with Scoped vs Logged and the WBS
// snapshot so all three spread the same hours over the same days.

export default function Utilization() {
  const [people, setPeople] = useState<PersonRow[]>([]);
  // Every person, active or not (2026-09-03) -- deactivated people's
  // past Utilization data was never deleted, it's just been hidden by
  // the active-only fetch below by default. showAllPeople lets Sandra
  // flip to seeing everyone, same toggle as HoursOverview.tsx.
  const [allPeople, setAllPeople] = useState<PersonRow[]>([]);
  const [showAllPeople, setShowAllPeople] = useState(false);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [availability, setAvailability] = useState<AvailabilityRow[]>([]);
  const [holidays, setHolidays] = useState<HolidayRow[]>([]);
  const [workTypes, setWorkTypes] = useState<{ id: string; is_fixed_schedule: boolean }[]>([]);
  const [ownerHistory, setOwnerHistory] = useState<OwnerHistoryRow[]>([]);
  const [assigneeHistory, setAssigneeHistory] = useState<AssigneeHistoryRow[]>([]);
  const [deletedHours, setDeletedHours] = useState<DeletedHourRow[]>([]);
  const [loading, setLoading] = useState(true);

  // 2026-09-03 (Sandra: default should be the current month, with date
  // filters instead of a week-count picker; drop the Capacity-Based mode
  // entirely -- "this makes no sense"). rangeStart/rangeEnd replace the
  // old weekOffset/rangeWeeks pair -- Prev/Next now shift by the exact
  // span currently shown (so a custom date-filtered range pages by its
  // own width, not a fixed week count), and the From/To inputs let Sandra
  // pick any window directly instead of jumping to a date and having a
  // fixed 1/2/4-week span built around it.
  const [rangeStart, setRangeStart] = useState<Date>(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [rangeEnd, setRangeEnd] = useState<Date>(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth() + 1, 0);
  });
  const [expanded, setExpanded] = useState<string[]>([]);
  const [viewMode, setViewMode] = useState<"daily" | "weekly">("daily");

  async function loadAll() {
    setLoading(true);
    const [{ data: p }, { data: ap }, { data: pr }, { data: tk }, { data: av }, { data: hol }, { data: wts }, { data: ownHist }, { data: assHist }, { data: delHrs }, { data: settings }] = await Promise.all([
      supabase.from("people").select("id,name,daily_capacity_hours,is_active").eq("is_active", true).order("name"),
      supabase.from("people").select("id,name,daily_capacity_hours,is_active").order("name"),
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
    setAllPeople((ap as PersonRow[]) ?? []);
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
  const days = useMemo(() => {
    const arr: Date[] = [];
    for (let d = new Date(rangeStart); d <= rangeEnd; d = addDays(d, 1)) arr.push(d);
    return arr;
  }, [rangeStart, rangeEnd]);

  // Shift the whole window backward/forward by its own current width (in
  // days) -- a custom-filtered range pages by its own size instead of an
  // unrelated fixed week count.
  function shiftRange(direction: -1 | 1) {
    const spanDays = Math.round((rangeEnd.getTime() - rangeStart.getTime()) / (24 * 60 * 60 * 1000)) + 1;
    setRangeStart((s) => addDays(s, direction * spanDays));
    setRangeEnd((e) => addDays(e, direction * spanDays));
  }
  function resetToCurrentMonth() {
    const d = new Date();
    setRangeStart(new Date(d.getFullYear(), d.getMonth(), 1));
    setRangeEnd(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  }
  function setRangeStartFromInput(dateStr: string) {
    if (!dateStr) return;
    const [y, m, d] = dateStr.split("-").map(Number);
    const chosen = new Date(y, (m ?? 1) - 1, d ?? 1);
    if (chosen <= rangeEnd) setRangeStart(chosen);
  }
  function setRangeEndFromInput(dateStr: string) {
    if (!dateStr) return;
    const [y, m, d] = dateStr.split("-").map(Number);
    const chosen = new Date(y, (m ?? 1) - 1, d ?? 1);
    if (chosen >= rangeStart) setRangeEnd(chosen);
  }
  const isAtEarliestAnchor = rangeStart <= EARLIEST_ANCHOR;

  const weeks: Date[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));

  // Auto-scroll-to-today (2026-08-25, same fix as WbsPlanning.tsx's
  // Utilization snapshot panel -- see that file's comment for the full
  // rationale). Today sits at the very START of this grid by design (the
  // Phase 8 windowing fix anchors weekOffset 0 to today, not a Monday-
  // snapped week), so at a narrower viewport/zoom it's the first thing
  // that can end up scrolled past with no visible cue. Scrolls today's
  // column (daily) or week (weekly) into view whenever it's part of the
  // currently-shown window.
  const utilScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = utilScrollRef.current;
    if (!el) return;
    const todayIso = toISO(todayRaw);
    let targetLeft: number | null = null;
    if (viewMode === "daily") {
      const idx = days.findIndex((d) => toISO(d) === todayIso);
      if (idx !== -1) targetLeft = LABEL_W + idx * CELL_W;
    } else {
      const weekIdx = weeks.findIndex((week) => week.some((d) => toISO(d) === todayIso));
      if (weekIdx !== -1) targetLeft = LABEL_W + weekIdx * WEEK_CELL_W;
    }
    if (targetLeft === null) return;
    const colW = viewMode === "daily" ? CELL_W : WEEK_CELL_W;
    // Bugfix (2026-08-26, same class of issue as WbsPlanning.tsx's
    // Utilization snapshot panel -- see that file's comment): only
    // scroll if today's column isn't already fully visible at the
    // current position, instead of unconditionally re-centering every
    // time (which would hide this grid's own leftmost column whenever
    // today isn't already visible there, e.g. after paging weekOffset).
    //
    // Round 2 (2026-08-26, Sandra: a date column's own header text was
    // visibly clipped at 90% zoom, not just scrolled out of view): LABEL_W
    // is a STICKY overlay that always occupies the viewport's first
    // LABEL_W pixels regardless of scroll position -- a column can pass
    // the numeric "within [scrollLeft, scrollLeft+clientWidth)" check
    // while still rendering partly underneath that sticky region. Both
    // the visibility check and the centering math below now account for
    // it (same fix as WbsPlanning.tsx's STICKY_OFFSET).
    const viewStart = el.scrollLeft + LABEL_W;
    const viewEnd = el.scrollLeft + el.clientWidth;
    if (targetLeft >= viewStart && targetLeft + colW <= viewEnd) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    const desired = targetLeft - el.clientWidth / 2 - LABEL_W / 2 + colW / 2;
    el.scrollLeft = Math.max(0, Math.min(desired, maxScroll));
  }, [days, weeks, viewMode, todayRaw]);

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
  // double-count whoever it's assigned to. Now computed by the shared
  // engine (dailyAllocation.ts) so every surface applies the identical
  // rule -- WBS Planning's snapshot used to apply it to only ONE project's
  // depth-0 parents, which is why it showed ~2x this page for the same
  // person on the same day.
  const parentTaskIds = useMemo(() => parentTaskIdsOf(tasks), [tasks]);

  // The single shared allocation engine. Everything below (rollup cells,
  // per-task sub-rows, PM sub-rows, weekly aggregation) reads from it, so
  // Scoped vs Logged and the WBS snapshot -- which build the same engine
  // from the same tables -- cannot drift from this page's numbers.
  const engine = useMemo(
    () =>
      createAllocationEngine({
        tasks: tasks as UtilTaskRow[],
        projects,
        holidays: holidaySet,
        availability,
        assigneeHistory,
        ownerHistory,
        todayStr: today,
        deletedHours,
      }),
    [tasks, projects, holidaySet, availability, assigneeHistory, ownerHistory, today, deletedHours]
  );

  // "Ever associated" -- 2026-08-14: a person's expandable sub-rows now
  // list every task/project their history shows they EVER held, not just
  // whoever currently holds it. Each sub-row's own per-date value is then
  // gated by history too (the engine's assigneeMatchesOnDate/
  // ownerMatchesOnDate), so a transferred task/project correctly shows
  // nonzero only across the date range this specific person actually held
  // it -- the old assignee's sub-row goes to 0 the day it moves on, the new
  // assignee's sub-row starts contributing from that same day, and the two
  // together always sum to the task/project's real total.
  function historicalOwnerIds(projectId: string): Set<string> {
    return new Set(ownerHistory.filter((h) => h.project_id === projectId).map((h) => h.person_id));
  }
  function historicalAssigneeIds(taskId: string): Set<string> {
    return new Set(assigneeHistory.filter((h) => h.task_id === taskId).map((h) => h.person_id));
  }

  function deletedHoursFor(personId: string, dateStr: string): number {
    return engine.deletedHoursOnDate(personId, dateStr);
  }
  function hasDeletedHistory(personId: string): boolean {
    return engine.hasDeletedHistory(personId);
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

  function taskHoursOnDate(t: TaskRow, dateStr: string, forPersonId: string): number {
    return engine.taskHoursOnDate(forPersonId, t as UtilTaskRow, dateStr);
  }
  function pmHoursOnDate(p: ProjectRow, dateStr: string, forPersonId: string): number {
    return engine.pmHoursOnDate(forPersonId, p, dateStr);
  }

  function dailyHoursFor(personId: string, dateStr: string): number {
    return engine.totalFor(personId, dateStr);
  }

  function dailyCapacityFor(person: PersonRow, halfDay: boolean): number {
    return dailyCapacityHours(person, halfDay);
  }

  // 2026-09-03: Capacity-Based mode (the forward-scheduler-backed
  // smoothing preview) removed per Sandra -- "this makes no sense". Every
  // date, past and future, now always uses the plain even-split "Actual"
  // calc below -- deletedHoursFor is already folded into dailyHoursFor via
  // the shared engine, so no separate archived-hours handling is needed
  // here anymore either.
  const scopedPeople = showAllPeople ? allPeople : people;

  // Single source of truth for a rollup cell's numeric hours value, for
  // BOTH the daily grid and the weekly aggregation below.
  function valueForDate(person: PersonRow, dateStr: string): number {
    return dailyHoursFor(person.id, dateStr);
  }
  function pmValueForDate(person: PersonRow, projectId: string, dateStr: string): number {
    const p = projects.find((x) => x.id === projectId);
    return p ? pmHoursOnDate(p, dateStr, person.id) : 0;
  }
  function taskValueForDate(person: PersonRow, t: TaskRow, dateStr: string): number {
    return taskHoursOnDate(t, dateStr, person.id);
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

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        <button
          onClick={() => shiftRange(-1)}
          className="planner-nav-btn"
          disabled={isAtEarliestAnchor}
          title={isAtEarliestAnchor ? "Can't go earlier than Jan 2026" : "Previous"}
          style={isAtEarliestAnchor ? { opacity: 0.4, cursor: "default" } : undefined}
        >
          <ChevronLeft size={14} />
        </button>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--navy)", minWidth: 150 }}>
          {days[0].toLocaleDateString("en-US", { month: "short", day: "numeric" })} –{" "}
          {days[days.length - 1].toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
        </span>
        <button onClick={() => shiftRange(1)} className="planner-nav-btn" title="Next">
          <ChevronRight size={14} />
        </button>
        <button
          onClick={resetToCurrentMonth}
          style={{ fontSize: 11, color: "var(--accent)", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}
        >
          This month
        </button>

        <div style={{ width: 1, height: 18, background: "var(--border)" }} />

        <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--muted)" }}>
          From
          <input
            type="date"
            min="2026-01-01"
            value={toISO(rangeStart)}
            onChange={(e) => setRangeStartFromInput(e.target.value)}
            style={{ fontSize: 11, color: "var(--navy)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "3px 6px" }}
          />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--muted)" }}>
          To
          <input
            type="date"
            min="2026-01-01"
            value={toISO(rangeEnd)}
            onChange={(e) => setRangeEndFromInput(e.target.value)}
            style={{ fontSize: 11, color: "var(--navy)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "3px 6px" }}
          />
        </label>

        <div style={{ width: 1, height: 18, background: "var(--border)" }} />

        <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--muted)" }}>
          <select
            value={showAllPeople ? "all" : "active"}
            onChange={(e) => setShowAllPeople(e.target.value === "all")}
            title="Deactivated people's past hours are always kept -- this only controls whether they're shown here"
            style={{ fontSize: 11, fontWeight: 600, color: "var(--navy)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "3px 6px" }}
          >
            <option value="active">Active people only</option>
            <option value="all">Show all (incl. deactivated)</option>
          </select>
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

      </div>

      <div ref={utilScrollRef} className="card" style={{ padding: 0, overflowX: "auto", overflowY: "visible" }}>
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
              {scopedPeople.length === 0 ? (
                <tr>
                  <td colSpan={1 + columnCount} style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>
                    {showAllPeople ? "No people found." : "No active people found."}
                  </td>
                </tr>
              ) : (
                scopedPeople.map((person) => {
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
                                      {tier.key === "unallocated" ? "–" : `${displayPct(pct)}%`}
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
                                  : `${displayPct(stats.avgPct)}% ${tier.label} · Planned ${stats.plannedHours.toFixed(1)}h / ${stats.availableHours.toFixed(1)}h · Peak day ${displayPct(
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
                                    <span>{stats.workingDaysCount === 0 ? "–" : `${displayPct(stats.avgPct)}%`}</span>
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
                              const workingDays = engine.pmDays(person.id, p);
                              return (
                                <tr key={`pm-${p.id}`}>
                                  <td
                                    title={workingDays.size === 0 ? `${p.name} — set start/due dates to count project-management time` : `${p.name} — project management`}
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
                                        const win = workingDays.has(dateStr);
                                        const value = win ? pmValueForDate(person, p.id, dateStr) : 0;
                                        return (
                                          <td key={i} style={{ ...subCellStyle(i), background: blocked ? "var(--hover-bg)" : !win ? "#f7f8fa" : undefined, fontSize: 12, color: "var(--muted)" }}>
                                            {value > 0 ? value.toFixed(2) : ""}
                                          </td>
                                        );
                                      })
                                    : weeks.map((week, wi) => {
                                        const value = weekSum(week, (dateStr) => (workingDays.has(dateStr) ? pmValueForDate(person, p.id, dateStr) : 0));
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
                              const workingDays = engine.taskDays(person.id, t as UtilTaskRow);
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
                                        const win = dateStr >= today ? true : workingDays.has(dateStr);
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
