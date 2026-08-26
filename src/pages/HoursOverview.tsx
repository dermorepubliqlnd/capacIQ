import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight, ChevronDown, ChevronRight as ChevronRightIcon } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { TASK_STATUS_GROUPED, statusGroupOf } from "../lib/notionOptions";
import { scopedHoursOnDate } from "../lib/scopedHours";

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

function toISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
const WEEKDAY_LABEL = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const RANGE_OPTIONS = [1, 2, 4] as const;
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
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"grid" | "task">("grid");
  const [expanded, setExpanded] = useState<string[]>([]);

  const [weekOffset, setWeekOffset] = useState(0);
  const [rangeWeeks, setRangeWeeks] = useState<(typeof RANGE_OPTIONS)[number]>(4);
  const [sortBy, setSortBy] = useState<"variance" | "scoped" | "logged" | "name">("variance");

  async function loadAll() {
    setLoading(true);
    const [{ data: p }, { data: pr }, { data: tk }, { data: te }, { data: hol }] = await Promise.all([
      supabase.from("people").select("id,name,daily_capacity_hours,is_active").eq("is_active", true).order("name"),
      supabase.from("projects").select("id,name,is_archived").eq("is_archived", false),
      supabase
        .from("tasks")
        .select("id,project_id,parent_task_id,name,assignee_id,status,start_date,current_due_date,estimated_hours,is_archived")
        .eq("is_archived", false),
      supabase.from("time_entries").select("id,task_id,person_id,started_at,duration_minutes,status").in("status", ["confirmed", "approved"]),
      supabase.from("holidays").select("*"),
    ]);
    setPeople((p as PersonRow[]) ?? []);
    setProjects((pr as ProjectRow[]) ?? []);
    setTasks((tk as TaskRow[]) ?? []);
    setTimeEntries((te as TimeEntryRow[]) ?? []);
    setHolidays((hol as HolidayRow[]) ?? []);
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

  const holidayByDate = useMemo(() => {
    const m = new Map<string, HolidayRow>();
    holidays.forEach((h) => m.set(h.date, h));
    return m;
  }, [holidays]);

  const parentTaskIds = useMemo(() => new Set(tasks.filter((t) => t.parent_task_id).map((t) => t.parent_task_id as string)), [tasks]);

  // Scoped side: only open (non-complete), non-parent tasks currently
  // assigned to this person -- same rule Utilization.tsx's own
  // openTasksFor uses, so this stays comparable to that page's numbers.
  function scopedOpenTasksFor(personId: string): TaskRow[] {
    return tasks.filter((t) => t.assignee_id === personId && !parentTaskIds.has(t.id) && statusGroupOf(TASK_STATUS_GROUPED, t.status) !== "complete");
  }
  function scopedPersonTotalFor(personId: string, dateStr: string): number {
    return scopedOpenTasksFor(personId).reduce((sum, t) => sum + scopedHoursOnDate(t, dateStr), 0);
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
  function scopedHoursFor(personId: string, taskId: string, dateStr: string): number {
    const t = tasks.find((x) => x.id === taskId && x.assignee_id === personId);
    if (!t) return 0;
    return scopedHoursOnDate(t, dateStr);
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
        const owner = people.find((p) => p.id === t.assignee_id);
        const scoped = t.estimated_hours ?? 0;
        const logged = timeEntries.filter((e) => e.task_id === t.id).reduce((sum, e) => sum + (e.duration_minutes ?? 0) / 60, 0);
        return { id: t.id, name: t.name, project: proj?.name ?? "—", owner: owner?.name ?? "Unassigned", scoped, logged, variance: logged - scoped };
      })
      .filter((r) => r.scoped > 0 || r.logged > 0);
  }, [tasks, projects, people, timeEntries, parentTaskIds]);

  const sortedTaskRows = useMemo(() => {
    const rows = [...taskRows];
    if (sortBy === "variance") rows.sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance));
    else if (sortBy === "scoped") rows.sort((a, b) => b.scoped - a.scoped);
    else if (sortBy === "logged") rows.sort((a, b) => b.logged - a.logged);
    else rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  }, [taskRows, sortBy]);

  const taskTotals = useMemo(
    () => taskRows.reduce((acc, r) => ({ scoped: acc.scoped + r.scoped, logged: acc.logged + r.logged }), { scoped: 0, logged: 0 }),
    [taskRows]
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
      <p className="subtitle">
        Compares each task's planned Scoped Hours against actual hours logged via Time Tracking. Read-only — edit Scoped Hours from
        Projects &amp; Tasks or the WBS, and log time from the Time Tracking page.
      </p>

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
            <button
              onClick={() => setWeekOffset((w) => clampWeekOffset(w - rangeWeeks))}
              className="planner-nav-btn"
              disabled={weekOffset <= minWeekOffset}
              title={weekOffset <= minWeekOffset ? "Can't go earlier than Jan 2026" : `Previous ${rangeWeeks} week${rangeWeeks > 1 ? "s" : ""}`}
            >
              <ChevronLeft size={14} />
            </button>
            <button onClick={() => setWeekOffset(0)} className="planner-nav-btn">
              Today
            </button>
            <button onClick={() => setWeekOffset((w) => w + rangeWeeks)} className="planner-nav-btn">
              <ChevronRight size={14} />
            </button>
            <select value={rangeWeeks} onChange={(e) => setRangeWeeks(Number(e.target.value) as (typeof RANGE_OPTIONS)[number])} style={{ fontSize: 12, padding: "4px 6px" }}>
              {RANGE_OPTIONS.map((w) => (
                <option key={w} value={w}>
                  {w} week{w > 1 ? "s" : ""}
                </option>
              ))}
            </select>
            <span style={{ fontSize: 11, color: "var(--muted)" }}>Each cell: Scoped / Logged hours. Click a person to see the task breakdown.</span>
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
                  <Fragment>
                    {people.map((person) => {
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
                              const scoped = scopedPersonTotalFor(person.id, dateStr);
                              const logged = loggedPersonTotalFor(person.id, dateStr);
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
                        const scoped = people.reduce((sum, p) => sum + scopedPersonTotalFor(p.id, dateStr), 0);
                        const logged = people.reduce((sum, p) => sum + loggedPersonTotalFor(p.id, dateStr), 0);
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
          <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--muted)" }}>
            Green = logged covers at least 90% of scoped for that day. Amber = 50–89%. Red = under 50%. Gray "–" = nothing scoped or logged.
            Logged hours always show on the day they were actually worked, even outside a task's scoped window.
          </div>
        </>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <label style={{ fontSize: 12, color: "var(--muted)" }}>Sort by</label>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)} style={{ fontSize: 12, padding: "4px 6px" }}>
              <option value="variance">Variance (largest first)</option>
              <option value="scoped">Scoped hours</option>
              <option value="logged">Logged hours</option>
              <option value="name">Task name</option>
            </select>
          </div>
          <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius)" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: "8px 13px", color: "var(--muted)", fontWeight: 600, fontSize: 12, borderBottom: "1px solid var(--border)" }}>Task</th>
                  <th style={{ textAlign: "left", padding: "8px 13px", color: "var(--muted)", fontWeight: 600, fontSize: 12, borderBottom: "1px solid var(--border)" }}>Project</th>
                  <th style={{ textAlign: "left", padding: "8px 13px", color: "var(--muted)", fontWeight: 600, fontSize: 12, borderBottom: "1px solid var(--border)" }}>Owner</th>
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
                ) : (
                  sortedTaskRows.map((r) => {
                    const varColor = r.variance > 0.05 ? "var(--danger-text)" : r.variance < -0.05 ? "var(--warning-text)" : "var(--success-text)";
                    return (
                      <tr key={r.id}>
                        <td style={{ padding: "7px 13px", borderBottom: "1px solid var(--border)" }}>{r.name}</td>
                        <td style={{ padding: "7px 13px", borderBottom: "1px solid var(--border)", color: "var(--text-secondary)" }}>{r.project}</td>
                        <td style={{ padding: "7px 13px", borderBottom: "1px solid var(--border)", color: "var(--text-secondary)" }}>{r.owner}</td>
                        <td style={{ padding: "7px 13px", borderBottom: "1px solid var(--border)", textAlign: "right" }}>{r.scoped.toFixed(1)}h</td>
                        <td style={{ padding: "7px 13px", borderBottom: "1px solid var(--border)", textAlign: "right" }}>{r.logged.toFixed(1)}h</td>
                        <td style={{ padding: "7px 13px", borderBottom: "1px solid var(--border)", textAlign: "right", fontWeight: 600, color: varColor }}>
                          {r.variance > 0 ? "+" : ""}
                          {r.variance.toFixed(1)}h
                        </td>
                      </tr>
                    );
                  })
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
