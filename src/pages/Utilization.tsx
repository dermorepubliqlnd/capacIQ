import { useEffect, useMemo, useState } from "react";
import { Users, Gauge, AlertTriangle, ListChecks, Minus, Circle, CheckCircle2, ChevronLeft, ChevronRight } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { TASK_STATUS_GROUPED, TASK_EFFORT_POINTS, statusGroupOf } from "../lib/notionOptions";

interface PersonRow {
  id: string;
  name: string;
  reports_to: string | null;
  daily_capacity_hours: number;
  is_active: boolean;
}

interface TaskRow {
  id: string;
  project_id: string;
  assignee_id: string | null;
  status: string | null;
  start_date: string | null;
  current_due_date: string;
  effort: string | null;
  is_archived: boolean;
}

interface ProjectRow {
  id: string;
  name: string;
}

// A "standard" workday, used only to normalize weekly point-capacity — a
// person whose own daily capacity (set in User management) equals this
// gets a weekly capacity of exactly 5 points, i.e. one Heavy (2-pt) task's
// worth of work most days. Not shown anywhere; purely a conversion factor.
const STANDARD_DAILY_HOURS = 7.5;
const WORKING_DAYS_PER_WEEK = 5;

function toISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}
// Monday-based start of week, in local time (never UTC — see parseLocalDate).
function startOfWeek(d: Date): Date {
  const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = copy.getDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(copy, diff);
}
// Never use `new Date("YYYY-MM-DD")` directly — it parses as UTC midnight
// and can shift a day in negative-UTC-offset timezones (e.g. PH is +8, so
// this specific bug wouldn't hit Manila, but the team may travel/VPN).
function parseLocalDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// The 5 tiers Sandra specified, verbatim thresholds: 0 = grey, 1-59% =
// light green, 60-80% = green, 81-100% = yellow, >100% = red. Icons use
// the pill's own darker text color automatically (Lucide strokes inherit
// currentColor), so they read as "darker line icons" against the fill.
function tierOf(pct: number): { key: string; label: string; tone: string; Icon: typeof Minus } {
  if (pct <= 0) return { key: "none", label: "No project", tone: "neutral", Icon: Minus };
  if (pct < 60) return { key: "available", label: "Available", tone: "available", Icon: Circle };
  if (pct <= 80) return { key: "healthy", label: "Healthy", tone: "success", Icon: CheckCircle2 };
  if (pct <= 100) return { key: "near_full", label: "Near full capacity", tone: "warning", Icon: AlertTriangle };
  return { key: "overloaded", label: "Overloaded", tone: "danger", Icon: AlertTriangle };
}

const LEGEND = [
  { pct: "0%", label: "No project", tone: "neutral", Icon: Minus },
  { pct: "1–59%", label: "Available", tone: "available", Icon: Circle },
  { pct: "60–80%", label: "Healthy", tone: "success", Icon: CheckCircle2 },
  { pct: "81–100%", label: "Near full capacity", tone: "warning", Icon: AlertTriangle },
  { pct: "100%+", label: "Overloaded", tone: "danger", Icon: AlertTriangle },
];

export default function Utilization() {
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [weekOffset, setWeekOffset] = useState(0);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [{ data: peopleData }, { data: taskData }, { data: projectData }] = await Promise.all([
        supabase.from("people").select("id,name,reports_to,daily_capacity_hours,is_active").eq("is_active", true).order("name"),
        supabase
          .from("tasks")
          .select("id,project_id,assignee_id,status,start_date,current_due_date,effort,is_archived")
          .eq("is_archived", false),
        supabase.from("projects").select("id,name").eq("is_archived", false),
      ]);
      setPeople((peopleData as PersonRow[]) ?? []);
      setTasks((taskData as TaskRow[]) ?? []);
      setProjects((projectData as ProjectRow[]) ?? []);
      setLoading(false);
    })();
  }, []);

  const managerName = (id: string | null) => people.find((p) => p.id === id)?.name ?? "—";

  const weekStart = useMemo(() => addDays(startOfWeek(new Date()), weekOffset * 7), [weekOffset]);
  const weekDays = useMemo(() => Array.from({ length: WORKING_DAYS_PER_WEEK }, (_, i) => toISO(addDays(weekStart, i))), [weekStart]);
  const weekEndLabel = addDays(weekStart, 4);
  const weekLabel = `${weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${weekEndLabel.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}`;

  // The core of the date-aware rewrite: instead of summing a task's whole
  // remaining estimate regardless of when it's due (the old behavior that
  // lumped Jo's tasks — due weeks apart — into one blended number), each
  // task's effort points are spread evenly across its own Mon-Fri working
  // days between start and due date, and only the days that land in the
  // week being viewed count toward that week's utilization.
  const rows = useMemo(() => {
    return people
      .map((person) => {
        const openTasks = tasks.filter((t) => {
          if (t.assignee_id !== person.id) return false;
          return statusGroupOf(TASK_STATUS_GROUPED, t.status) !== "complete";
        });

        let weeklyPoints = 0;
        let tasksThisWeek = 0;
        let tasksMissingEffort = 0;
        const projectSet = new Set<string>();

        for (const t of openTasks) {
          const points = t.effort ? TASK_EFFORT_POINTS[t.effort] ?? 0 : 0;
          if (!t.effort) tasksMissingEffort++;

          const windowStartISO = t.start_date ?? t.current_due_date;
          const windowStart = parseLocalDate(windowStartISO);
          const windowEnd = parseLocalDate(t.current_due_date);
          if (windowEnd < windowStart) continue; // guarded against at entry, but be defensive

          const workingDays: string[] = [];
          for (let d = new Date(windowStart); d <= windowEnd; d = addDays(d, 1)) {
            const dow = d.getDay();
            if (dow !== 0 && dow !== 6) workingDays.push(toISO(d));
          }
          // Fallback: a window that's entirely a weekend (e.g. a task due
          // Saturday with no start date) still needs to count somewhere,
          // so treat the due date itself as the single working day.
          if (workingDays.length === 0) workingDays.push(t.current_due_date);

          const pointsPerDay = points / workingDays.length;
          const daysInThisWeek = workingDays.filter((iso) => weekDays.includes(iso));
          if (daysInThisWeek.length > 0) {
            weeklyPoints += pointsPerDay * daysInThisWeek.length;
            tasksThisWeek++;
            projectSet.add(t.project_id);
          }
        }

        const weeklyPointCapacity = (person.daily_capacity_hours / STANDARD_DAILY_HOURS) * WORKING_DAYS_PER_WEEK;
        const utilizationPct = weeklyPointCapacity > 0 ? (weeklyPoints / weeklyPointCapacity) * 100 : 0;

        return {
          person,
          tasksThisWeek,
          tasksMissingEffort,
          weeklyPoints,
          weeklyPointCapacity,
          utilizationPct,
          projectCount: projectSet.size,
          tier: tierOf(utilizationPct),
        };
      })
      .sort((a, b) => b.utilizationPct - a.utilizationPct);
  }, [people, tasks, weekDays]);

  const teamCapacity = rows.reduce((sum, r) => sum + r.weeklyPointCapacity, 0);
  const teamPoints = rows.reduce((sum, r) => sum + r.weeklyPoints, 0);
  const teamUtilization = teamCapacity > 0 ? Math.round((teamPoints / teamCapacity) * 100) : 0;
  const overloadedCount = rows.filter((r) => r.tier.key === "overloaded").length;
  const nearFullCount = rows.filter((r) => r.tier.key === "near_full").length;
  const tasksThisWeekCount = rows.reduce((sum, r) => sum + r.tasksThisWeek, 0);
  const missingEffortCount = rows.reduce((sum, r) => sum + r.tasksMissingEffort, 0);

  return (
    <div>
      <h1>Utilization</h1>
      <p className="subtitle">
        Weekly utilization by person — each task's Light/Moderate/Heavy effort is spread across its own start-to-due working days, so
        only the days that fall in the week below count. Set effort and dates on tasks in Projects &amp; Tasks.
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <button className="planner-nav-btn" onClick={() => setWeekOffset((w) => w - 1)} title="Previous week">
          <ChevronLeft size={13} />
        </button>
        <button className="planner-nav-btn" onClick={() => setWeekOffset((w) => w + 1)} title="Next week">
          <ChevronRight size={13} />
        </button>
        <span style={{ fontWeight: 600, color: "var(--navy)", fontSize: 13 }}>{weekLabel}</span>
        {weekOffset !== 0 && (
          <button className="row-icon-btn" onClick={() => setWeekOffset(0)} title="Back to this week" style={{ fontSize: 11, width: "auto", padding: "0 8px" }}>
            This week
          </button>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 16 }}>
        <div className="metric-card">
          <div className="metric-icon teal">
            <Gauge size={15} />
          </div>
          <p className="metric-label">Team utilization</p>
          <p className="metric-value metric-value-lg">{teamUtilization}%</p>
          <p className="metric-sub">{rows.length} active people</p>
        </div>

        <div className="metric-card">
          <div className="metric-icon danger">
            <AlertTriangle size={15} />
          </div>
          <p className="metric-label">Overloaded</p>
          <p className="metric-value metric-value-lg">{overloadedCount}</p>
          <p className="metric-sub">Over 100% this week</p>
        </div>

        <div className="metric-card">
          <div className="metric-icon warning">
            <Users size={15} />
          </div>
          <p className="metric-label">Near full capacity</p>
          <p className="metric-value metric-value-lg">{nearFullCount}</p>
          <p className="metric-sub">81–100% this week</p>
        </div>

        <div className="metric-card">
          <div className="metric-icon">
            <ListChecks size={15} />
          </div>
          <p className="metric-label">Tasks landing this week</p>
          <p className="metric-value metric-value-lg">{tasksThisWeekCount}</p>
          <p className="metric-sub">{missingEffortCount > 0 ? `${missingEffortCount} missing an effort size` : "All sized"}</p>
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        {loading ? (
          <div style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>No active people found.</div>
        ) : (
          <table className="data-table" style={{ width: "100%", tableLayout: "fixed" }}>
            <thead>
              <tr>
                <th style={{ width: "22%" }}>Person</th>
                <th style={{ width: "16%" }}>Reports to</th>
                <th style={{ width: "14%" }}>Tasks this week</th>
                <th style={{ width: "16%" }}>Points / capacity</th>
                <th style={{ width: "32%" }}>Utilization</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ person, tasksThisWeek, projectCount, weeklyPoints, weeklyPointCapacity, utilizationPct, tier }) => (
                <tr key={person.id}>
                  <td style={{ fontWeight: 600, color: "var(--navy)" }}>{person.name}</td>
                  <td style={{ color: "var(--muted)" }}>{managerName(person.reports_to)}</td>
                  <td>
                    {tasksThisWeek}
                    {projectCount > 0 && (
                      <span style={{ color: "var(--muted)", fontSize: 10.5 }}> ({projectCount} project{projectCount > 1 ? "s" : ""})</span>
                    )}
                  </td>
                  <td style={{ color: "var(--muted)" }}>
                    {weeklyPoints.toFixed(1)} / {weeklyPointCapacity.toFixed(1)}
                  </td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className={`status-pill ${tier.tone}`} style={{ display: "inline-flex", alignItems: "center", gap: 4 }} title={tier.label}>
                        <tier.Icon size={11} />
                        {tier.key === "none" ? tier.label : `${Math.round(utilizationPct)}%`}
                      </span>
                      <div style={{ flex: 1, height: 6, borderRadius: 3, background: "var(--hover-bg)", overflow: "hidden" }}>
                        <div
                          style={{
                            width: `${Math.max(0, Math.min(100, utilizationPct))}%`,
                            height: "100%",
                            background:
                              tier.tone === "danger"
                                ? "var(--danger-text)"
                                : tier.tone === "warning"
                                ? "var(--warning-text)"
                                : tier.tone === "success"
                                ? "var(--success-text)"
                                : tier.tone === "available"
                                ? "var(--available-text)"
                                : "var(--muted)",
                          }}
                        />
                      </div>
                    </div>
                  </td>
                </tr>
              ))}
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

      <p style={{ color: "var(--muted)", fontSize: 11, marginTop: 10 }}>
        This reads live from Projects &amp; Tasks — set each task's Effort (Light/Moderate/Heavy) and its start/due dates there, and
        this view updates automatically.
      </p>
    </div>
  );
}
