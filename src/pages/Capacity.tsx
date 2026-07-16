import { useEffect, useMemo, useState } from "react";
import { Users, Gauge, AlertTriangle, ListChecks } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { TASK_STATUS_GROUPED, statusGroupOf } from "../lib/notionOptions";

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
  estimated_hours: number | null;
  time_spent_hours: number | null;
  current_due_date: string;
  is_archived: boolean;
}

interface ProjectRow {
  id: string;
  name: string;
}

const WORKING_DAYS_PER_WEEK = 5;

// Bandwidth status thresholds — kept intentionally simple (three bands)
// rather than a continuous gradient, to match how the rest of the app
// reads Health/Timing at a glance via a single colored pill.
function utilizationStatus(pct: number): { label: string; tone: "success" | "warning" | "danger" } {
  if (pct > 110) return { label: "Overloaded", tone: "danger" };
  if (pct >= 80) return { label: "Near capacity", tone: "warning" };
  return { label: "Available", tone: "success" };
}

export default function Capacity() {
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [{ data: peopleData }, { data: taskData }, { data: projectData }] = await Promise.all([
        supabase.from("people").select("id,name,reports_to,daily_capacity_hours,is_active").eq("is_active", true).order("name"),
        supabase
          .from("tasks")
          .select("id,project_id,assignee_id,status,estimated_hours,time_spent_hours,current_due_date,is_archived")
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

  // Bandwidth is computed from currently OPEN work only (not Complete) —
  // remaining effort is estimated hours minus hours already logged, floored
  // at 0 so an over-logged task doesn't count as negative demand. Weekly
  // capacity approximates a 5-day work week from the person's own daily
  // capacity (set per-person in User management).
  const rows = useMemo(() => {
    return people
      .map((person) => {
        const openTasks = tasks.filter((t) => {
          if (t.assignee_id !== person.id) return false;
          const group = statusGroupOf(TASK_STATUS_GROUPED, t.status);
          return group !== "complete";
        });
        const estRemaining = openTasks.reduce((sum, t) => {
          const remaining = (t.estimated_hours ?? 0) - (t.time_spent_hours ?? 0);
          return sum + Math.max(0, remaining);
        }, 0);
        const weeklyCapacity = person.daily_capacity_hours * WORKING_DAYS_PER_WEEK;
        const utilizationPct = weeklyCapacity > 0 ? (estRemaining / weeklyCapacity) * 100 : 0;
        const projectSet = new Set(openTasks.map((t) => t.project_id));
        return {
          person,
          openTasks,
          estRemaining,
          weeklyCapacity,
          utilizationPct,
          projectCount: projectSet.size,
          status: utilizationStatus(utilizationPct),
        };
      })
      .sort((a, b) => b.utilizationPct - a.utilizationPct);
  }, [people, tasks]);

  const teamWeeklyCapacity = rows.reduce((sum, r) => sum + r.weeklyCapacity, 0);
  const teamDemand = rows.reduce((sum, r) => sum + r.estRemaining, 0);
  const teamUtilization = teamWeeklyCapacity > 0 ? Math.round((teamDemand / teamWeeklyCapacity) * 100) : 0;
  const overloadedCount = rows.filter((r) => r.status.tone === "danger").length;
  const openTaskCount = rows.reduce((sum, r) => sum + r.openTasks.length, 0);

  return (
    <div>
      <h1>Capacity</h1>
      <p className="subtitle">
        Bandwidth by person, based on open tasks&apos; remaining estimated hours against weekly capacity (daily capacity ×{" "}
        {WORKING_DAYS_PER_WEEK} days). Set daily capacity per person in User management.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 16 }}>
        <div className="metric-card">
          <div className="metric-icon">
            <Users size={15} />
          </div>
          <p className="metric-label">Team weekly capacity</p>
          <p className="metric-value metric-value-lg">{Math.round(teamWeeklyCapacity)}h</p>
          <p className="metric-sub">{rows.length} active people</p>
        </div>

        <div className="metric-card">
          <div className="metric-icon teal">
            <Gauge size={15} />
          </div>
          <p className="metric-label">Team utilization</p>
          <p className="metric-value metric-value-lg">{teamUtilization}%</p>
          <p className="metric-sub">{Math.round(teamDemand)}h of open work</p>
        </div>

        <div className="metric-card">
          <div className="metric-icon danger">
            <AlertTriangle size={15} />
          </div>
          <p className="metric-label">Overloaded</p>
          <p className="metric-value metric-value-lg">{overloadedCount}</p>
          <p className="metric-sub">People over 110% capacity</p>
        </div>

        <div className="metric-card">
          <div className="metric-icon warning">
            <ListChecks size={15} />
          </div>
          <p className="metric-label">Open tasks</p>
          <p className="metric-value metric-value-lg">{openTaskCount}</p>
          <p className="metric-sub">Not yet marked Done</p>
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
                <th style={{ width: "20%" }}>Person</th>
                <th style={{ width: "14%" }}>Reports to</th>
                <th style={{ width: "10%" }}>Open tasks</th>
                <th style={{ width: "12%" }}>Est. remaining</th>
                <th style={{ width: "12%" }}>Weekly capacity</th>
                <th style={{ width: "20%" }}>Utilization</th>
                <th style={{ width: "12%" }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ person, openTasks, estRemaining, weeklyCapacity, utilizationPct, projectCount, status }) => (
                <tr key={person.id}>
                  <td style={{ fontWeight: 600, color: "var(--navy)" }}>{person.name}</td>
                  <td style={{ color: "var(--muted)" }}>{managerName(person.reports_to)}</td>
                  <td>
                    {openTasks.length}
                    {projectCount > 0 && (
                      <span style={{ color: "var(--muted)", fontSize: 10.5 }}> ({projectCount} project{projectCount > 1 ? "s" : ""})</span>
                    )}
                  </td>
                  <td>{estRemaining.toFixed(1)}h</td>
                  <td>{weeklyCapacity.toFixed(1)}h</td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ flex: 1, height: 6, borderRadius: 3, background: "var(--hover-bg)", overflow: "hidden" }}>
                        <div
                          style={{
                            width: `${Math.min(100, utilizationPct)}%`,
                            height: "100%",
                            background:
                              status.tone === "danger" ? "var(--danger-text)" : status.tone === "warning" ? "var(--warning-text)" : "var(--success-text)",
                          }}
                        />
                      </div>
                      <span style={{ fontSize: 11, color: "var(--muted)", width: 34, flexShrink: 0 }}>{Math.round(utilizationPct)}%</span>
                    </div>
                  </td>
                  <td>
                    <span className={`status-pill ${status.tone}`}>{status.label}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p style={{ color: "var(--muted)", fontSize: 11, marginTop: 10 }}>
        This reads live from Projects &amp; Tasks — assign owners/tasks and set estimated hours there, and this view updates automatically.
      </p>
    </div>
  );
}
