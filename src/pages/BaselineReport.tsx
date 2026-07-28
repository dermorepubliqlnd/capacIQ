import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, Lock, Flag, Plus, TrendingUp } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { formatDate } from "../lib/formatDate";
import { WBS_STATUS_META, type WbsStatus } from "../lib/wbsStatus";

// Baseline vs Final performance reporting (Sandra, 2026-07-24):
// "I want to see initial baseline and final performance ... upon locking
// timelines, this saves and cannot be changed ... on project close I want
// to see changes."
//
// Phase 6 (2026-07-28): this page's own freely re-runnable "Close out
// project" / "Re-run close-out" button was RETIRED here -- it let anyone
// with edit access overwrite Final performance at any time with no
// approval, which is exactly the "double closing" Sandra explicitly
// banned ("Closing is final ... should be done via an approval or sign
// off process"). Final is now captured ONLY by decide_wbs_closure, fired
// from an approved Closure Request on the WBS Planning page -- see
// [[project_capaciq_phase6_retire_old_flow]]. This page is now pure
// reporting: it reads whatever Baseline/Final rows exist and shows the
// live plan as a preview until a closure is actually approved.
//
// Baseline itself now also reads the ACTIVE baseline row (is_active =
// true) rather than assuming exactly one ever exists -- Phase 5's
// re-baselining can supersede an old baseline with a new version, so
// there can be more than one project_baselines row per project now.
//
// Reached via a "Report" link next to the WBS Status column on the
// Projects page (shown once wbs_status has moved past Draft, i.e. once a
// baseline exists).

const MODE_LABEL: Record<string, string> = { full_capacity: "Full Effort", standard: "Conservative Effort" };

interface ProjectRow {
  id: string;
  name: string;
  wbs_status: WbsStatus;
}
interface TaskRow {
  id: string;
  project_id: string;
  parent_task_id: string | null;
  name: string;
  estimated_hours: number | null;
  start_date: string | null;
  current_due_date: string | null;
  is_archived: boolean;
}
interface BaselineRow {
  id: string;
  version_number: number;
  captured_at: string;
  mode: string;
  total_est_hours: number;
  task_count: number;
  start_date: string | null;
  end_date: string | null;
}
interface SnapshotTaskRow {
  task_id: string;
  name: string;
  estimated_hours: number | null;
}
interface CloseoutRow {
  id: string;
  closed_at: string;
  mode: string;
  total_est_hours: number;
  task_count: number;
  start_date: string | null;
  end_date: string | null;
}

function liveTotals(tasks: TaskRow[]) {
  const roots = tasks.filter((t) => !t.parent_task_id);
  const totalEstHours = roots.reduce((sum, t) => sum + (t.estimated_hours ?? 0), 0);
  const starts = tasks.map((t) => t.start_date).filter((d): d is string => !!d);
  const ends = tasks.map((t) => t.current_due_date).filter((d): d is string => !!d);
  return {
    totalEstHours,
    taskCount: tasks.length,
    startDate: starts.length ? starts.reduce((a, b) => (b < a ? b : a)) : null,
    endDate: ends.length ? ends.reduce((a, b) => (b > a ? b : a)) : null,
  };
}

export default function BaselineReport() {
  const { projectId } = useParams<{ projectId: string }>();

  const [project, setProject] = useState<ProjectRow | null>(null);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [baseline, setBaseline] = useState<BaselineRow | null>(null);
  const [baselineTasks, setBaselineTasks] = useState<SnapshotTaskRow[]>([]);
  const [closeout, setCloseout] = useState<CloseoutRow | null>(null);
  const [closeoutTasks, setCloseoutTasks] = useState<SnapshotTaskRow[]>([]);
  const [loading, setLoading] = useState(true);

  async function loadAll() {
    if (!projectId) return;
    setLoading(true);
    const [{ data: proj }, { data: tks }, { data: bl }, { data: co }] = await Promise.all([
      supabase.from("projects").select("id,name,wbs_status").eq("id", projectId).single(),
      supabase
        .from("tasks")
        .select("id,project_id,parent_task_id,name,estimated_hours,start_date,current_due_date,is_archived")
        .eq("project_id", projectId)
        .eq("is_archived", false),
      supabase
        .from("project_baselines")
        .select("id,version_number,captured_at,mode,total_est_hours,task_count,start_date,end_date")
        .eq("project_id", projectId)
        .eq("is_active", true)
        .maybeSingle(),
      supabase.from("project_closeouts").select("id,closed_at,mode,total_est_hours,task_count,start_date,end_date").eq("project_id", projectId).maybeSingle(),
    ]);
    setProject((proj as ProjectRow) ?? null);
    setTasks((tks as TaskRow[]) ?? []);
    setBaseline((bl as BaselineRow) ?? null);
    setCloseout((co as CloseoutRow) ?? null);

    if (bl) {
      const { data: blt } = await supabase.from("project_baseline_tasks").select("task_id,name,estimated_hours").eq("baseline_id", (bl as BaselineRow).id);
      setBaselineTasks((blt as SnapshotTaskRow[]) ?? []);
    } else {
      setBaselineTasks([]);
    }
    if (co) {
      const { data: cot } = await supabase.from("project_closeout_tasks").select("task_id,name,estimated_hours").eq("closeout_id", (co as CloseoutRow).id);
      setCloseoutTasks((cot as SnapshotTaskRow[]) ?? []);
    } else {
      setCloseoutTasks([]);
    }
    setLoading(false);
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  if (loading) return <div style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>Loading…</div>;
  if (!project) return <div style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>Project not found.</div>;

  if (!baseline) {
    return (
      <div>
        <Link to={`/projects/${projectId}`} className="back-link" style={{ display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 8, fontSize: 12.5 }}>
          <ArrowLeft size={13} /> Back to {project.name}
        </Link>
        <h1>Baseline vs Final — {project.name}</h1>
        <div className="card" style={{ padding: 14, fontSize: 12.5, color: "var(--muted)" }}>
          No baseline yet -- go to this project's WBS Planning page and Lock Baseline to capture one.
        </div>
      </div>
    );
  }

  const live = liveTotals(tasks);
  const isClosed = project.wbs_status === "closed";
  // "Final" numbers are the frozen close-out snapshot once Closure has
  // been approved; before that, the live totals are shown alongside as a
  // preview of what Final WOULD look like right now.
  const finalTotals = closeout ? { totalEstHours: closeout.total_est_hours, taskCount: closeout.task_count, endDate: closeout.end_date } : null;

  const hoursDelta = (finalTotals ? finalTotals.totalEstHours : live.totalEstHours) - baseline.total_est_hours;
  const taskDelta = (finalTotals ? finalTotals.taskCount : live.taskCount) - baseline.task_count;
  const compareEnd = finalTotals ? finalTotals.endDate : live.endDate;
  const endDaysDelta =
    baseline.end_date && compareEnd ? Math.round((new Date(compareEnd).getTime() - new Date(baseline.end_date).getTime()) / 86400000) : null;

  const baselineTaskIds = new Set(baselineTasks.map((t) => t.task_id));
  const compareTaskList = closeout ? closeoutTasks : tasks.map((t) => ({ task_id: t.id, name: t.name, estimated_hours: t.estimated_hours }));
  const addedTasks = compareTaskList.filter((t) => !baselineTaskIds.has(t.task_id));
  const baselineHoursById = new Map(baselineTasks.map((t) => [t.task_id, t.estimated_hours ?? 0]));
  const grownTasks = compareTaskList
    .filter((t) => baselineHoursById.has(t.task_id) && (t.estimated_hours ?? 0) > (baselineHoursById.get(t.task_id) ?? 0))
    .map((t) => ({ ...t, delta: (t.estimated_hours ?? 0) - (baselineHoursById.get(t.task_id) ?? 0) }));

  function statCard(label: string, icon: React.ReactNode, tone: string, rows: { label: string; value: string }[]) {
    return (
      <div className="card" style={{ padding: 14, flex: 1, minWidth: 220 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10, color: tone, fontWeight: 600, fontSize: 12.5 }}>
          {icon}
          {label}
        </div>
        {rows.map((r) => (
          <div key={r.label} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "3px 0" }}>
            <span style={{ color: "var(--muted)" }}>{r.label}</span>
            <span style={{ fontWeight: 600 }}>{r.value}</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div>
      <Link to={`/projects/${projectId}`} className="back-link" style={{ display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 8, fontSize: 12.5 }}>
        <ArrowLeft size={13} /> Back to {project.name}
      </Link>
      <h1>Baseline vs Final — {project.name}</h1>
      <p className="subtitle">
        Baseline is captured when this project's plan is Locked (or Re-baselined) on the WBS Planning page and never changes on its own. Final is
        captured only once a Closure Request is approved there -- final and not re-runnable.
      </p>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        {statCard(`Baseline V${baseline.version_number} (at lock)`, <Lock size={13} />, "var(--navy)", [
          { label: "Captured", value: formatDate(baseline.captured_at.slice(0, 10)) },
          { label: "Mode", value: MODE_LABEL[baseline.mode] ?? baseline.mode },
          { label: "Est. hours", value: `${baseline.total_est_hours}` },
          { label: "Tasks", value: `${baseline.task_count}` },
          { label: "Start", value: baseline.start_date ? formatDate(baseline.start_date) : "—" },
          { label: "End", value: baseline.end_date ? formatDate(baseline.end_date) : "—" },
        ])}

        {statCard(closeout ? "Final (closed out)" : "Final — not closed out yet", <Flag size={13} />, closeout ? "#1a7f37" : "var(--muted)", [
          { label: closeout ? "Closed" : "Live (preview)", value: closeout ? formatDate(closeout.closed_at.slice(0, 10)) : "current" },
          { label: "Est. hours", value: `${finalTotals ? finalTotals.totalEstHours : live.totalEstHours}` },
          { label: "Tasks", value: `${finalTotals ? finalTotals.taskCount : live.taskCount}` },
          { label: "End", value: compareEnd ? formatDate(compareEnd) : "—" },
        ])}

        {statCard("Variance", <TrendingUp size={13} />, hoursDelta > 0 || taskDelta > 0 ? "#b45309" : "var(--navy)", [
          { label: "Hours", value: `${hoursDelta >= 0 ? "+" : ""}${hoursDelta}` },
          { label: "Tasks", value: `${taskDelta >= 0 ? "+" : ""}${taskDelta}` },
          { label: "End date", value: endDaysDelta === null ? "—" : `${endDaysDelta >= 0 ? "+" : ""}${endDaysDelta} day(s)` },
        ])}
      </div>

      <div
        className="card"
        style={{
          padding: "8px 14px",
          marginBottom: 14,
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: WBS_STATUS_META[project.wbs_status]?.bg,
          borderColor: WBS_STATUS_META[project.wbs_status]?.border,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 700, color: WBS_STATUS_META[project.wbs_status]?.color }}>
          {WBS_STATUS_META[project.wbs_status]?.label ?? project.wbs_status}
        </span>
        <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
          {isClosed
            ? "Final Scope is locked -- the numbers above are permanent."
            : "Final isn't captured yet -- Request Closure on the WBS Planning page to lock it in once this project is done."}
        </span>
        <Link to={`/projects/${projectId}/wbs`} className="back-link" style={{ marginLeft: "auto", fontSize: 12 }}>
          Go to WBS Planning →
        </Link>
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div className="card" style={{ padding: 14, flex: 1, minWidth: 280 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, fontWeight: 600, fontSize: 12.5 }}>
            <Plus size={13} /> Tasks added since baseline ({addedTasks.length})
          </div>
          {addedTasks.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--muted)" }}>None.</div>
          ) : (
            addedTasks.map((t) => (
              <div key={t.task_id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "3px 0" }}>
                <span>{t.name}</span>
                <span style={{ color: "var(--muted)" }}>{t.estimated_hours ?? 0}h</span>
              </div>
            ))
          )}
        </div>

        <div className="card" style={{ padding: 14, flex: 1, minWidth: 280 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, fontWeight: 600, fontSize: 12.5 }}>
            <TrendingUp size={13} /> Tasks whose hours grew ({grownTasks.length})
          </div>
          {grownTasks.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--muted)" }}>None.</div>
          ) : (
            grownTasks.map((t) => (
              <div key={t.task_id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "3px 0" }}>
                <span>{t.name}</span>
                <span style={{ color: "#b45309" }}>+{t.delta}h</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
