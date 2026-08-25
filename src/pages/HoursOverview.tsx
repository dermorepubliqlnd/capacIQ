import { Fragment, useEffect, useMemo, useState, type CSSProperties } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { TASK_STATUS_GROUPED, statusGroupOf } from "../lib/notionOptions";
import { scopedHoursOnDate } from "../lib/scopedHours";

// Scoped vs Logged overview (2026-08-25). Sandra: "create an overview page
// to show comparisons of Scoped vs Logged" -- a dedicated page (not a Work
// Schedule tab) comparing each task's planned Scoped Hours against actual
// logged hours from Time Tracking. Two views, toggled: a Day grid (same
// person x day shape as Work Schedule, dual value per cell) and a flat
// per-task comparison table -- Sandra asked for both rather than picking
// one, after seeing a mockup of each.

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
const LABEL_W = 220;

// Same 3-tone semantics as Work Schedule/Utilization: how much of a day's
// Scoped Hours actually got logged. Neutral when nothing was scoped at all
// (no expectation to compare against).
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

  const holidayByDate = useMemo(() => {
    const m = new Map<string, HolidayRow>();
    holidays.forEach((h) => m.set(h.date, h));
    return m;
  }, [holidays]);

  const parentTaskIds = useMemo(() => new Set(tasks.filter((t) => t.parent_task_id).map((t) => t.parent_task_id as string)), [tasks]);
  function openTasksFor(personId: string): TaskRow[] {
    return tasks.filter((t) => t.assignee_id === personId && !parentTaskIds.has(t.id) && statusGroupOf(TASK_STATUS_GROUPED, t.status) !== "complete");
  }
  function scopedPersonTotalFor(personId: string, dateStr: string): number {
    return openTasksFor(personId).reduce((sum, t) => sum + scopedHoursOnDate(t, dateStr), 0);
  }
  function loggedPersonTotalFor(personId: string, dateStr: string): number {
    return timeEntries
      .filter((e) => e.person_id === personId && e.started_at.slice(0, 10) === dateStr)
      .reduce((sum, e) => sum + (e.duration_minutes ?? 0) / 60, 0);
  }

  // Per-task rollup for the flat comparison table: Scoped is the task's own
  // flat estimated_hours (not windowed to the visible date range -- this
  // view compares a task's total plan against its total logged-to-date,
  // same "whole task" framing as Projects.tsx's own Est/Spent columns).
  // Logged sums every confirmed/approved entry against the task, any person.
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
            <span style={{ fontSize: 11, color: "var(--muted)" }}>Each cell: Scoped / Logged hours.</span>
          </div>

          <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius)" }}>
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
                    {people.map((person) => (
                      <tr key={person.id}>
                        <td
                          style={{
                            position: "sticky",
                            left: 0,
                            zIndex: 1,
                            background: "var(--surface)",
                            padding: "8px 13px",
                            fontSize: 12,
                            fontWeight: 600,
                            color: "var(--navy)",
                            borderBottom: "1px solid var(--border)",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {person.name}
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
                    ))}
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
