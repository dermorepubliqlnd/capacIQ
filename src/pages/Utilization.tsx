import { Fragment, useEffect, useMemo, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight, ChevronDown, Minus, Circle, CheckCircle2, AlertTriangle } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { TASK_STATUS_GROUPED, TASK_EFFORT_POINTS, statusGroupOf } from "../lib/notionOptions";

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
  effort: string | null;
  is_archived: boolean;
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

// A "standard" workday, used only to normalize daily point-capacity — a
// person whose own daily capacity (set in User management) equals this
// has a capacity of exactly 1 point/day, i.e. one Heavy (2-pt) task every
// other day. Not shown anywhere; purely a conversion factor.
const STANDARD_DAILY_HOURS = 7.5;

// Project-ownership "PM overhead" — mirrors the Day Planner's existing
// manual PM default (0.5h/day, capped 2h/day) expressed in points
// (0.5/7.5 ≈ 0.1, 2/7.5 ≈ 0.3), so a project owner with no assigned tasks
// yet doesn't sit at a flat 0%, without ownership alone driving anyone
// past "Available". Cap applies across ALL projects a person owns combined.
const PROJECT_PM_POINTS_PER_DAY = 0.1;
const PROJECT_PM_POINTS_CAP_PER_DAY = 0.3;

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

// The 5 tiers Sandra specified, verbatim thresholds: 0 = grey, 1-59% =
// light green, 60-80% = green, 81-100% = yellow, >100% = red.
function tierOf(pct: number): { key: string; label: string; bg?: string; fg: string; Icon: typeof Minus } {
  if (pct <= 0) return { key: "none", label: "No project", fg: "var(--muted)", Icon: Minus };
  if (pct < 60) return { key: "available", label: "Available", bg: "var(--available-bg)", fg: "var(--available-text)", Icon: Circle };
  if (pct <= 80) return { key: "healthy", label: "Healthy", bg: "var(--success-bg)", fg: "var(--success-text)", Icon: CheckCircle2 };
  if (pct <= 100) return { key: "near_full", label: "Near full capacity", bg: "var(--warning-bg)", fg: "var(--warning-text)", Icon: AlertTriangle };
  return { key: "overloaded", label: "Overloaded", bg: "var(--danger-bg)", fg: "var(--danger-text)", Icon: AlertTriangle };
}

const LEGEND = [
  { pct: "0%", label: "No project", tone: "neutral", Icon: Minus },
  { pct: "1–59%", label: "Available", tone: "available", Icon: Circle },
  { pct: "60–80%", label: "Healthy", tone: "success", Icon: CheckCircle2 },
  { pct: "81–100%", label: "Near full capacity", tone: "warning", Icon: AlertTriangle },
  { pct: "100%+", label: "Overloaded", tone: "danger", Icon: AlertTriangle },
];

// Every open task's effort points are spread evenly across its own Mon-Fri
// working days between start and due date (fallback: the due date itself,
// if that window is entirely a weekend) — this is what makes the grid
// date-aware instead of lumping a task's whole effort into every day.
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

// A project's own working-day window, for PM-overhead points — unlike
// tasks there's no due-date fallback: a project with no start/end date set
// simply doesn't contribute PM points yet (same "set your dates" nudge
// used everywhere else in the app).
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
  const [ownerHistory, setOwnerHistory] = useState<OwnerHistoryRow[]>([]);
  const [assigneeHistory, setAssigneeHistory] = useState<AssigneeHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [weekOffset, setWeekOffset] = useState(0);
  const [rangeWeeks, setRangeWeeks] = useState<(typeof RANGE_OPTIONS)[number]>(2);
  const [expanded, setExpanded] = useState<string[]>([]);

  async function loadAll() {
    setLoading(true);
    const [{ data: p }, { data: pr }, { data: tk }, { data: av }, { data: hol }, { data: ownHist }, { data: assHist }] = await Promise.all([
      supabase.from("people").select("id,name,daily_capacity_hours,is_active").eq("is_active", true).order("name"),
      supabase.from("projects").select("id,name,owner_id,start_date,end_date").eq("is_archived", false),
      supabase.from("tasks").select("id,project_id,parent_task_id,name,assignee_id,status,start_date,current_due_date,effort,is_archived").eq("is_archived", false),
      supabase.from("person_availability").select("*"),
      supabase.from("holidays").select("*"),
      supabase.from("project_owner_history").select("project_id,person_id,effective_from,effective_to"),
      supabase.from("task_assignee_history").select("task_id,person_id,effective_from,effective_to"),
    ]);
    setPeople((p as PersonRow[]) ?? []);
    setProjects((pr as ProjectRow[]) ?? []);
    setTasks((tk as TaskRow[]) ?? []);
    setAvailability((av as AvailabilityRow[]) ?? []);
    setHolidays((hol as HolidayRow[]) ?? []);
    setOwnerHistory((ownHist as OwnerHistoryRow[]) ?? []);
    setAssigneeHistory((assHist as AssigneeHistoryRow[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    loadAll();
  }, []);

  const days = useMemo(() => {
    const base = addDays(startOfWeek(new Date()), weekOffset * 7);
    return Array.from({ length: rangeWeeks * 7 }, (_, i) => addDays(base, i));
  }, [weekOffset, rangeWeeks]);

  function jumpToDate(dateStr: string) {
    if (!dateStr) return;
    const [y, m, d] = dateStr.split("-").map(Number);
    const chosenMonday = startOfWeek(new Date(y, (m ?? 1) - 1, d ?? 1));
    const todayMonday = startOfWeek(new Date());
    const diffWeeks = Math.round((chosenMonday.getTime() - todayMonday.getTime()) / (7 * 24 * 60 * 60 * 1000));
    setWeekOffset(diffWeeks);
  }
  const weeks: Date[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));

  const holidayByDate = useMemo(() => {
    const m = new Map<string, HolidayRow>();
    holidays.forEach((h) => m.set(h.date, h));
    return m;
  }, [holidays]);

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
  // from utilization points -- a parent's own span/hours are already just
  // a rollup of its children (see WBS Planning's parentAssigneeState /
  // the Effort "N/A" treatment for parents), so counting a parent's own
  // Effort+Assignee here on top of its children's would double-count
  // whoever it's assigned to. `parentTaskIds` is every id that appears as
  // some other task's own parent_task_id.
  const parentTaskIds = new Set(tasks.filter((t) => t.parent_task_id).map((t) => t.parent_task_id as string));
  // "Ever associated" -- 2026-08-14: a person's expandable sub-rows now
  // list every task/project their history shows they EVER held, not just
  // whoever currently holds it. Each sub-row's own per-date value is then
  // gated by history too (assigneeMatchesOnDate/ownerMatchesOnDate below),
  // so a transferred task/project correctly shows nonzero only across the
  // date range this specific person actually held it -- the old assignee's
  // sub-row goes to 0 the day it moves on, the new assignee's sub-row
  // starts contributing from that same day, and the two together always
  // sum to the task/project's real total (no double-count, no gap).
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

  // A task's points on a specific date for a specific person -- 0 if that
  // date isn't one of the task's own working days (out of window, or
  // effort not set yet), OR if history says this person didn't actually
  // hold the assignment on that specific date (post-transfer split).
  function taskPointsOnDate(t: TaskRow, dateStr: string, forPersonId?: string): number {
    const points = t.effort ? TASK_EFFORT_POINTS[t.effort] ?? 0 : 0;
    if (points === 0) return 0;
    const workingDays = taskWorkingDays(t);
    if (!workingDays.includes(dateStr)) return 0;
    if (forPersonId && !assigneeMatchesOnDate(t, forPersonId, dateStr)) return 0;
    return points / workingDays.length;
  }

  // PM-overhead points for everything a person owns on a given date, with
  // the combined cap applied proportionally across projects so the
  // expanded sub-rows always sum exactly to the rollup's PM contribution.
  // "Owns" is evaluated per-date via history, not the project's current
  // owner_id, so a transferred project's PM overhead splits correctly
  // across the handoff date instead of retroactively moving in full.
  function pmPointsFor(personId: string, dateStr: string): { total: number; perProject: Map<string, number> } {
    const owned = ownedProjectsFor(personId).filter((p) => ownerMatchesOnDate(p, personId, dateStr) && projectWorkingDays(p).includes(dateStr));
    const rawTotal = owned.length * PROJECT_PM_POINTS_PER_DAY;
    const scale = rawTotal > PROJECT_PM_POINTS_CAP_PER_DAY && rawTotal > 0 ? PROJECT_PM_POINTS_CAP_PER_DAY / rawTotal : 1;
    const perProject = new Map(owned.map((p) => [p.id, PROJECT_PM_POINTS_PER_DAY * scale]));
    return { total: Math.min(rawTotal, PROJECT_PM_POINTS_CAP_PER_DAY), perProject };
  }

  function dailyPointsFor(personId: string, dateStr: string): number {
    const taskPoints = openTasksFor(personId).reduce((sum, t) => sum + taskPointsOnDate(t, dateStr, personId), 0);
    return taskPoints + pmPointsFor(personId, dateStr).total;
  }

  function dailyCapacityFor(person: PersonRow, halfDay: boolean): number {
    return (person.daily_capacity_hours / STANDARD_DAILY_HOURS) * (halfDay ? 0.5 : 1);
  }

  return (
    <div>
      <h1>Utilization</h1>
      <p className="subtitle">
        Same grid as the Day Planner, but auto-computed: each task's Light/Moderate/Heavy effort is spread across its own start-to-due
        working days, plus a small project-ownership allowance. Set effort and dates on tasks in Projects &amp; Tasks — this view
        updates automatically.
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        <button onClick={() => setWeekOffset((w) => w - rangeWeeks)} className="planner-nav-btn" title={`Previous ${rangeWeeks} week${rangeWeeks > 1 ? "s" : ""}`}>
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
            onChange={(e) => jumpToDate(e.target.value)}
            style={{ fontSize: 11, color: "var(--navy)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "3px 6px" }}
          />
        </label>
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
            </thead>
            <tbody>
              {people.length === 0 ? (
                <tr>
                  <td colSpan={1 + days.length} style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>
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
                        {days.map((d, i) => {
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
                          const points = dailyPointsFor(person.id, dateStr);
                          const capacity = dailyCapacityFor(person, av?.status === "half_day");
                          const pct = capacity > 0 ? (points / capacity) * 100 : points > 0 ? 999 : 0;
                          const tier = tierOf(pct);
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
                                <tier.Icon size={13} />
                                <span>
                                  {tier.key === "none" ? "–" : `${Math.round(pct)}%`}
                                  {av?.status === "half_day" && <span style={{ fontSize: 9, marginLeft: 2 }}>½</span>}
                                </span>
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                      {isExpanded &&
                        (ownedProjects.length === 0 && assignedTasks.length === 0 ? (
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
                            {days.map((_, i) => (
                              <td key={i} style={subCellStyle(i)} />
                            ))}
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
                                  {days.map((d, i) => {
                                    const dateStr = toISO(d);
                                    const dow = d.getDay();
                                    const blocked = dayBlocked(person.id, dateStr, dow);
                                    const win = workingDays.includes(dateStr);
                                    const value = win ? pmPointsFor(person.id, dateStr).perProject.get(p.id) ?? 0 : 0;
                                    return (
                                      <td key={i} style={{ ...subCellStyle(i), background: blocked ? "var(--hover-bg)" : !win ? "#f7f8fa" : undefined, fontSize: 12, color: "var(--muted)" }}>
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
                                    title={!t.effort ? `${t.name} — no effort size set yet` : t.name}
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
                                    {!t.effort && <span style={{ fontSize: 9.5, color: "var(--warning-text)", marginLeft: 6 }}>no effort</span>}
                                  </td>
                                  {days.map((d, i) => {
                                    const dateStr = toISO(d);
                                    const dow = d.getDay();
                                    const blocked = dayBlocked(person.id, dateStr, dow);
                                    const win = workingDays.includes(dateStr);
                                    const value = taskPointsOnDate(t, dateStr, person.id);
                                    return (
                                      <td key={i} style={{ ...subCellStyle(i), background: blocked ? "var(--hover-bg)" : !win ? "#f7f8fa" : undefined, fontSize: 12, color: "var(--muted)" }}>
                                        {value > 0 ? value.toFixed(1) : ""}
                                      </td>
                                    );
                                  })}
                                </tr>
                              );
                            })}
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
        {LEGEND.map(({ pct, label, tone, Icon }) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11 }}>
            <span className={`status-pill ${tone}`} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <Icon size={11} />
              {pct}
            </span>
            <span style={{ color: "var(--muted)" }}>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
