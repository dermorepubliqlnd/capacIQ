import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight, ChevronDown, ChevronRight as ChevronRightIcon } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { buildHolidaySet } from "../lib/workingDays";
// Same shared allocation engine Utilization.tsx and WbsPlanning.tsx's
// Utilization snapshot use -- see src/lib/dailyAllocation.ts. Before this,
// "Scoped" here was a thinner, drifting copy: no PM overhead, no Time Off,
// no ownership/assignee history, no deletion archive, and a holiday-blind
// day spread. It could not agree with Utilization for anyone who owns a
// project or has a day off.
import {
  createAllocationEngine,
  parentTaskIdsOf,
  type AssigneeHistoryRow,
  type OwnerHistoryRow,
  type UtilProjectRow,
  type UtilTaskRow,
} from "../lib/dailyAllocation";
import UtilPersonFilterButton from "../components/UtilPersonFilterButton";

// Scoped vs Logged (2026-08-25, consolidated same day). Originally shipped
// alongside a separate "Work Schedule" page (Logged tab + Scoped tab).
// Sandra pointed out the overlap was worse than it looked: "Scoped" was
// already a thinner copy of what Utilization.tsx computes (Utilization
// adds PM overhead + ownership-history + archived-hours on top of the
// same per-task spread math), and Work Schedule's two single-metric tabs
// were just this page's Day view pulled apart. Utilization stays
// untouched as the person-level capacity-% view. This page absorbed
// Work Schedule entirely and became the two things nothing else covers:
// a day-by-day Scoped-vs-Logged breakdown per task (this Day view, now
// built like Utilization's expandable person->task rows instead of a flat
// grid), and a whole-task planned-vs-actual comparison (Per task view).
//
// Key behavior Sandra called out explicitly: logged hours are bucketed by
// the literal date they were logged on, independent of the task's scoped
// window. A task scoped for 3 days that someone actually works on 2 days
// later still shows "– / {logged}h" on that later date -- scoped and
// logged are computed independently per day, then just displayed together.

interface PersonRow {
  id: string;
  name: string;
  daily_capacity_hours: number;
  is_active: boolean;
}
interface ProjectRow {
  id: string;
  name: string;
  is_archived: boolean;
  owner_id: string | null;
  start_date: string | null;
  end_date: string | null;
  wbs_status: string | null;
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
}
interface TimeEntryRow {
  id: string;
  task_id: string;
  person_id: string;
  started_at: string;
  duration_minutes: number | null;
  status: "running" | "pending_confirm" | "confirmed" | "pending_approval" | "approved" | "rejected";
}
interface HolidayRow {
  id: string;
  date: string;
  name: string;
  category: "legal_ph" | "local" | "internal";
}
interface AvailabilityRow {
  person_id: string;
  date: string;
  status: "off" | "half_day";
}
interface DeletedHourRow {
  person_id: string;
  date: string;
  hours: number;
}

function toISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
const WEEKDAY_LABEL = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const CELL_W = 74;
const LABEL_W = 240;

function coverageTone(scoped: number, logged: number): "neutral" | "success" | "warning" | "danger" {
  if (scoped <= 0) return logged > 0 ? "success" : "neutral";
  const ratio = logged / scoped;
  if (ratio >= 0.9) return "success";
  if (ratio >= 0.5) return "warning";
  return "danger";
}
function toneColors(tone: "neutral" | "success" | "warning" | "danger"): { bg?: string; fg: string } {
  if (tone === "success") return { bg: "var(--success-bg)", fg: "var(--success-text)" };
  if (tone === "warning") return { bg: "var(--warning-bg)", fg: "var(--warning-text)" };
  if (tone === "danger") return { bg: "var(--danger-bg)", fg: "var(--danger-text)" };
  return { fg: "var(--muted)" };
}

export default function HoursOverview() {
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [timeEntries, setTimeEntries] = useState<TimeEntryRow[]>([]);
  const [holidays, setHolidays] = useState<HolidayRow[]>([]);
  const [availability, setAvailability] = useState<AvailabilityRow[]>([]);
  const [ownerHistory, setOwnerHistory] = useState<OwnerHistoryRow[]>([]);
  const [assigneeHistory, setAssigneeHistory] = useState<AssigneeHistoryRow[]>([]);
  const [deletedHours, setDeletedHours] = useState<DeletedHourRow[]>([]);
  // Every person, active or not -- used ONLY to resolve a name in the
  // Per-task view. `people` (active-only) drives the Day grid's rows, so a
  // deactivated person's logged time used to render as owner "Unassigned"
  // there, actively mislabelling real work.
  const [allPeople, setAllPeople] = useState<PersonRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"grid" | "task">("grid");
  const [expanded, setExpanded] = useState<string[]>([]);

  // 2026-09-03 (Sandra: default to the current month, with date filters
  // instead of a week-count picker -- same change as Utilization.tsx).
  const [rangeStart, setRangeStart] = useState<Date>(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [rangeEnd, setRangeEnd] = useState<Date>(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth() + 1, 0);
  });
  const [sortBy, setSortBy] = useState<"variance" | "scoped" | "logged" | "name">("variance");
  // 2026-08-26 (Sandra: "allow selection of person to show similar to the
  // utilization snap shot") -- same reusable searchable multi-select
  // already used by WbsPlanning.tsx's Utilization snapshot panel.
  const [personFilter, setPersonFilter] = useState<Set<string> | null>(null);
  const [personFilterOpen, setPersonFilterOpen] = useState(false);
  const [personFilterSearch, setPersonFilterSearch] = useState("");
  // 2026-09-03 (Sandra: retain deactivated people's data, but let me
  // choose active-only vs show-all in the view). Deactivated people's
  // logged/scoped hours were never deleted -- this only controls
  // whether their row/name is DISPLAYED here, same "nothing is ever
  // silently lost, only hidden by default" convention as everywhere
  // else in the app.
  const [showAllPeople, setShowAllPeople] = useState(false);

  async function loadAll() {
    setLoading(true);
    const [{ data: p }, { data: ap }, { data: pr }, { data: tk }, { data: te }, { data: hol }, { data: av }, { data: ownHist }, { data: assHist }, { data: delHrs }, { data: settings }] =
      await Promise.all([
        supabase.from("people").select("id,name,daily_capacity_hours,is_active").eq("is_active", true).order("name"),
        supabase.from("people").select("id,name,daily_capacity_hours,is_active").order("name"),
        supabase.from("projects").select("id,name,is_archived,owner_id,start_date,end_date,wbs_status").eq("is_archived", false),
        supabase
          .from("tasks")
          .select("id,project_id,parent_task_id,name,assignee_id,status,start_date,current_due_date,estimated_hours,is_archived")
          .eq("is_archived", false),
        supabase.from("time_entries").select("id,task_id,person_id,started_at,duration_minutes,status").in("status", ["confirmed", "approved"]),
        supabase.from("holidays").select("*"),
        supabase.from("person_availability").select("person_id,date,status"),
        supabase.from("project_owner_history").select("project_id,person_id,effective_from,effective_to"),
        supabase.from("task_assignee_history").select("task_id,person_id,effective_from,effective_to"),
        supabase.from("deleted_person_day_hours").select("person_id,date,hours"),
        supabase.from("app_settings").select("historical_locking_enabled").eq("id", true).single(),
      ]);
    setPeople((p as PersonRow[]) ?? []);
    setAllPeople((ap as PersonRow[]) ?? []);
    setProjects((pr as ProjectRow[]) ?? []);
    setTasks((tk as TaskRow[]) ?? []);
    setTimeEntries((te as TimeEntryRow[]) ?? []);
    setHolidays((hol as HolidayRow[]) ?? []);
    setAvailability((av as AvailabilityRow[]) ?? []);
    // Same global off-switch Utilization.tsx honours (app_settings
    // .historical_locking_enabled): while off, history is ignored and
    // attribution falls back to each row's CURRENT owner/assignee. Reading
    // it here too is what keeps the two pages attributing a transferred
    // task/project to the SAME person on the same past date.
    const historicalLockingEnabled = (settings as { historical_locking_enabled?: boolean } | null)?.historical_locking_enabled ?? false;
    setOwnerHistory(historicalLockingEnabled ? (ownHist as OwnerHistoryRow[]) ?? [] : []);
    setAssigneeHistory(historicalLockingEnabled ? (assHist as AssigneeHistoryRow[]) ?? [] : []);
    setDeletedHours((delHrs as DeletedHourRow[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    loadAll();
  }, []);

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

  // Same paging/reset/date-filter helpers as Utilization.tsx -- see that
  // file's comment for the reasoning (page by the range's own width, not
  // an unrelated fixed week count).
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
  // Utilization snapshot panel and Utilization.tsx's main grid). Today is
  // the first column in this grid by design (weekOffset 0 anchors to
  // today), so it's the one most likely to sit out of view at a narrower
  // viewport/zoom with no visible cue that there's more to scroll to.
  const gridScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = gridScrollRef.current;
    if (!el) return;
    const todayIso = toISO(todayRaw);
    const idx = days.findIndex((d) => toISO(d) === todayIso);
    if (idx === -1) return;
    const targetLeft = LABEL_W + idx * CELL_W;
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
    if (targetLeft >= viewStart && targetLeft + CELL_W <= viewEnd) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    const desired = targetLeft - el.clientWidth / 2 - LABEL_W / 2 + CELL_W / 2;
    el.scrollLeft = Math.max(0, Math.min(desired, maxScroll));
  }, [days]);

  const scopedPeople = showAllPeople ? allPeople : people;
  const visiblePeople = personFilter ? scopedPeople.filter((p) => personFilter.has(p.id)) : scopedPeople;

  const holidayByDate = useMemo(() => {
    const m = new Map<string, HolidayRow>();
    holidays.forEach((h) => m.set(h.date, h));
    return m;
  }, [holidays]);

  const parentTaskIds = useMemo(() => parentTaskIdsOf(tasks), [tasks]);
  const holidaySet = useMemo(() => buildHolidaySet(holidays.map((h) => h.date)), [holidays]);
  const today = useMemo(() => toISO(new Date()), []);

  // The one shared allocation engine (identical construction to
  // Utilization.tsx's). Scoped = exactly what the Utilization page counts
  // as a person's planned hours on that day: open leaf tasks spread over
  // real working days, plus PM overhead for every project they own, plus
  // any archived hours from permanently-deleted work.
  const engine = useMemo(
    () =>
      createAllocationEngine({
        tasks: tasks as UtilTaskRow[],
        projects: projects as UtilProjectRow[],
        holidays: holidaySet,
        availability,
        assigneeHistory,
        ownerHistory,
        todayStr: today,
        deletedHours,
      }),
    [tasks, projects, holidaySet, availability, assigneeHistory, ownerHistory, today, deletedHours]
  );

  function isOffDay(personId: string, dateStr: string): boolean {
    return availability.some((a) => a.person_id === personId && a.date === dateStr && a.status === "off");
  }

  // Scoped side: every non-parent task currently assigned to this person,
  // open or Done -- mirrors Utilization.tsx's own openTasksFor, fixed
  // 2026-09-03 (Sandra: a Done task's real historical hours must still
  // have a sub-row to explain them, not just vanish from the breakdown
  // the moment it's completed; scopedHoursFor below already reads the
  // shared engine's date-gated value, so a Done task's row here correctly
  // shows its real past hours and 0 from today forward).
  function scopedOpenTasksFor(personId: string): TaskRow[] {
    return tasks.filter((t) => t.assignee_id === personId && !parentTaskIds.has(t.id));
  }
  function ownedProjectsFor(personId: string): ProjectRow[] {
    return projects.filter((p) => p.owner_id === personId);
  }
  // 2026-08-31: now includes PM overhead and the deletion archive, so this
  // number is the SAME number Utilization.tsx prints for the same person on
  // the same day. Both extras get their own visible sub-row in the expanded
  // breakdown below, so the difference from the raw task sum is explained on
  // screen rather than unexplained.
  function scopedPersonTotalFor(personId: string, dateStr: string): number {
    return engine.totalFor(personId, dateStr);
  }
  // Logged side: every confirmed/approved entry this person has, bucketed
  // by the literal date it was logged on -- deliberately NOT filtered to
  // the task's scoped window or current assignment/status, so time logged
  // outside a task's plan (or after reassignment/completion) still shows.
  function loggedPersonTotalFor(personId: string, dateStr: string): number {
    return timeEntries
      .filter((e) => e.person_id === personId && e.started_at.slice(0, 10) === dateStr)
      .reduce((sum, e) => sum + (e.duration_minutes ?? 0) / 60, 0);
  }
  function loggedHoursFor(personId: string, taskId: string, dateStr: string): number {
    return timeEntries
      .filter((e) => e.person_id === personId && e.task_id === taskId && e.started_at.slice(0, 10) === dateStr)
      .reduce((sum, e) => sum + (e.duration_minutes ?? 0) / 60, 0);
  }
  // 2026-08-26 bugfix, UPDATED 2026-09-03: originally made to agree with
  // scopedPersonTotalFor once a task went Done (both used to zero out
  // completed tasks unconditionally). That blanket zeroing was itself
  // fixed 2026-09-03 (Sandra: zeroing a Done task erases real historical
  // utilization) -- the shared engine's taskHoursOnDate now only zeroes a
  // Done task from TODAY forward, so this cell and scopedPersonTotalFor
  // still agree (both call the same engine), but a Done task's PAST days
  // correctly show real hours again instead of always reading "–".
  function scopedHoursFor(personId: string, taskId: string, dateStr: string): number {
    const t = tasks.find((x) => x.id === taskId && x.assignee_id === personId);
    if (!t) return 0;
    if (parentTaskIds.has(t.id)) return 0;
    return engine.taskHoursOnDate(personId, t as UtilTaskRow, dateStr);
  }

  // Combined per-task breakdown for a person's expand row: union of their
  // open scoped-eligible tasks AND any task they've logged time against
  // (even if reassigned, completed, or archived since) -- otherwise a
  // logged entry on a task that no longer meets the "scoped" filter would
  // just vanish from the breakdown instead of showing up as "– / Xh".
  function combinedSubItemsFor(personId: string): { taskId: string; label: string; project?: string }[] {
    const byId = new Map<string, { taskId: string; label: string; project?: string }>();
    scopedOpenTasksFor(personId).forEach((t) => {
      const proj = projects.find((p) => p.id === t.project_id);
      byId.set(t.id, { taskId: t.id, label: t.name, project: proj?.name });
    });
    timeEntries
      .filter((e) => e.person_id === personId)
      .forEach((e) => {
        if (byId.has(e.task_id)) return;
        const t = tasks.find((x) => x.id === e.task_id);
        const proj = t ? projects.find((p) => p.id === t.project_id) : undefined;
        byId.set(e.task_id, { taskId: e.task_id, label: t?.name ?? "Deleted/archived task", project: proj?.name });
      });
    return Array.from(byId.values()).sort((a, b) => a.label.localeCompare(b.label));
  }

  // Per-task flat comparison (whole-task totals, not windowed to the
  // visible date range) -- unchanged from the original Overview build.
  const taskRows = useMemo(() => {
    return tasks
      .filter((t) => !parentTaskIds.has(t.id))
      .map((t) => {
        const proj = projects.find((p) => p.id === t.project_id);
        // Resolve against ALL people, not just active ones -- a deactivated
        // assignee used to fall through to "Unassigned" here, which reads as
        // orphaned work when it is actually assigned (just to someone who
        // has left/been deactivated).
        const owner = allPeople.find((p) => p.id === t.assignee_id);
        const scoped = t.estimated_hours ?? 0;
        const logged = timeEntries.filter((e) => e.task_id === t.id).reduce((sum, e) => sum + (e.duration_minutes ?? 0) / 60, 0);
        return {
          id: t.id,
          name: t.name,
          projectId: t.project_id,
          project: proj?.name ?? "—",
          ownerId: t.assignee_id,
          owner: owner ? (owner.is_active ? owner.name : `${owner.name} (inactive)`) : "Unassigned",
          scoped,
          logged,
          variance: logged - scoped,
        };
      })
      .filter((r) => r.scoped > 0 || r.logged > 0);
  }, [tasks, projects, allPeople, timeEntries, parentTaskIds]);

  // 2026-08-26 (Sandra: "allow grouping and filtering by person and by
  // project") -- both single-select dropdowns; kept simple (one active
  // filter/group at a time) rather than the Day view's multi-select
  // UtilPersonFilterButton, since this table is a flat list where a
  // single active group/filter reads more clearly than a checklist.
  const [taskFilterPersonId, setTaskFilterPersonId] = useState<string>("");
  const [taskFilterProjectId, setTaskFilterProjectId] = useState<string>("");
  const [taskGroupBy, setTaskGroupBy] = useState<"none" | "person" | "project">("none");

  const filteredTaskRows = useMemo(() => {
    return taskRows.filter(
      (r) => (!taskFilterPersonId || r.ownerId === taskFilterPersonId) && (!taskFilterProjectId || r.projectId === taskFilterProjectId)
    );
  }, [taskRows, taskFilterPersonId, taskFilterProjectId]);

  const sortedTaskRows = useMemo(() => {
    const rows = [...filteredTaskRows];
    if (sortBy === "variance") rows.sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));
    else if (sortBy === "scoped") rows.sort((a, b) => b.scoped - a.scoped);
    else if (sortBy === "logged") rows.sort((a, b) => b.logged - a.logged);
    else rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  }, [filteredTaskRows, sortBy]);

  // Grouped view: same sortedTaskRows order, just bucketed into
  // Person/Project sections with their own subtotal, instead of one flat
  // list -- built from sortedTaskRows so within-group ordering still
  // respects the active Sort by.
  const groupedTaskRows = useMemo(() => {
    if (taskGroupBy === "none") return null;
    const groups = new Map<string, { label: string; rows: typeof sortedTaskRows }>();
    for (const r of sortedTaskRows) {
      const key = taskGroupBy === "person" ? r.ownerId ?? "__unassigned" : r.projectId;
      const label = taskGroupBy === "person" ? r.owner : r.project;
      if (!groups.has(key)) groups.set(key, { label, rows: [] });
      groups.get(key)!.rows.push(r);
    }
    return Array.from(groups.values()).sort((a, b) => a.label.localeCompare(b.label));
  }, [sortedTaskRows, taskGroupBy]);

  const taskTotals = useMemo(
    () => filteredTaskRows.reduce((acc, r) => ({ scoped: acc.scoped + r.scoped, logged: acc.logged + r.logged }), { scoped: 0, logged: 0 }),
    [filteredTaskRows]
  );

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
      padding: "5px 3px",
      textAlign: "center",
      borderBottom: "1px solid var(--border)",
      borderLeft: i % 7 === 0 ? "1px solid var(--border)" : undefined,
    };
  }

  if (loading) return <p style={{ padding: 20, color: "var(--muted)" }}>Loading…</p>;

  return (
    <div>
      <h1>Scoped vs Logged</h1>

      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        <button
          onClick={() => setView("grid")}
          style={{
            padding: "6px 14px",
            fontSize: 12,
            fontWeight: 600,
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            background: view === "grid" ? "var(--navy)" : "var(--surface)",
            color: view === "grid" ? "#fff" : "var(--text-secondary)",
            cursor: "pointer",
          }}
        >
          Day
        </button>
        <button
          onClick={() => setView("task")}
          style={{
            padding: "6px 14px",
            fontSize: 12,
            fontWeight: 600,
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            background: view === "task" ? "var(--navy)" : "var(--surface)",
            color: view === "task" ? "#fff" : "var(--text-secondary)",
            cursor: "pointer",
          }}
        >
          Per task
        </button>
      </div>

      {view === "grid" ? (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
            {/* 2026-09-03 (Sandra: default to the current month, with date
                filters instead of a week-count picker -- same change as
                Utilization.tsx). Prev/Next now shift by the current
                range's own span, "This month" resets to the calendar
                month, and From/To date inputs let her pick any range. */}
            <button
              onClick={() => shiftRange(-1)}
              className="planner-nav-btn"
              disabled={isAtEarliestAnchor}
              title={isAtEarliestAnchor ? "Can't go earlier than Jan 2026" : "Previous range"}
            >
              <ChevronLeft size={14} />
            </button>
            <button
              onClick={resetToCurrentMonth}
              style={{ fontSize: 11.5, fontWeight: 600, color: "var(--accent)", background: "none", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "4px 10px", cursor: "pointer", whiteSpace: "nowrap" }}
            >
              This month
            </button>
            <button onClick={() => shiftRange(1)} className="planner-nav-btn">
              <ChevronRight size={14} />
            </button>
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--text-secondary)" }}>
              From
              <input
                type="date"
                value={toISO(rangeStart)}
                onChange={(e) => setRangeStartFromInput(e.target.value)}
                style={{ fontSize: 12, padding: "3px 6px" }}
              />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--text-secondary)" }}>
              To
              <input
                type="date"
                value={toISO(rangeEnd)}
                onChange={(e) => setRangeEndFromInput(e.target.value)}
                style={{ fontSize: 12, padding: "3px 6px" }}
              />
            </label>
            <UtilPersonFilterButton
              people={scopedPeople}
              selected={personFilter}
              open={personFilterOpen}
              setOpen={setPersonFilterOpen}
              search={personFilterSearch}
              setSearch={setPersonFilterSearch}
              onChange={setPersonFilter}
            />
            <select
              value={showAllPeople ? "all" : "active"}
              onChange={(e) => setShowAllPeople(e.target.value === "all")}
              title="Deactivated team members' past hours are always kept -- this only controls whether they're shown here"
              style={{ fontSize: 12, padding: "4px 6px" }}
            >
              <option value="active">Active team members only</option>
              <option value="all">Show all (incl. deactivated)</option>
            </select>
          </div>

          <div ref={gridScrollRef} style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius)" }}>
            <table style={{ borderCollapse: "collapse", width: "max-content" }}>
              <thead>
                <tr>
                  <th style={{ position: "sticky", left: 0, zIndex: 2, background: "var(--surface)", width: LABEL_W, minWidth: LABEL_W, borderBottom: "1px solid var(--border)" }} />
                  {weeks.map((week, wi) => (
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
                  ))}
                </tr>
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
                    Team Member
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
              </thead>
              <tbody>
                {visiblePeople.length === 0 ? (
                  <tr>
                    <td colSpan={1 + days.length} style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>
                      {showAllPeople ? "No team members found." : "No active team members found."}
                    </td>
                  </tr>
                ) : (
                  <Fragment>
                    {visiblePeople.map((person) => {
                      const isExpanded = expanded.includes(person.id);
                      const items = combinedSubItemsFor(person.id);
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
                                {isExpanded ? <ChevronDown size={12} /> : <ChevronRightIcon size={12} />}
                                {person.name}
                              </span>
                            </td>
                            {days.map((d, i) => {
                              const dateStr = toISO(d);
                              const dow = d.getDay();
                              const weekend = dow === 0 || dow === 6;
                              const isHoliday = holidayByDate.has(dateStr);
                              const off = isOffDay(person.id, dateStr);
                              const scoped = scopedPersonTotalFor(person.id, dateStr);
                              const logged = loggedPersonTotalFor(person.id, dateStr);
                              // 2026-08-31: holiday / Time Off days are now
                              // labelled the same way Utilization.tsx labels
                              // them, instead of silently reading as a normal
                              // empty day -- the two pages disagreed about a
                              // person's availability on exactly these days.
                              // (Logged time still wins if any exists: someone
                              // really did work, and hiding that was the other
                              // half of the same inconsistency.)
                              if (scoped === 0 && logged === 0 && !weekend && (isHoliday || off)) {
                                return (
                                  <td
                                    key={i}
                                    title={isHoliday ? holidayByDate.get(dateStr)?.name : "Time Off"}
                                    style={{ ...rollupCellStyle(i), background: isHoliday ? "#eef1f5" : "#f1f2f4", color: "var(--muted)", fontSize: 11, fontWeight: 600 }}
                                  >
                                    {isHoliday ? "Holiday" : "Off"}
                                  </td>
                                );
                              }
                              const tone = coverageTone(scoped, logged);
                              const colors = toneColors(tone);
                              const bg = scoped === 0 && logged === 0 ? (weekend || isHoliday ? "var(--hover-bg)" : undefined) : colors.bg;
                              return (
                                <td key={i} style={{ ...rollupCellStyle(i), background: bg, color: colors.fg, fontSize: 11.5, fontWeight: 600 }}>
                                  {scoped > 0 || logged > 0 ? `${scoped.toFixed(1)} / ${logged.toFixed(1)}h` : "–"}
                                </td>
                              );
                            })}
                          </tr>
                          {/* PM-overhead sub-rows (2026-08-31). The person
                              rollup above now includes the same
                              project-ownership allowance Utilization.tsx
                              counts, so it has to be visible here too --
                              otherwise the rollup would simply not equal the
                              sum of its own sub-rows, which is the exact class
                              of bug this page already had once (see
                              scopedHoursFor). Logged side is always "–": time
                              is logged against tasks, never against PM
                              overhead. */}
                          {isExpanded &&
                            ownedProjectsFor(person.id).map((proj) => {
                              const pmDays = engine.pmDays(person.id, proj as UtilProjectRow);
                              if (pmDays.size === 0) return null;
                              return (
                                <tr key={`${person.id}-pm-${proj.id}`}>
                                  <td
                                    title={`${proj.name} — project management`}
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
                                    {proj.name}
                                    <span style={{ fontSize: 9.5, fontWeight: 600, color: "var(--muted)", marginLeft: 6 }}>(PM)</span>
                                  </td>
                                  {days.map((d, i) => {
                                    const dateStr = toISO(d);
                                    const v = engine.pmHoursOnDate(person.id, proj as UtilProjectRow, dateStr);
                                    return (
                                      <td key={i} style={subCellStyle(i)}>
                                        {v > 0 ? (
                                          <span style={{ fontSize: 10.5, color: "var(--navy)" }}>
                                            {v.toFixed(2)}
                                            <span style={{ color: "var(--muted)" }}> / – </span>
                                          </span>
                                        ) : null}
                                      </td>
                                    );
                                  })}
                                </tr>
                              );
                            })}
                          {isExpanded && engine.hasDeletedHistory(person.id) && (
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
                                }}
                              >
                                Deleted items
                              </td>
                              {days.map((d, i) => {
                                const v = engine.deletedHoursOnDate(person.id, toISO(d));
                                return (
                                  <td key={i} style={subCellStyle(i)}>
                                    {v > 0 ? (
                                      <span style={{ fontSize: 10.5, color: "var(--navy)" }}>
                                        {v.toFixed(2)}
                                        <span style={{ color: "var(--muted)" }}> / – </span>
                                      </span>
                                    ) : null}
                                  </td>
                                );
                              })}
                            </tr>
                          )}
                          {isExpanded &&
                            (items.length === 0 ? (
                              <tr>
                                <td
                                  colSpan={1 + days.length}
                                  style={{ padding: "5px 13px 5px 35px", fontSize: 11, color: "var(--muted)", fontStyle: "italic", borderBottom: "1px solid var(--border)" }}
                                >
                                  No scoped tasks or logged hours yet.
                                </td>
                              </tr>
                            ) : (
                              items.map((item) => (
                                <tr key={`${person.id}-${item.taskId}`}>
                                  <td
                                    title={item.project ? `${item.label} — ${item.project}` : item.label}
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
                                    {item.label}
                                    {item.project && <span style={{ fontSize: 9.5, fontWeight: 600, color: "var(--muted)", marginLeft: 6 }}>{item.project}</span>}
                                  </td>
                                  {days.map((d, i) => {
                                    const dateStr = toISO(d);
                                    const scoped = scopedHoursFor(person.id, item.taskId, dateStr);
                                    const logged = loggedHoursFor(person.id, item.taskId, dateStr);
                                    return (
                                      <td key={i} style={subCellStyle(i)}>
                                        {scoped > 0 || logged > 0 ? (
                                          <span style={{ fontSize: 10.5, color: "var(--navy)" }}>
                                            {scoped > 0 ? scoped.toFixed(1) : "–"}
                                            <span style={{ color: "var(--muted)" }}> / </span>
                                            {logged > 0 ? logged.toFixed(1) : "–"}
                                          </span>
                                        ) : null}
                                      </td>
                                    );
                                  })}
                                </tr>
                              ))
                            ))}
                        </Fragment>
                      );
                    })}
                    <tr>
                      <td
                        style={{
                          position: "sticky",
                          left: 0,
                          zIndex: 1,
                          background: "var(--surface)",
                          padding: "8px 13px",
                          fontSize: 12,
                          fontWeight: 600,
                          color: "var(--muted)",
                          borderTop: "1px solid var(--border)",
                          whiteSpace: "nowrap",
                        }}
                      >
                        Total
                      </td>
                      {days.map((d, i) => {
                        const dateStr = toISO(d);
                        const scoped = visiblePeople.reduce((sum, p) => sum + scopedPersonTotalFor(p.id, dateStr), 0);
                        const logged = visiblePeople.reduce((sum, p) => sum + loggedPersonTotalFor(p.id, dateStr), 0);
                        return (
                          <td key={i} style={{ ...rollupCellStyle(i), borderTop: "1px solid var(--border)", fontSize: 11.5, fontWeight: 600, color: "var(--muted)" }}>
                            {scoped > 0 || logged > 0 ? `${scoped.toFixed(1)}/${logged.toFixed(1)}h` : "–"}
                          </td>
                        );
                      })}
                    </tr>
                  </Fragment>
                )}
              </tbody>
            </table>
          </div>
          {/* 2026-08-26 (Sandra: "can the guide text at the bottom of
              this page show the color coding instead of just text") --
              actual swatches matching coverageTone/toneColors' real
              colors, instead of naming them in prose. */}
          <div style={{ marginTop: 10, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 14, fontSize: 11.5, color: "var(--muted)" }}>
            {(
              [
                { tone: "success" as const, label: "Logged covers ≥90% of scoped" },
                { tone: "warning" as const, label: "50–89%" },
                { tone: "danger" as const, label: "Under 50%" },
                { tone: "neutral" as const, label: '"–" = nothing scoped or logged' },
              ]
            ).map(({ tone, label }) => {
              const colors = toneColors(tone);
              return (
                <span key={tone} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: colors.bg ?? "var(--hover-bg)", border: `1px solid ${colors.fg}` }} />
                  {label}
                </span>
              );
            })}
            <span>Logged hours always show on the day they were actually worked, even outside a task's scoped window.</span>
          </div>
        </>
      ) : (
        <>
          {/* 2026-08-26 redesign (Sandra): column order Person/Project/
              Task/Scoped/Logged/Variance (was Task/Project/Owner/...);
              added Group by + Filter by person/project; table now sits in
              a proper white card (border+radius) with hover-highlighted
              rows via .hours-per-task-row instead of bare rows straight on
              the page's own grey background, which read as "the whole
              page is grey" against the Day view's much more colorful grid. */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
            <label style={{ fontSize: 12, color: "var(--muted)" }}>Sort by</label>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)} style={{ fontSize: 12, padding: "4px 6px" }}>
              <option value="variance">Variance (largest first)</option>
              <option value="scoped">Scoped hours</option>
              <option value="logged">Logged hours</option>
              <option value="name">Task name</option>
            </select>
            <label style={{ fontSize: 12, color: "var(--muted)", marginLeft: 6 }}>Group by</label>
            <select value={taskGroupBy} onChange={(e) => setTaskGroupBy(e.target.value as typeof taskGroupBy)} style={{ fontSize: 12, padding: "4px 6px" }}>
              <option value="none">None</option>
              <option value="person">Team Member</option>
              <option value="project">Project</option>
            </select>
            <label style={{ fontSize: 12, color: "var(--muted)", marginLeft: 6 }}>Team Member</label>
            <select value={taskFilterPersonId} onChange={(e) => setTaskFilterPersonId(e.target.value)} style={{ fontSize: 12, padding: "4px 6px" }}>
              <option value="">All team members</option>
              {scopedPeople.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <label style={{ fontSize: 12, color: "var(--muted)", marginLeft: 6 }}>Project</label>
            <select value={taskFilterProjectId} onChange={(e) => setTaskFilterProjectId(e.target.value)} style={{ fontSize: 12, padding: "4px 6px" }}>
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius)", background: "var(--surface)" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: "8px 13px", color: "var(--muted)", fontWeight: 600, fontSize: 12, borderBottom: "1px solid var(--border)" }}>Team Member</th>
                  <th style={{ textAlign: "left", padding: "8px 13px", color: "var(--muted)", fontWeight: 600, fontSize: 12, borderBottom: "1px solid var(--border)" }}>Project</th>
                  <th style={{ textAlign: "left", padding: "8px 13px", color: "var(--muted)", fontWeight: 600, fontSize: 12, borderBottom: "1px solid var(--border)" }}>Task</th>
                  <th style={{ textAlign: "right", padding: "8px 13px", color: "var(--muted)", fontWeight: 600, fontSize: 12, borderBottom: "1px solid var(--border)" }}>Scoped</th>
                  <th style={{ textAlign: "right", padding: "8px 13px", color: "var(--muted)", fontWeight: 600, fontSize: 12, borderBottom: "1px solid var(--border)" }}>Logged</th>
                  <th style={{ textAlign: "right", padding: "8px 13px", color: "var(--muted)", fontWeight: 600, fontSize: 12, borderBottom: "1px solid var(--border)" }}>Variance</th>
                </tr>
              </thead>
              <tbody>
                {sortedTaskRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>
                      No tasks with Scoped or Logged hours yet.
                    </td>
                  </tr>
                ) : groupedTaskRows ? (
                  groupedTaskRows.map((group) => {
                    const groupScoped = group.rows.reduce((sum, r) => sum + r.scoped, 0);
                    const groupLogged = group.rows.reduce((sum, r) => sum + r.logged, 0);
                    return (
                      <Fragment key={group.label}>
                        <tr>
                          <td colSpan={3} style={{ padding: "6px 13px", fontSize: 11.5, fontWeight: 700, color: "var(--navy)", background: "var(--bg)", borderBottom: "1px solid var(--border)" }}>
                            {group.label} <span style={{ fontWeight: 500, color: "var(--muted)" }}>({group.rows.length})</span>
                          </td>
                          <td style={{ padding: "6px 13px", textAlign: "right", fontSize: 11.5, fontWeight: 700, background: "var(--bg)", borderBottom: "1px solid var(--border)" }}>{groupScoped.toFixed(1)}h</td>
                          <td style={{ padding: "6px 13px", textAlign: "right", fontSize: 11.5, fontWeight: 700, background: "var(--bg)", borderBottom: "1px solid var(--border)" }}>{groupLogged.toFixed(1)}h</td>
                          <td style={{ padding: "6px 13px", background: "var(--bg)", borderBottom: "1px solid var(--border)" }} />
                        </tr>
                        {group.rows.map((r) => (
                          <TaskHourRow key={r.id} r={r} />
                        ))}
                      </Fragment>
                    );
                  })
                ) : (
                  sortedTaskRows.map((r) => <TaskHourRow key={r.id} r={r} />)
                )}
              </tbody>
              {sortedTaskRows.length > 0 && (
                <tfoot>
                  <tr>
                    <td style={{ padding: "8px 13px", fontWeight: 600 }}>Total</td>
                    <td style={{ padding: "8px 13px" }} />
                    <td style={{ padding: "8px 13px" }} />
                    <td style={{ padding: "8px 13px", textAlign: "right", fontWeight: 600 }}>{taskTotals.scoped.toFixed(1)}h</td>
                    <td style={{ padding: "8px 13px", textAlign: "right", fontWeight: 600 }}>{taskTotals.logged.toFixed(1)}h</td>
                    <td style={{ padding: "8px 13px", textAlign: "right", fontWeight: 600 }}>
                      {(taskTotals.logged - taskTotals.scoped > 0 ? "+" : "") + (taskTotals.logged - taskTotals.scoped).toFixed(1)}h
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </>
      )}
    </div>
  );
}

type TaskHourRowData = {
  id: string;
  name: string;
  projectId: string;
  project: string;
  ownerId: string | null;
  owner: string;
  scoped: number;
  logged: number;
  variance: number;
};

// Extracted 2026-08-26 so both the flat and grouped render branches of the
// "Per task" view share one row (was inlined only in the flat branch).
function TaskHourRow({ r }: { r: TaskHourRowData }) {
  const varColor = r.variance > 0.05 ? "var(--danger-text)" : r.variance < -0.05 ? "var(--warning-text)" : "var(--success-text)";
  return (
    <tr className="hours-per-task-row">
      <td style={{ padding: "7px 13px", borderBottom: "1px solid var(--border)", color: "var(--text-secondary)" }}>{r.owner}</td>
      <td style={{ padding: "7px 13px", borderBottom: "1px solid var(--border)", color: "var(--text-secondary)" }}>{r.project}</td>
      <td style={{ padding: "7px 13px", borderBottom: "1px solid var(--border)" }}>{r.name}</td>
      <td style={{ padding: "7px 13px", borderBottom: "1px solid var(--border)", textAlign: "right" }}>{r.scoped.toFixed(1)}h</td>
      <td style={{ padding: "7px 13px", borderBottom: "1px solid var(--border)", textAlign: "right" }}>{r.logged.toFixed(1)}h</td>
      <td style={{ padding: "7px 13px", borderBottom: "1px solid var(--border)", textAlign: "right", fontWeight: 600, color: varColor }}>
        {r.variance > 0 ? "+" : ""}
        {r.variance.toFixed(1)}h
      </td>
    </tr>
  );
}
