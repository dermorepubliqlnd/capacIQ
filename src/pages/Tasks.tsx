import { useEffect, useMemo, useState, type FormEvent, type CSSProperties } from "react";
import { Plus, Pencil } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useSession } from "../lib/useSession";
import { useTableViews } from "../lib/useTableViews";
import DataTable from "../components/DataTable";
import ViewTabs from "../components/ViewTabs";
import ColumnsMenu from "../components/ColumnsMenu";
import Modal from "../components/Modal";
import type { ColumnDef, GroupOption } from "../lib/tableTypes";

interface PersonOption {
  id: string;
  name: string;
}

interface ProjectOption {
  id: string;
  name: string;
}

interface TaskRow {
  id: string;
  project_id: string;
  name: string;
  phase: string | null;
  status: string | null;
  assignee_id: string | null;
  start_date: string | null;
  original_due_date: string;
  current_due_date: string;
  estimated_hours: number | null;
  time_spent_hours: number | null;
  submitted_on: string | null;
  validated_completion_date: string | null;
}

const COLUMN_ORDER = ["name", "project", "assignee", "phase", "status", "timing", "current_due_date", "estimated_hours", "time_spent_hours"];

function timingOf(t: TaskRow): { label: string; tone: "success" | "warning" | "danger" | "neutral" } {
  const doneStatus = (t.status ?? "").toLowerCase();
  const isDone = doneStatus.includes("complete") || doneStatus.includes("done") || !!t.validated_completion_date;
  const due = new Date(t.current_due_date);
  const today = new Date();

  if (isDone) {
    if (t.validated_completion_date && new Date(t.validated_completion_date) > due) return { label: "Late", tone: "danger" };
    return { label: "On time", tone: "success" };
  }
  const daysLeft = (due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24);
  if (daysLeft < 0) return { label: "Overdue", tone: "danger" };
  if (daysLeft <= 3) return { label: "Due soon", tone: "warning" };
  return { label: "On track", tone: "neutral" };
}

function statusTone(status: string | null): "success" | "warning" | "danger" | "neutral" {
  const s = (status ?? "").toLowerCase();
  if (s.includes("complete") || s.includes("done")) return "success";
  if (s.includes("progress") || s.includes("review")) return "warning";
  if (s.includes("block")) return "danger";
  return "neutral";
}

export default function Tasks() {
  const { person: me } = useSession();
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [people, setPeople] = useState<PersonOption[]>([]);
  const [projectOptions, setProjectOptions] = useState<ProjectOption[]>([]);
  const [loading, setLoading] = useState(true);

  const [formOpen, setFormOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [status, setStatus] = useState("Not started");
  const [originalDue, setOriginalDue] = useState("");
  const [estimatedHours, setEstimatedHours] = useState("");

  const [editing, setEditing] = useState<TaskRow | null>(null);
  const [editSaving, setEditSaving] = useState(false);

  const canManage = me?.access_level === "full";

  async function loadAll() {
    setLoading(true);
    const [{ data: taskData }, { data: peopleData }, { data: projectData }] = await Promise.all([
      supabase.from("tasks").select("*").order("current_due_date"),
      supabase.from("people").select("id,name").eq("is_active", true).order("name"),
      supabase.from("projects").select("id,name").order("name"),
    ]);
    setTasks((taskData as TaskRow[]) ?? []);
    setPeople((peopleData as PersonOption[]) ?? []);
    setProjectOptions((projectData as ProjectOption[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    loadAll();
  }, []);

  const personName = (id: string | null) => people.find((p) => p.id === id)?.name ?? "—";
  const projectName = (id: string) => projectOptions.find((p) => p.id === id)?.name ?? "—";

  const columns: ColumnDef<TaskRow>[] = useMemo(
    () => [
      {
        key: "name",
        label: "Task",
        defaultWidth: 220,
        minWidth: 160,
        render: (t) => <span style={{ fontWeight: 600, color: "var(--navy)" }}>{t.name}</span>,
      },
      { key: "project", label: "Project", defaultWidth: 160, render: (t) => projectName(t.project_id) },
      { key: "assignee", label: "Assignee", defaultWidth: 130, render: (t) => personName(t.assignee_id) },
      { key: "phase", label: "Phase", defaultWidth: 110, render: (t) => t.phase ?? "—" },
      {
        key: "status",
        label: "Status",
        defaultWidth: 120,
        render: (t) => (t.status ? <span className={`status-pill ${statusTone(t.status)}`}>{t.status}</span> : "—"),
      },
      {
        key: "timing",
        label: "Timing",
        defaultWidth: 100,
        render: (t) => {
          const timing = timingOf(t);
          return <span className={`status-pill ${timing.tone}`}>{timing.label}</span>;
        },
      },
      { key: "current_due_date", label: "Due", defaultWidth: 100, render: (t) => t.current_due_date },
      { key: "estimated_hours", label: "Est. hrs", defaultWidth: 80, render: (t) => t.estimated_hours ?? "—" },
      { key: "time_spent_hours", label: "Spent hrs", defaultWidth: 85, render: (t) => t.time_spent_hours ?? 0 },
    ],
    [people, projectOptions]
  );

  const groupOptions: GroupOption<TaskRow>[] = [
    { key: "status", label: "Status", getGroup: (t) => t.status ?? "No status" },
    { key: "project", label: "Project", getGroup: (t) => projectName(t.project_id) },
    { key: "assignee", label: "Assignee", getGroup: (t) => personName(t.assignee_id) },
  ];

  const { views, activeView, activeViewId, setActiveViewId, updateActiveView, createView, renameView, deleteView } = useTableViews(
    "tasks",
    me?.id,
    { columnOrder: COLUMN_ORDER, hiddenColumns: [], columnWidths: {}, groupBy: "status" }
  );

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!projectId) {
      setFormError("Pick a project first.");
      return;
    }
    setSubmitting(true);
    const { error } = await supabase.from("tasks").insert({
      project_id: projectId,
      name,
      assignee_id: assigneeId || null,
      status,
      original_due_date: originalDue,
      current_due_date: originalDue,
      estimated_hours: estimatedHours ? Number(estimatedHours) : null,
    });
    setSubmitting(false);
    if (error) {
      setFormError(error.message);
      return;
    }
    setName("");
    setAssigneeId("");
    setStatus("Not started");
    setOriginalDue("");
    setEstimatedHours("");
    setFormOpen(false);
    loadAll();
  }

  async function saveEdit() {
    if (!editing) return;
    setEditSaving(true);
    const { error } = await supabase
      .from("tasks")
      .update({
        name: editing.name,
        assignee_id: editing.assignee_id,
        phase: editing.phase,
        status: editing.status,
        current_due_date: editing.current_due_date,
        estimated_hours: editing.estimated_hours,
        time_spent_hours: editing.time_spent_hours,
      })
      .eq("id", editing.id);
    setEditSaving(false);
    if (error) {
      window.alert(`Couldn't save: ${error.message}`);
      return;
    }
    setEditing(null);
    loadAll();
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1>Tasks</h1>
          <p className="subtitle">Every task across all projects, grouped by status by default.</p>
        </div>
        {canManage && (
          <button
            onClick={() => setFormOpen((v) => !v)}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 12px", fontSize: 12, fontWeight: 600, color: "#fff", background: "var(--navy)", border: "none" }}
          >
            <Plus size={14} />
            {formOpen ? "Cancel" : "New task"}
          </button>
        )}
      </div>

      {formOpen && (
        <form onSubmit={handleCreate} className="card" style={{ marginBottom: 16, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          <label style={labelStyle}>
            Task name
            <input required value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
          </label>
          <label style={labelStyle}>
            Project
            <select required value={projectId} onChange={(e) => setProjectId(e.target.value)} style={inputStyle}>
              <option value="">— select —</option>
              {projectOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            Assignee
            <select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} style={inputStyle}>
              <option value="">— none —</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            Status
            <input value={status} onChange={(e) => setStatus(e.target.value)} style={inputStyle} />
          </label>
          <label style={labelStyle}>
            Due date
            <input required type="date" value={originalDue} onChange={(e) => setOriginalDue(e.target.value)} style={inputStyle} />
          </label>
          <label style={labelStyle}>
            Estimated hours
            <input type="number" step="0.5" value={estimatedHours} onChange={(e) => setEstimatedHours(e.target.value)} style={inputStyle} />
          </label>
          <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 10 }}>
            <button type="submit" disabled={submitting} style={{ padding: "7px 14px", fontSize: 12, fontWeight: 600, color: "#fff", background: "var(--accent)", border: "none" }}>
              {submitting ? "Creating…" : "Create task"}
            </button>
            {formError && <span style={{ fontSize: 11.5, color: "var(--danger-text)" }}>{formError}</span>}
          </div>
        </form>
      )}

      <div className="card" style={{ padding: 0 }}>
        <div className="table-toolbar">
          <ViewTabs
            views={views}
            activeViewId={activeViewId}
            onSelect={setActiveViewId}
            onCreate={createView}
            onRename={renameView}
            onDelete={deleteView}
          />
          <ColumnsMenu
            columns={columns}
            hiddenColumns={activeView.hiddenColumns}
            onToggleColumn={(key) =>
              updateActiveView({
                hiddenColumns: activeView.hiddenColumns.includes(key)
                  ? activeView.hiddenColumns.filter((k) => k !== key)
                  : [...activeView.hiddenColumns, key],
              })
            }
            groupOptions={groupOptions}
            groupBy={activeView.groupBy}
            onGroupByChange={(groupBy) => updateActiveView({ groupBy })}
          />
        </div>
        {loading ? (
          <div style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>Loading…</div>
        ) : (
          <div className="data-table-dense">
            <DataTable
              columns={[
                ...columns,
                canManage
                  ? {
                      key: "__edit",
                      label: "",
                      defaultWidth: 60,
                      minWidth: 50,
                      render: (t: TaskRow) => (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditing(t);
                          }}
                          style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", color: "var(--accent)", fontSize: 11 }}
                        >
                          <Pencil size={12} />
                          Edit
                        </button>
                      ),
                    }
                  : undefined,
              ].filter(Boolean) as ColumnDef<TaskRow>[]}
              rows={tasks}
              rowKey={(t) => t.id}
              view={activeView}
              onViewChange={updateActiveView}
              groupOptions={groupOptions}
              emptyLabel="No tasks yet. Use “New task” to add the first one."
            />
          </div>
        )}
      </div>

      {editing && (
        <Modal title={`Edit ${editing.name}`} onClose={() => setEditing(null)}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <label style={labelStyle}>
              Task name
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} style={inputStyle} />
            </label>
            <label style={labelStyle}>
              Assignee
              <select value={editing.assignee_id ?? ""} onChange={(e) => setEditing({ ...editing, assignee_id: e.target.value || null })} style={inputStyle}>
                <option value="">— none —</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label style={labelStyle}>
              Phase
              <input value={editing.phase ?? ""} onChange={(e) => setEditing({ ...editing, phase: e.target.value })} style={inputStyle} />
            </label>
            <label style={labelStyle}>
              Status
              <input value={editing.status ?? ""} onChange={(e) => setEditing({ ...editing, status: e.target.value })} style={inputStyle} />
            </label>
            <label style={labelStyle}>
              Current due date
              <input type="date" value={editing.current_due_date} onChange={(e) => setEditing({ ...editing, current_due_date: e.target.value })} style={inputStyle} />
            </label>
            <label style={labelStyle}>
              Estimated hours
              <input
                type="number"
                step="0.5"
                value={editing.estimated_hours ?? ""}
                onChange={(e) => setEditing({ ...editing, estimated_hours: e.target.value ? Number(e.target.value) : null })}
                style={inputStyle}
              />
            </label>
            <label style={labelStyle}>
              Time spent (hrs)
              <input
                type="number"
                step="0.5"
                value={editing.time_spent_hours ?? 0}
                onChange={(e) => setEditing({ ...editing, time_spent_hours: Number(e.target.value) })}
                style={inputStyle}
              />
            </label>
          </div>
          <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 8 }}>
            Note: <code>current_due_date</code> is meant to change only through an approved extension request. Editing it directly here is a manual
            override — use with care.
          </p>
          <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
            <button
              onClick={saveEdit}
              disabled={editSaving}
              style={{ padding: "7px 14px", fontSize: 12, fontWeight: 600, color: "#fff", background: "var(--accent)", border: "none" }}
            >
              {editSaving ? "Saving…" : "Save changes"}
            </button>
            <button onClick={() => setEditing(null)} style={{ padding: "7px 14px", fontSize: 12, color: "var(--muted)", background: "none", border: "1px solid var(--border)" }}>
              Cancel
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

const labelStyle: CSSProperties = { fontSize: 11.5, fontWeight: 600, color: "var(--text-secondary)" };

const inputStyle: CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: 4,
  padding: "6px 8px",
  fontSize: 12,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
};
