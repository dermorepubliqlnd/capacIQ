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

interface ProjectRow {
  id: string;
  name: string;
  owner_id: string | null;
  category: string | null;
  priority: "Low" | "Medium" | "High" | null;
  project_status: string | null;
  project_source: string | null;
  summary: string | null;
  effort_level: string | null;
  training_delivery_status: string | null;
  start_date: string | null;
  end_date: string | null;
}

const COLUMN_ORDER = ["name", "owner", "priority", "project_status", "health", "category", "effort_level", "start_date", "end_date"];

function healthOf(p: ProjectRow): { label: string; tone: "success" | "warning" | "danger" | "neutral" } {
  const done = (p.project_status ?? "").toLowerCase();
  if (done.includes("complete") || done.includes("done")) return { label: "Complete", tone: "neutral" };
  if (!p.end_date) return { label: "On track", tone: "success" };
  const today = new Date();
  const end = new Date(p.end_date);
  const daysLeft = (end.getTime() - today.getTime()) / (1000 * 60 * 60 * 24);
  if (daysLeft < 0) return { label: "Overdue", tone: "danger" };
  if (daysLeft <= 7) return { label: "Due soon", tone: "warning" };
  return { label: "On track", tone: "success" };
}

function priorityTone(priority: string | null): "success" | "warning" | "danger" | "neutral" {
  if (priority === "High") return "danger";
  if (priority === "Medium") return "warning";
  if (priority === "Low") return "success";
  return "neutral";
}

export default function Projects() {
  const { person: me } = useSession();
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [people, setPeople] = useState<PersonOption[]>([]);
  const [loading, setLoading] = useState(true);

  const [formOpen, setFormOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [category, setCategory] = useState("");
  const [priority, setPriority] = useState<"Low" | "Medium" | "High">("Medium");
  const [projectStatus, setProjectStatus] = useState("Not started");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const [editing, setEditing] = useState<ProjectRow | null>(null);
  const [editSaving, setEditSaving] = useState(false);

  const canManage = me?.access_level === "full";

  async function loadAll() {
    setLoading(true);
    const [{ data: projectData }, { data: peopleData }] = await Promise.all([
      supabase.from("projects").select("*").order("name"),
      supabase.from("people").select("id,name").eq("is_active", true).order("name"),
    ]);
    setProjects((projectData as ProjectRow[]) ?? []);
    setPeople((peopleData as PersonOption[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    loadAll();
  }, []);

  const ownerName = (id: string | null) => people.find((p) => p.id === id)?.name ?? "—";

  const columns: ColumnDef<ProjectRow>[] = useMemo(
    () => [
      {
        key: "name",
        label: "Project",
        defaultWidth: 230,
        minWidth: 160,
        render: (p) => <span style={{ fontWeight: 600, color: "var(--navy)" }}>{p.name}</span>,
      },
      { key: "owner", label: "Owner", defaultWidth: 140, render: (p) => ownerName(p.owner_id) },
      {
        key: "priority",
        label: "Priority",
        defaultWidth: 100,
        render: (p) => (p.priority ? <span className={`status-pill ${priorityTone(p.priority)}`}>{p.priority}</span> : "—"),
      },
      {
        key: "project_status",
        label: "Status",
        defaultWidth: 130,
        render: (p) => p.project_status ?? "—",
      },
      {
        key: "health",
        label: "Health",
        defaultWidth: 110,
        render: (p) => {
          const h = healthOf(p);
          return <span className={`status-pill ${h.tone}`}>{h.label}</span>;
        },
      },
      { key: "category", label: "Category", defaultWidth: 130, render: (p) => p.category ?? "—" },
      { key: "effort_level", label: "Effort", defaultWidth: 100, render: (p) => p.effort_level ?? "—" },
      { key: "start_date", label: "Start", defaultWidth: 100, render: (p) => p.start_date ?? "—" },
      { key: "end_date", label: "Due", defaultWidth: 100, render: (p) => p.end_date ?? "—" },
    ],
    [people]
  );

  const groupOptions: GroupOption<ProjectRow>[] = [
    { key: "project_status", label: "Status", getGroup: (p) => p.project_status ?? "No status" },
    { key: "priority", label: "Priority", getGroup: (p) => p.priority ?? "No priority" },
    { key: "owner", label: "Owner", getGroup: (p) => ownerName(p.owner_id) },
    { key: "category", label: "Category", getGroup: (p) => p.category ?? "Uncategorized" },
  ];

  const { views, activeView, activeViewId, setActiveViewId, updateActiveView, createView, renameView, deleteView } = useTableViews(
    "projects",
    me?.id,
    { columnOrder: COLUMN_ORDER, hiddenColumns: [], columnWidths: {}, groupBy: null }
  );

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    const { error } = await supabase.from("projects").insert({
      name,
      owner_id: ownerId || null,
      category: category || null,
      priority,
      project_status: projectStatus || null,
      start_date: startDate || null,
      end_date: endDate || null,
    });
    setSubmitting(false);
    if (error) {
      setFormError(error.message);
      return;
    }
    setName("");
    setOwnerId("");
    setCategory("");
    setPriority("Medium");
    setProjectStatus("Not started");
    setStartDate("");
    setEndDate("");
    setFormOpen(false);
    loadAll();
  }

  async function saveEdit() {
    if (!editing) return;
    setEditSaving(true);
    const { error } = await supabase
      .from("projects")
      .update({
        name: editing.name,
        owner_id: editing.owner_id,
        category: editing.category,
        priority: editing.priority,
        project_status: editing.project_status,
        effort_level: editing.effort_level,
        summary: editing.summary,
        start_date: editing.start_date,
        end_date: editing.end_date,
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
          <h1>Projects</h1>
          <p className="subtitle">All active and past L&amp;D projects, with owner and health at a glance.</p>
        </div>
        {canManage && (
          <button
            onClick={() => setFormOpen((v) => !v)}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 12px", fontSize: 12, fontWeight: 600, color: "#fff", background: "var(--navy)", border: "none" }}
          >
            <Plus size={14} />
            {formOpen ? "Cancel" : "New project"}
          </button>
        )}
      </div>

      {formOpen && (
        <form onSubmit={handleCreate} className="card" style={{ marginBottom: 16, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          <label style={labelStyle}>
            Project name
            <input required value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
          </label>
          <label style={labelStyle}>
            Owner
            <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} style={inputStyle}>
              <option value="">— none —</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label style={labelStyle}>
            Category
            <input value={category} onChange={(e) => setCategory(e.target.value)} style={inputStyle} />
          </label>
          <label style={labelStyle}>
            Priority
            <select value={priority} onChange={(e) => setPriority(e.target.value as "Low" | "Medium" | "High")} style={inputStyle}>
              <option value="Low">Low</option>
              <option value="Medium">Medium</option>
              <option value="High">High</option>
            </select>
          </label>
          <label style={labelStyle}>
            Status
            <input value={projectStatus} onChange={(e) => setProjectStatus(e.target.value)} style={inputStyle} />
          </label>
          <label style={labelStyle}>
            Start date
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={inputStyle} />
          </label>
          <label style={labelStyle}>
            Due date
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={inputStyle} />
          </label>
          <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 10 }}>
            <button type="submit" disabled={submitting} style={{ padding: "7px 14px", fontSize: 12, fontWeight: 600, color: "#fff", background: "var(--accent)", border: "none" }}>
              {submitting ? "Creating…" : "Create project"}
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
                      render: (p: ProjectRow) => (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditing(p);
                          }}
                          style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", color: "var(--accent)", fontSize: 11 }}
                        >
                          <Pencil size={12} />
                          Edit
                        </button>
                      ),
                    }
                  : undefined,
              ].filter(Boolean) as ColumnDef<ProjectRow>[]}
              rows={projects}
              rowKey={(p) => p.id}
              view={activeView}
              onViewChange={updateActiveView}
              groupOptions={groupOptions}
              emptyLabel="No projects yet. Use “New project” to add the first one."
            />
          </div>
        )}
      </div>

      {editing && (
        <Modal title={`Edit ${editing.name}`} onClose={() => setEditing(null)}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <label style={labelStyle}>
              Project name
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} style={inputStyle} />
            </label>
            <label style={labelStyle}>
              Owner
              <select value={editing.owner_id ?? ""} onChange={(e) => setEditing({ ...editing, owner_id: e.target.value || null })} style={inputStyle}>
                <option value="">— none —</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label style={labelStyle}>
              Category
              <input value={editing.category ?? ""} onChange={(e) => setEditing({ ...editing, category: e.target.value })} style={inputStyle} />
            </label>
            <label style={labelStyle}>
              Priority
              <select
                value={editing.priority ?? "Medium"}
                onChange={(e) => setEditing({ ...editing, priority: e.target.value as "Low" | "Medium" | "High" })}
                style={inputStyle}
              >
                <option value="Low">Low</option>
                <option value="Medium">Medium</option>
                <option value="High">High</option>
              </select>
            </label>
            <label style={labelStyle}>
              Status
              <input value={editing.project_status ?? ""} onChange={(e) => setEditing({ ...editing, project_status: e.target.value })} style={inputStyle} />
            </label>
            <label style={labelStyle}>
              Effort level
              <input value={editing.effort_level ?? ""} onChange={(e) => setEditing({ ...editing, effort_level: e.target.value })} style={inputStyle} />
            </label>
            <label style={labelStyle}>
              Start date
              <input type="date" value={editing.start_date ?? ""} onChange={(e) => setEditing({ ...editing, start_date: e.target.value })} style={inputStyle} />
            </label>
            <label style={labelStyle}>
              Due date
              <input type="date" value={editing.end_date ?? ""} onChange={(e) => setEditing({ ...editing, end_date: e.target.value })} style={inputStyle} />
            </label>
            <label style={{ ...labelStyle, gridColumn: "1 / -1" }}>
              Summary
              <textarea
                value={editing.summary ?? ""}
                onChange={(e) => setEditing({ ...editing, summary: e.target.value })}
                rows={3}
                style={{ ...inputStyle, resize: "vertical" }}
              />
            </label>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
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
