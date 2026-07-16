import { useEffect, useMemo, useState } from "react";
import { Plus, CornerDownRight } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useSession } from "../lib/useSession";
import { useTableViews } from "../lib/useTableViews";
import DataTable from "../components/DataTable";
import ViewTabs from "../components/ViewTabs";
import ColumnsMenu from "../components/ColumnsMenu";
import { InlineText, InlineSelect, InlineDate, InlineNumber } from "../components/InlineCell";
import type { ColumnDef, GroupOption } from "../lib/tableTypes";
import {
  PROJECT_CATEGORY_OPTIONS,
  PROJECT_EFFORT_LEVEL_OPTIONS,
  PROJECT_PRIORITY_OPTIONS,
  PROJECT_STATUS_GROUPED,
  TASK_STATUS_GROUPED,
  TASK_PHASE_OPTIONS,
  statusGroupOf,
} from "../lib/notionOptions";

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
  effort_level: string | null;
  start_date: string | null;
  end_date: string | null;
}

interface TaskRow {
  id: string;
  project_id: string;
  parent_task_id: string | null;
  name: string;
  phase: string | null;
  status: string | null;
  assignee_id: string | null;
  current_due_date: string;
  estimated_hours: number | null;
  time_spent_hours: number | null;
  validated_completion_date: string | null;
}

type TaskWithDepth = TaskRow & { _depth: number };

const PROJECT_COLUMN_ORDER = ["name", "owner", "priority", "project_status", "health", "category", "effort_level", "start_date", "end_date"];
const TASK_COLUMN_ORDER = ["name", "project", "assignee", "phase", "status", "current_due_date", "estimated_hours", "time_spent_hours"];

function healthOf(p: ProjectRow): { label: string; tone: "success" | "warning" | "danger" | "neutral" } {
  const group = statusGroupOf(PROJECT_STATUS_GROUPED, p.project_status);
  if (group === "complete") return { label: p.project_status ?? "Complete", tone: "neutral" };
  if (!p.end_date) return { label: "On track", tone: "success" };
  const daysLeft = (new Date(p.end_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
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

function statusTone(group: "to_do" | "in_progress" | "complete" | null): "success" | "warning" | "danger" | "neutral" {
  if (group === "complete") return "success";
  if (group === "in_progress") return "warning";
  return "neutral";
}

function timingOf(t: TaskRow): { label: string; tone: "success" | "warning" | "danger" | "neutral" } {
  const group = statusGroupOf(TASK_STATUS_GROUPED, t.status);
  const due = new Date(t.current_due_date);
  if (group === "complete") {
    if (t.validated_completion_date && new Date(t.validated_completion_date) > due) return { label: "Late", tone: "danger" };
    return { label: "On time", tone: "success" };
  }
  const daysLeft = (due.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  if (daysLeft < 0) return { label: "Overdue", tone: "danger" };
  if (daysLeft <= 3) return { label: "Due soon", tone: "warning" };
  return { label: "On track", tone: "neutral" };
}

function buildTaskTree(list: TaskRow[]): TaskWithDepth[] {
  const byParent = new Map<string, TaskRow[]>();
  list.forEach((t) => {
    const key = t.parent_task_id ?? "root";
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(t);
  });
  const result: TaskWithDepth[] = [];
  function walk(parentKey: string, depth: number) {
    (byParent.get(parentKey) ?? []).forEach((t) => {
      result.push({ ...t, _depth: depth });
      walk(t.id, depth + 1);
    });
  }
  walk("root", 0);
  return result;
}

export default function Projects() {
  const { person: me } = useSession();
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [people, setPeople] = useState<PersonOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectFilter, setProjectFilter] = useState<string[]>([]);

  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectOwner, setNewProjectOwner] = useState("");

  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newTaskName, setNewTaskName] = useState("");
  const [newTaskProject, setNewTaskProject] = useState("");
  const [newTaskDue, setNewTaskDue] = useState("");

  const isFullAccess = me?.access_level === "full";

  async function loadAll() {
    setLoading(true);
    const [{ data: projectData }, { data: taskData }, { data: peopleData }] = await Promise.all([
      supabase.from("projects").select("*").order("name"),
      supabase.from("tasks").select("*").order("current_due_date"),
      supabase.from("people").select("id,name").eq("is_active", true).order("name"),
    ]);
    setProjects((projectData as ProjectRow[]) ?? []);
    setTasks((taskData as TaskRow[]) ?? []);
    setPeople((peopleData as PersonOption[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    loadAll();
  }, []);

  const ownerName = (id: string | null) => people.find((p) => p.id === id)?.name ?? "—";
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "—";
  const isProjectOwner = (projectId: string) => projects.find((p) => p.id === projectId)?.owner_id === me?.id;
  const canEditProject = (p: ProjectRow) => isFullAccess || p.owner_id === me?.id;
  const canManageTasksIn = (projectId: string) => isFullAccess || isProjectOwner(projectId);
  const canEditTask = (t: TaskRow) => canManageTasksIn(t.project_id) || t.assignee_id === me?.id;
  const canCreateProject = isFullAccess;
  const canCreateTask = isFullAccess || projects.some((p) => p.owner_id === me?.id);

  async function updateProject(id: string, patch: Partial<ProjectRow>) {
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    const { error } = await supabase.from("projects").update(patch).eq("id", id);
    if (error) {
      window.alert(`Couldn't save: ${error.message}`);
      loadAll();
    }
  }

  async function updateTask(id: string, patch: Partial<TaskRow>) {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    const { error } = await supabase.from("tasks").update(patch).eq("id", id);
    if (error) {
      window.alert(`Couldn't save: ${error.message}`);
      loadAll();
    }
  }

  const projectColumns: ColumnDef<ProjectRow>[] = useMemo(
    () => [
      {
        key: "name",
        label: "Project",
        defaultWidth: 220,
        minWidth: 160,
        render: (p) => <InlineText value={p.name} editable={canEditProject(p)} bold onCommit={(v) => updateProject(p.id, { name: v })} />,
      },
      {
        key: "owner",
        label: "Owner",
        defaultWidth: 140,
        render: (p) => (
          <InlineSelect
            value={p.owner_id ?? ""}
            editable={canEditProject(p)}
            allowEmpty
            emptyLabel="— none —"
            options={people.map((x) => x.name)}
            renderReadOnly={() => ownerName(p.owner_id)}
            onCommit={(v) => {
              const person = people.find((x) => x.name === v);
              updateProject(p.id, { owner_id: person?.id ?? null });
            }}
          />
        ),
      },
      {
        key: "priority",
        label: "Priority",
        defaultWidth: 100,
        render: (p) => (
          <InlineSelect
            value={p.priority ?? ""}
            editable={canEditProject(p)}
            options={PROJECT_PRIORITY_OPTIONS}
            renderReadOnly={() => (p.priority ? <span className={`status-pill ${priorityTone(p.priority)}`}>{p.priority}</span> : "—")}
            onCommit={(v) => updateProject(p.id, { priority: v as ProjectRow["priority"] })}
          />
        ),
      },
      {
        key: "project_status",
        label: "Status",
        defaultWidth: 130,
        render: (p) => (
          <InlineSelect
            value={p.project_status ?? ""}
            editable={canEditProject(p)}
            allowEmpty
            options={PROJECT_STATUS_GROUPED}
            renderReadOnly={() =>
              p.project_status ? (
                <span className={`status-pill ${statusTone(statusGroupOf(PROJECT_STATUS_GROUPED, p.project_status))}`}>{p.project_status}</span>
              ) : (
                "—"
              )
            }
            onCommit={(v) => updateProject(p.id, { project_status: v || null })}
          />
        ),
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
      {
        key: "category",
        label: "Category",
        defaultWidth: 150,
        render: (p) => (
          <InlineSelect
            value={p.category ?? ""}
            editable={canEditProject(p)}
            allowEmpty
            options={PROJECT_CATEGORY_OPTIONS}
            onCommit={(v) => updateProject(p.id, { category: v || null })}
          />
        ),
      },
      {
        key: "effort_level",
        label: "Effort",
        defaultWidth: 100,
        render: (p) => (
          <InlineSelect
            value={p.effort_level ?? ""}
            editable={canEditProject(p)}
            allowEmpty
            options={PROJECT_EFFORT_LEVEL_OPTIONS}
            onCommit={(v) => updateProject(p.id, { effort_level: v || null })}
          />
        ),
      },
      {
        key: "start_date",
        label: "Start",
        defaultWidth: 100,
        render: (p) => <InlineDate value={p.start_date} editable={canEditProject(p)} onCommit={(v) => updateProject(p.id, { start_date: v || null })} />,
      },
      {
        key: "end_date",
        label: "Due",
        defaultWidth: 100,
        render: (p) => <InlineDate value={p.end_date} editable={canEditProject(p)} onCommit={(v) => updateProject(p.id, { end_date: v || null })} />,
      },
    ],
    [people, projects, me]
  );

  const projectGroupOptions: GroupOption<ProjectRow>[] = [
    { key: "project_status", label: "Status", getGroup: (p) => p.project_status ?? "No status" },
    { key: "priority", label: "Priority", getGroup: (p) => p.priority ?? "No priority" },
    { key: "owner", label: "Owner", getGroup: (p) => ownerName(p.owner_id) },
    { key: "category", label: "Category", getGroup: (p) => p.category ?? "Uncategorized" },
  ];

  const projectViews = useTableViews("projects", me?.id, {
    columnOrder: PROJECT_COLUMN_ORDER,
    hiddenColumns: [],
    columnWidths: {},
    groupBy: null,
  });

  async function submitNewProject() {
    if (!newProjectName.trim()) return;
    const { error } = await supabase.from("projects").insert({
      name: newProjectName.trim(),
      owner_id: newProjectOwner || null,
    });
    if (error) {
      window.alert(`Couldn't create project: ${error.message}`);
      return;
    }
    setNewProjectName("");
    setNewProjectOwner("");
    setNewProjectOpen(false);
    loadAll();
  }

  const visibleTasks = useMemo(() => {
    const base = projectFilter.length === 0 ? tasks : tasks.filter((t) => projectFilter.includes(t.project_id));
    return buildTaskTree(base);
  }, [tasks, projectFilter]);

  async function addSubtask(parent: TaskWithDepth) {
    const name = window.prompt("Subtask name:");
    if (!name || !name.trim()) return;
    const { error } = await supabase.from("tasks").insert({
      project_id: parent.project_id,
      parent_task_id: parent.id,
      name: name.trim(),
      status: "Not Started",
      original_due_date: parent.current_due_date,
      current_due_date: parent.current_due_date,
    });
    if (error) {
      window.alert(`Couldn't add subtask: ${error.message}`);
      return;
    }
    loadAll();
  }

  const taskColumns: ColumnDef<TaskWithDepth>[] = useMemo(
    () => [
      {
        key: "name",
        label: "Task",
        defaultWidth: 260,
        minWidth: 180,
        render: (t) => (
          <div className="task-name-cell" style={{ paddingLeft: t._depth * 16 }}>
            {t._depth > 0 && <CornerDownRight size={11} className="subtask-connector" />}
            <div style={{ flex: 1, minWidth: 0 }}>
              <InlineText value={t.name} editable={canEditTask(t)} bold onCommit={(v) => updateTask(t.id, { name: v })} />
            </div>
            {t._depth < 2 && canManageTasksIn(t.project_id) && (
              <button className="add-subtask-btn" onClick={() => addSubtask(t)} title="Add subtask">
                <Plus size={10} />
                Sub
              </button>
            )}
          </div>
        ),
      },
      {
        key: "project",
        label: "Project",
        defaultWidth: 160,
        render: (t) => (
          <InlineSelect
            value={projectName(t.project_id)}
            editable={canEditTask(t)}
            options={projects.map((p) => p.name)}
            onCommit={(v) => {
              const proj = projects.find((p) => p.name === v);
              if (proj) updateTask(t.id, { project_id: proj.id });
            }}
          />
        ),
      },
      {
        key: "assignee",
        label: "Assignee",
        defaultWidth: 130,
        render: (t) => (
          <InlineSelect
            value={t.assignee_id ? ownerName(t.assignee_id) : ""}
            editable={canEditTask(t)}
            allowEmpty
            emptyLabel="— none —"
            options={people.map((x) => x.name)}
            renderReadOnly={() => ownerName(t.assignee_id)}
            onCommit={(v) => {
              const person = people.find((x) => x.name === v);
              updateTask(t.id, { assignee_id: person?.id ?? null });
            }}
          />
        ),
      },
      {
        key: "phase",
        label: "Phase",
        defaultWidth: 110,
        render: (t) => (
          <InlineSelect value={t.phase ?? ""} editable={canEditTask(t)} allowEmpty options={TASK_PHASE_OPTIONS} onCommit={(v) => updateTask(t.id, { phase: v || null })} />
        ),
      },
      {
        key: "status",
        label: "Status",
        defaultWidth: 130,
        render: (t) => (
          <InlineSelect
            value={t.status ?? ""}
            editable={canEditTask(t)}
            allowEmpty
            options={TASK_STATUS_GROUPED}
            renderReadOnly={() =>
              t.status ? <span className={`status-pill ${statusTone(statusGroupOf(TASK_STATUS_GROUPED, t.status))}`}>{t.status}</span> : "—"
            }
            onCommit={(v) => updateTask(t.id, { status: v || null })}
          />
        ),
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
      {
        key: "current_due_date",
        label: "Due",
        defaultWidth: 100,
        render: (t) => <InlineDate value={t.current_due_date} editable={canEditTask(t)} onCommit={(v) => v && updateTask(t.id, { current_due_date: v })} />,
      },
      {
        key: "estimated_hours",
        label: "Est. hrs",
        defaultWidth: 80,
        render: (t) => <InlineNumber value={t.estimated_hours} editable={canEditTask(t)} onCommit={(v) => updateTask(t.id, { estimated_hours: v })} />,
      },
      {
        key: "time_spent_hours",
        label: "Spent hrs",
        defaultWidth: 85,
        render: (t) => <InlineNumber value={t.time_spent_hours ?? 0} editable={canEditTask(t)} onCommit={(v) => updateTask(t.id, { time_spent_hours: v ?? 0 })} />,
      },
    ],
    [people, projects, me]
  );

  const taskGroupOptions: GroupOption<TaskWithDepth>[] = [
    { key: "status", label: "Status", getGroup: (t) => t.status ?? "No status" },
    { key: "project", label: "Project", getGroup: (t) => projectName(t.project_id) },
    { key: "assignee", label: "Assignee", getGroup: (t) => ownerName(t.assignee_id) },
  ];

  const taskViews = useTableViews("tasks", me?.id, {
    columnOrder: TASK_COLUMN_ORDER,
    hiddenColumns: [],
    columnWidths: {},
    groupBy: null,
  });

  async function submitNewTask() {
    if (!newTaskName.trim() || !newTaskProject || !newTaskDue) {
      window.alert("Task name, project, and due date are required.");
      return;
    }
    const { error } = await supabase.from("tasks").insert({
      project_id: newTaskProject,
      name: newTaskName.trim(),
      status: "Not Started",
      original_due_date: newTaskDue,
      current_due_date: newTaskDue,
    });
    if (error) {
      window.alert(`Couldn't create task: ${error.message}`);
      return;
    }
    setNewTaskName("");
    setNewTaskProject("");
    setNewTaskDue("");
    setNewTaskOpen(false);
    loadAll();
  }

  return (
    <div>
      <h1>Projects &amp; Tasks</h1>
      <p className="subtitle">
        Every project and its tasks in one place. Owners can edit their project; anyone can edit their own tasks. Click any cell to edit it, like
        Notion.
      </p>

      <div className="card" style={{ padding: 0, marginBottom: 20 }}>
        <div className="table-toolbar">
          <ViewTabs
            views={projectViews.views}
            activeViewId={projectViews.activeViewId}
            onSelect={projectViews.setActiveViewId}
            onCreate={projectViews.createView}
            onRename={projectViews.renameView}
            onDelete={projectViews.deleteView}
          />
          <ColumnsMenu
            columns={projectColumns}
            hiddenColumns={projectViews.activeView.hiddenColumns}
            onToggleColumn={(key) =>
              projectViews.updateActiveView({
                hiddenColumns: projectViews.activeView.hiddenColumns.includes(key)
                  ? projectViews.activeView.hiddenColumns.filter((k) => k !== key)
                  : [...projectViews.activeView.hiddenColumns, key],
              })
            }
            groupOptions={projectGroupOptions}
            groupBy={projectViews.activeView.groupBy}
            onGroupByChange={(groupBy) => projectViews.updateActiveView({ groupBy })}
          />
        </div>
        {loading ? (
          <div style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>Loading…</div>
        ) : (
          <div className="data-table-dense">
            <DataTable
              columns={projectColumns}
              rows={projects}
              rowKey={(p) => p.id}
              view={projectViews.activeView}
              onViewChange={projectViews.updateActiveView}
              groupOptions={projectGroupOptions}
              emptyLabel="No projects yet. Add one below."
              footerRow={
                canCreateProject
                  ? (colSpan) => (
                      <td colSpan={colSpan} className="add-row-cell">
                        {newProjectOpen ? (
                          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            <input
                              autoFocus
                              className="add-row-input"
                              spellCheck={false}
                              autoComplete="off"
                              placeholder="Project name"
                              value={newProjectName}
                              onChange={(e) => setNewProjectName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") submitNewProject();
                                if (e.key === "Escape") setNewProjectOpen(false);
                              }}
                              style={{ flex: 1 }}
                            />
                            <select
                              value={newProjectOwner}
                              onChange={(e) => setNewProjectOwner(e.target.value)}
                              style={{ fontSize: 11, padding: "3px 5px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}
                            >
                              <option value="">Owner…</option>
                              {people.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name}
                                </option>
                              ))}
                            </select>
                            <button onClick={submitNewProject} style={{ fontSize: 11, fontWeight: 600, color: "var(--accent)", background: "none", border: "none", cursor: "pointer" }}>
                              Add
                            </button>
                            <button onClick={() => setNewProjectOpen(false)} style={{ fontSize: 11, color: "var(--muted)", background: "none", border: "none", cursor: "pointer" }}>
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div className="add-row-trigger" onClick={() => setNewProjectOpen(true)}>
                            <Plus size={12} />
                            New project
                          </div>
                        )}
                      </td>
                    )
                  : undefined
              }
            />
          </div>
        )}
      </div>

      <h2 style={{ marginTop: 0 }}>Tasks</h2>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        <span
          className={`filter-chip${projectFilter.length === 0 ? " active" : ""}`}
          onClick={() => setProjectFilter([])}
        >
          All projects
        </span>
        {[...projects]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((p) => (
            <span
              key={p.id}
              className={`filter-chip${projectFilter.includes(p.id) ? " active" : ""}`}
              onClick={() =>
                setProjectFilter((prev) => (prev.includes(p.id) ? prev.filter((id) => id !== p.id) : [...prev, p.id]))
              }
            >
              {p.name}
            </span>
          ))}
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div className="table-toolbar">
          <ViewTabs
            views={taskViews.views}
            activeViewId={taskViews.activeViewId}
            onSelect={taskViews.setActiveViewId}
            onCreate={taskViews.createView}
            onRename={taskViews.renameView}
            onDelete={taskViews.deleteView}
          />
          <ColumnsMenu
            columns={taskColumns}
            hiddenColumns={taskViews.activeView.hiddenColumns}
            onToggleColumn={(key) =>
              taskViews.updateActiveView({
                hiddenColumns: taskViews.activeView.hiddenColumns.includes(key)
                  ? taskViews.activeView.hiddenColumns.filter((k) => k !== key)
                  : [...taskViews.activeView.hiddenColumns, key],
              })
            }
            groupOptions={taskGroupOptions}
            groupBy={taskViews.activeView.groupBy}
            onGroupByChange={(groupBy) => taskViews.updateActiveView({ groupBy })}
          />
        </div>
        {loading ? (
          <div style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>Loading…</div>
        ) : (
          <div className="data-table-dense">
            <DataTable
              columns={taskColumns}
              rows={visibleTasks}
              rowKey={(t) => t.id}
              view={taskViews.activeView}
              onViewChange={taskViews.updateActiveView}
              groupOptions={taskGroupOptions}
              emptyLabel="No tasks yet. Add one below."
              footerRow={
                canCreateTask
                  ? (colSpan) => (
                      <td colSpan={colSpan} className="add-row-cell">
                        {newTaskOpen ? (
                          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            <input
                              autoFocus
                              className="add-row-input"
                              spellCheck={false}
                              autoComplete="off"
                              placeholder="Task name"
                              value={newTaskName}
                              onChange={(e) => setNewTaskName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") submitNewTask();
                                if (e.key === "Escape") setNewTaskOpen(false);
                              }}
                              style={{ flex: 1 }}
                            />
                            <select
                              value={newTaskProject}
                              onChange={(e) => setNewTaskProject(e.target.value)}
                              style={{ fontSize: 11, padding: "3px 5px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}
                            >
                              <option value="">Project…</option>
                              {projects.map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.name}
                                </option>
                              ))}
                            </select>
                            <input
                              type="date"
                              value={newTaskDue}
                              onChange={(e) => setNewTaskDue(e.target.value)}
                              style={{ fontSize: 11, padding: "3px 5px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}
                            />
                            <button onClick={submitNewTask} style={{ fontSize: 11, fontWeight: 600, color: "var(--accent)", background: "none", border: "none", cursor: "pointer" }}>
                              Add
                            </button>
                            <button onClick={() => setNewTaskOpen(false)} style={{ fontSize: 11, color: "var(--muted)", background: "none", border: "none", cursor: "pointer" }}>
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div className="add-row-trigger" onClick={() => setNewTaskOpen(true)}>
                            <Plus size={12} />
                            New task
                          </div>
                        )}
                      </td>
                    )
                  : undefined
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}
