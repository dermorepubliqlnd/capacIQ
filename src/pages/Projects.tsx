import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, CornerDownRight, ChevronRight, ChevronDown, Archive, ArchiveRestore, Feather, Weight, BicepsFlexed, Palette } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useSession } from "../lib/useSession";
import { useTableViews } from "../lib/useTableViews";
import DataTable from "../components/DataTable";
import ViewTabs, { TAB_COLORS } from "../components/ViewTabs";
import ViewSettingsMenu from "../components/ViewSettingsMenu";
import Modal from "../components/Modal";
import { useConfirm } from "../lib/useConfirm";
import { InlineText, InlineSelect, InlineDate, InlineNumber } from "../components/InlineCell";
import type { ColumnDef, GroupOption, SortOption } from "../lib/tableTypes";
import {
  PROJECT_CATEGORY_OPTIONS,
  PROJECT_CATEGORY_TONES,
  PROJECT_EFFORT_LEVEL_OPTIONS,
  PROJECT_EFFORT_LEVEL_TONES,
  PROJECT_PRIORITY_OPTIONS,
  PROJECT_STATUS_GROUPED,
  TASK_STATUS_GROUPED,
  PROJECT_CATEGORY_ICONS,
  DEFAULT_PROJECT_ICON,
  TASK_EFFORT_OPTIONS,
  TASK_EFFORT_POINTS,
  TASK_EFFORT_DEFAULT_TONES,
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
  is_archived: boolean;
  archived_at: string | null;
}

interface TaskRow {
  id: string;
  project_id: string;
  parent_task_id: string | null;
  name: string;
  status: string | null;
  assignee_id: string | null;
  start_date: string | null;
  current_due_date: string;
  estimated_hours: number | null;
  time_spent_hours: number | null;
  validated_completion_date: string | null;
  effort: string | null;
  is_archived: boolean;
  archived_at: string | null;
}

type TaskWithDepth = TaskRow & { _depth: number };

const PROJECT_COLUMN_ORDER = ["name", "owner", "priority", "project_status", "health", "category", "effort_level", "start_date", "end_date"];
const TASK_COLUMN_ORDER = ["name", "project", "assignee", "status", "effort", "start_date", "current_due_date", "estimated_hours", "time_spent_hours"];

// "Fun, not corporate" icons for Task Effort (Sandra's request) — a light
// feather for quick work, a weight plate for a moderate lift, and a flexed
// bicep for the heavy stuff. Colors are NOT hardcoded to these icons; the
// tone comes from task_effort_colors (DB-driven, Sandra can recolor each
// level herself) so the icon always inherits the pill's own darker tone
// via currentColor.
const TASK_EFFORT_ICON: Record<string, typeof Feather> = {
  Light: Feather,
  Moderate: Weight,
  Heavy: BicepsFlexed,
};

function healthOf(p: ProjectRow): { label: string; tone: "success" | "warning" | "danger" | "neutral" } {
  const group = statusGroupOf(PROJECT_STATUS_GROUPED, p.project_status);
  if (group === "complete") return { label: p.project_status ?? "Complete", tone: "neutral" };
  if (!p.end_date) return { label: "On track", tone: "success" };
  const daysLeft = (new Date(p.end_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  if (daysLeft < 0) return { label: "Overdue", tone: "danger" };
  if (daysLeft <= 7) return { label: "Due soon", tone: "warning" };
  return { label: "On track", tone: "success" };
}

// Severity order for sorting by Health: worst first (Overdue), then Due
// soon, On track, and finally completed projects' own status label.
function healthRank(label: string): number {
  if (label === "Overdue") return 0;
  if (label === "Due soon") return 1;
  if (label === "On track") return 2;
  return 3;
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

// Supabase date columns come back as plain "YYYY-MM-DD" strings. Passing
// that straight to `new Date(...)` parses it as UTC midnight, which in any
// timezone behind UTC silently rolls it back a calendar day (a task due
// "today" would parse as "yesterday" and read as overdue). Parsing the
// pieces directly as LOCAL date components avoids that shift entirely.
function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

// Whole-calendar-day difference (ignores time-of-day) so "due today" never
// reads as overdue — a day only counts as passed once the clock actually
// rolls into the next calendar date.
function calendarDaysBetween(a: Date, b: Date): number {
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const db = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((da.getTime() - db.getTime()) / (1000 * 60 * 60 * 24));
}

function timingOf(t: TaskRow): { label: string; tone: "success" | "warning" | "danger" | "neutral" } {
  const group = statusGroupOf(TASK_STATUS_GROUPED, t.status);
  const due = parseLocalDate(t.current_due_date);
  if (group === "complete") {
    if (t.validated_completion_date && parseLocalDate(t.validated_completion_date) > due) return { label: "Late", tone: "danger" };
    return { label: "On time", tone: "success" };
  }
  const daysLeft = calendarDaysBetween(due, new Date());
  if (daysLeft < 0) return { label: "Overdue", tone: "danger" };
  if (daysLeft <= 3) return { label: "Due soon", tone: "warning" };
  return { label: "On track", tone: "success" };
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

// Lets Sandra (Full Access) recolor each Task Effort level herself instead
// of the tones being hardcoded — same swatch-row pattern as the View tab
// color picker (ViewTabs.tsx), rendered fixed-positioned so it can't get
// clipped by the table's own horizontal-scroll container (the fix that
// finally solved the same problem for the Day Planner's Off menu).
function EffortColorMenu({
  effortColors,
  onPick,
  onClose,
}: {
  effortColors: Record<string, string>;
  onPick: (level: string, tone: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="view-tab-dropdown"
      style={{ position: "static", width: 190, textAlign: "left" }}
      onClick={(e) => e.stopPropagation()}
    >
      <div style={{ padding: "4px 8px 6px", fontSize: 11.5, fontWeight: 600, color: "var(--muted)" }}>Effort colors</div>
      {TASK_EFFORT_OPTIONS.map((level) => {
        const Icon = TASK_EFFORT_ICON[level];
        return (
          <div key={level} style={{ padding: "4px 8px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 500, marginBottom: 4 }}>
              <Icon size={11} />
              {level}
            </div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {Object.entries(TAB_COLORS).map(([key, hex]) => (
                <span
                  key={key}
                  onClick={() => onPick(level, key)}
                  title={key}
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: "50%",
                    background: hex,
                    cursor: "pointer",
                    border: effortColors[level] === key ? "2px solid var(--navy)" : "1px solid var(--border)",
                  }}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function Projects() {
  const { person: me } = useSession();
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [people, setPeople] = useState<PersonOption[]>([]);
  const [loading, setLoading] = useState(true);

  const [collapsedParents, setCollapsedParents] = useState<string[]>([]);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const [taskSettingsOpen, setTaskSettingsOpen] = useState(false);
  const { confirm, dialog: confirmDialog } = useConfirm();

  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archivedProjects, setArchivedProjects] = useState<ProjectRow[]>([]);
  const [archivedTasks, setArchivedTasks] = useState<TaskRow[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);

  // Task Effort colors: DB-driven so Sandra (Full Access) can recolor each
  // level herself instead of it being hardcoded. Falls back to the seeded
  // defaults if a level's row hasn't loaded yet.
  const [effortColors, setEffortColors] = useState<Record<string, string>>(TASK_EFFORT_DEFAULT_TONES);
  const [effortMenuPos, setEffortMenuPos] = useState<{ x: number; y: number } | null>(null);

  const isFullAccess = me?.access_level === "full";
  const ARCHIVE_RETENTION_DAYS = 30;

  // Best-effort purge: anything archived more than 30 days ago gets
  // permanently deleted the next time someone with delete rights (the
  // project's owner or Full Access) loads this page. There's no server-side
  // cron for this, so it relies on the app being opened regularly.
  async function purgeExpiredArchives() {
    const cutoff = new Date(Date.now() - ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await supabase.from("tasks").delete().eq("is_archived", true).lt("archived_at", cutoff);
    await supabase.from("projects").delete().eq("is_archived", true).lt("archived_at", cutoff);
  }

  async function loadAll() {
    setLoading(true);
    purgeExpiredArchives();
    const [{ data: projectData }, { data: taskData }, { data: peopleData }, { data: effortColorData }] = await Promise.all([
      supabase.from("projects").select("*").eq("is_archived", false).order("name"),
      supabase.from("tasks").select("*").eq("is_archived", false).order("current_due_date"),
      supabase.from("people").select("id,name").eq("is_active", true).order("name"),
      supabase.from("task_effort_colors").select("*"),
    ]);
    setProjects((projectData as ProjectRow[]) ?? []);
    setTasks((taskData as TaskRow[]) ?? []);
    setPeople((peopleData as PersonOption[]) ?? []);
    if (effortColorData && effortColorData.length) {
      setEffortColors((prev) => {
        const next = { ...prev };
        for (const row of effortColorData as { level: string; tone: string }[]) next[row.level] = row.tone;
        return next;
      });
    }
    setLoading(false);
  }

  // Full Access only (gated by the insert/update RLS policies too, but we
  // hide the picker from anyone else). Optimistic update so the swatch
  // feels instant, then upsert into task_effort_colors.
  async function setEffortColor(level: string, tone: string) {
    setEffortColors((prev) => ({ ...prev, [level]: tone }));
    const { error } = await supabase.from("task_effort_colors").upsert({ level, tone }, { onConflict: "level" });
    if (error) window.alert(`Couldn't save color: ${error.message}`);
  }

  async function loadArchived() {
    setArchivedLoading(true);
    const [{ data: projectData }, { data: taskData }] = await Promise.all([
      supabase.from("projects").select("*").eq("is_archived", true).order("archived_at", { ascending: false }),
      supabase.from("tasks").select("*").eq("is_archived", true).order("archived_at", { ascending: false }),
    ]);
    setArchivedProjects((projectData as ProjectRow[]) ?? []);
    setArchivedTasks((taskData as TaskRow[]) ?? []);
    setArchivedLoading(false);
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

  async function archiveProject(p: ProjectRow) {
    const ok = await confirm({
      title: "Archive project",
      message: `Archive "${p.name}"? It'll be hidden from this table and permanently deleted after ${ARCHIVE_RETENTION_DAYS} days unless restored first.`,
      confirmLabel: "Archive",
      danger: true,
    });
    if (!ok) return;
    const { error } = await supabase.from("projects").update({ is_archived: true, archived_at: new Date().toISOString() }).eq("id", p.id);
    if (error) {
      window.alert(`Couldn't archive: ${error.message}`);
      return;
    }
    loadAll();
  }

  async function restoreProject(id: string) {
    const { error } = await supabase.from("projects").update({ is_archived: false, archived_at: null }).eq("id", id);
    if (error) {
      window.alert(`Couldn't restore: ${error.message}`);
      return;
    }
    loadArchived();
    loadAll();
  }

  async function archiveTask(t: TaskRow) {
    const childIds = tasks.filter((x) => x.parent_task_id === t.id).map((x) => x.id);
    const warning =
      childIds.length > 0
        ? `Archive "${t.name}" and its ${childIds.length} sub-task${childIds.length > 1 ? "s" : ""}? Hidden from this table, permanently deleted after ${ARCHIVE_RETENTION_DAYS} days unless restored.`
        : `Archive "${t.name}"? Hidden from this table, permanently deleted after ${ARCHIVE_RETENTION_DAYS} days unless restored.`;
    const ok = await confirm({ title: "Archive task", message: warning, confirmLabel: "Archive", danger: true });
    if (!ok) return;
    const { error } = await supabase
      .from("tasks")
      .update({ is_archived: true, archived_at: new Date().toISOString() })
      .in("id", [t.id, ...childIds]);
    if (error) {
      window.alert(`Couldn't archive: ${error.message}`);
      return;
    }
    loadAll();
  }

  async function restoreTask(id: string) {
    const { error } = await supabase.from("tasks").update({ is_archived: false, archived_at: null }).eq("id", id);
    if (error) {
      window.alert(`Couldn't restore: ${error.message}`);
      return;
    }
    loadArchived();
    loadAll();
  }

  const projectColumns: ColumnDef<ProjectRow>[] = useMemo(
    () => [
      {
        key: "name",
        label: "Project",
        defaultWidth: 260,
        minWidth: 160,
        maxWidth: 420,
        render: (p) => {
          const icon = p.category ? PROJECT_CATEGORY_ICONS[p.category] ?? DEFAULT_PROJECT_ICON : DEFAULT_PROJECT_ICON;
          return (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className={`project-icon-badge ${icon.tone}`}>{icon.emoji}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <InlineText value={p.name} editable={canEditProject(p)} bold onCommit={(v) => updateProject(p.id, { name: v })} />
              </div>
            </div>
          );
        },
      },
      {
        key: "owner",
        label: "Owner",
        defaultWidth: 150,
        maxWidth: 220,
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
        maxWidth: 130,
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
        defaultWidth: 140,
        maxWidth: 200,
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
        defaultWidth: 120,
        maxWidth: 150,
        render: (p) => {
          const h = healthOf(p);
          return <span className={`status-pill ${h.tone}`}>{h.label}</span>;
        },
      },
      {
        key: "category",
        label: "Category",
        defaultWidth: 190,
        maxWidth: 260,
        render: (p) => (
          <InlineSelect
            value={p.category ?? ""}
            editable={canEditProject(p)}
            allowEmpty
            options={PROJECT_CATEGORY_OPTIONS}
            renderReadOnly={() =>
              p.category ? <span className={`status-pill ${PROJECT_CATEGORY_TONES[p.category] ?? "neutral"}`}>{p.category}</span> : "—"
            }
            onCommit={(v) => updateProject(p.id, { category: v || null })}
          />
        ),
      },
      {
        key: "effort_level",
        label: "Effort",
        defaultWidth: 100,
        maxWidth: 130,
        render: (p) => (
          <InlineSelect
            value={p.effort_level ?? ""}
            editable={canEditProject(p)}
            allowEmpty
            options={PROJECT_EFFORT_LEVEL_OPTIONS}
            renderReadOnly={() =>
              p.effort_level ? <span className={`status-pill ${PROJECT_EFFORT_LEVEL_TONES[p.effort_level] ?? "neutral"}`}>{p.effort_level}</span> : "—"
            }
            onCommit={(v) => updateProject(p.id, { effort_level: v || null })}
          />
        ),
      },
      {
        key: "start_date",
        label: "Start",
        defaultWidth: 110,
        maxWidth: 140,
        render: (p) => (
          <InlineDate
            value={p.start_date}
            editable={canEditProject(p)}
            onCommit={(v) => {
              if (v && p.end_date && v > p.end_date) {
                window.alert("Start date can't be after the due date.");
                return;
              }
              updateProject(p.id, { start_date: v || null });
            }}
          />
        ),
      },
      {
        key: "end_date",
        label: "Due",
        defaultWidth: 110,
        maxWidth: 140,
        render: (p) => (
          <InlineDate
            value={p.end_date}
            editable={canEditProject(p)}
            onCommit={(v) => {
              if (v && p.start_date && v < p.start_date) {
                window.alert("Due date can't be before the start date.");
                return;
              }
              updateProject(p.id, { end_date: v || null });
            }}
          />
        ),
      },
    ],
    [people, projects, me, effortColors]
  );

  const projectGroupOptions: GroupOption<ProjectRow>[] = [
    {
      key: "project_status",
      label: "Status",
      getGroup: (p) => p.project_status ?? "No status",
      getTone: (p) => statusTone(statusGroupOf(PROJECT_STATUS_GROUPED, p.project_status)),
    },
    {
      key: "priority",
      label: "Priority",
      getGroup: (p) => p.priority ?? "No priority",
      getTone: (p) => priorityTone(p.priority),
    },
    { key: "owner", label: "Owner", getGroup: (p) => ownerName(p.owner_id) },
    {
      key: "category",
      label: "Category",
      getGroup: (p) => p.category ?? "Uncategorized",
      getTone: (p) => PROJECT_CATEGORY_TONES[p.category ?? ""] ?? "neutral",
    },
    {
      key: "health",
      label: "Health",
      getGroup: (p) => healthOf(p).label,
      getTone: (p) => healthOf(p).tone,
    },
  ];

  const projectSortOptions: SortOption<ProjectRow>[] = [
    { key: "name", label: "Name", getValue: (p) => p.name ?? "" },
    { key: "priority", label: "Priority", getValue: (p) => PROJECT_PRIORITY_OPTIONS.indexOf(p.priority ?? "") },
    { key: "project_status", label: "Status", getValue: (p) => p.project_status ?? "" },
    { key: "category", label: "Category", getValue: (p) => p.category ?? "" },
    { key: "start_date", label: "Start date", getValue: (p) => (p.start_date ? new Date(p.start_date).getTime() : null) },
    { key: "end_date", label: "Due date", getValue: (p) => (p.end_date ? new Date(p.end_date).getTime() : null) },
    { key: "health", label: "Health", getValue: (p) => healthRank(healthOf(p).label) },
  ];

  const projectViews = useTableViews("projects", me?.id, {
    columnOrder: PROJECT_COLUMN_ORDER,
    hiddenColumns: [],
    columnWidths: {},
    groupBy: null,
    hiddenGroups: [],
    color: "neutral",
    showCount: false,
    sorts: [],
  });

  async function createBlankProject() {
    const { error } = await supabase.from("projects").insert({ name: "Untitled" });
    if (error) {
      window.alert(`Couldn't create project: ${error.message}`);
      return;
    }
    loadAll();
  }

  const visibleTasks = useMemo(
    () => buildTaskTree(tasks).filter((t) => !(t.parent_task_id && collapsedParents.includes(t.parent_task_id))),
    [tasks, collapsedParents]
  );
  const hasChildren = (taskId: string) => tasks.some((t) => t.parent_task_id === taskId);

  // Instant creation like createBlankTask/createBlankProject, instead of a
  // blocking window.prompt() — inherits the parent's due date and is
  // immediately editable inline via the normal Name cell.
  async function addSubtask(parent: TaskWithDepth) {
    if (parent._depth > 0) return; // only 2 layers total: parent + 1 sub-task level
    const { error } = await supabase.from("tasks").insert({
      project_id: parent.project_id,
      parent_task_id: parent.id,
      name: "Untitled sub-task",
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
        defaultWidth: 300,
        minWidth: 180,
        maxWidth: 480,
        render: (t) => {
          const children = t._depth === 0 && hasChildren(t.id);
          const collapsed = children && collapsedParents.includes(t.id);
          return (
            <div className="task-name-cell" style={{ paddingLeft: t._depth * 16 }}>
              {t._depth > 0 && <CornerDownRight size={11} className="subtask-connector" />}
              {children ? (
                <button
                  className="task-collapse-toggle"
                  onClick={() => setCollapsedParents((prev) => (collapsed ? prev.filter((id) => id !== t.id) : [...prev, t.id]))}
                  title={collapsed ? "Expand sub-tasks" : "Collapse sub-tasks"}
                >
                  {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                </button>
              ) : (
                t._depth === 0 && <span className="task-collapse-spacer" />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <InlineText value={t.name} editable={canEditTask(t)} bold onCommit={(v) => updateTask(t.id, { name: v })} />
              </div>
              {t._depth === 0 && canManageTasksIn(t.project_id) && (
                <button className="add-subtask-btn" onClick={() => addSubtask(t)} title="Add sub-task">
                  <Plus size={12} />
                </button>
              )}
            </div>
          );
        },
      },
      {
        key: "project",
        label: "Project",
        defaultWidth: 180,
        maxWidth: 260,
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
        defaultWidth: 150,
        maxWidth: 220,
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
        key: "status",
        label: "Status",
        defaultWidth: 140,
        maxWidth: 200,
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
        key: "effort",
        label: "Effort",
        defaultWidth: 80,
        minWidth: 60,
        maxWidth: 100,
        render: (t) => {
          const tone = t.effort ? effortColors[t.effort] ?? "neutral" : "neutral";
          const Icon = t.effort ? TASK_EFFORT_ICON[t.effort] : null;
          return (
            <InlineSelect
              value={t.effort ?? ""}
              editable={canEditTask(t)}
              allowEmpty
              options={TASK_EFFORT_OPTIONS}
              renderReadOnly={() =>
                t.effort ? (
                  <span className={`status-pill ${tone}`} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }} title={t.effort}>
                    {Icon && <Icon size={12} />}
                  </span>
                ) : (
                  "—"
                )
              }
              onCommit={(v) => updateTask(t.id, { effort: v || null })}
            />
          );
        },
      },
      {
        key: "start_date",
        label: "Start",
        defaultWidth: 110,
        maxWidth: 140,
        render: (t) => (
          <InlineDate
            value={t.start_date}
            editable={canEditTask(t)}
            onCommit={(v) => {
              if (v && t.current_due_date && v > t.current_due_date) {
                window.alert("Start date can't be after the due date.");
                return;
              }
              updateTask(t.id, { start_date: v || null });
            }}
          />
        ),
      },
      {
        key: "timing",
        label: "Timing",
        defaultWidth: 110,
        maxWidth: 150,
        render: (t) => {
          const timing = timingOf(t);
          return <span className={`status-pill ${timing.tone}`}>{timing.label}</span>;
        },
      },
      {
        key: "current_due_date",
        label: "Due",
        defaultWidth: 110,
        maxWidth: 140,
        render: (t) => (
          <InlineDate
            value={t.current_due_date}
            editable={canEditTask(t)}
            onCommit={(v) => {
              if (!v) return;
              if (t.start_date && v < t.start_date) {
                window.alert("Due date can't be before the start date.");
                return;
              }
              updateTask(t.id, { current_due_date: v });
            }}
          />
        ),
      },
      {
        key: "estimated_hours",
        label: "Est. hrs",
        defaultWidth: 90,
        maxWidth: 120,
        render: (t) => <InlineNumber value={t.estimated_hours} editable={canEditTask(t)} onCommit={(v) => updateTask(t.id, { estimated_hours: v })} />,
      },
      {
        key: "time_spent_hours",
        label: "Spent hrs",
        defaultWidth: 95,
        maxWidth: 120,
        render: (t) => <InlineNumber value={t.time_spent_hours ?? 0} editable={canEditTask(t)} onCommit={(v) => updateTask(t.id, { time_spent_hours: v ?? 0 })} />,
      },
    ],
    [people, projects, me]
  );

  const taskGroupOptions: GroupOption<TaskWithDepth>[] = [
    { key: "project", label: "Project", getGroup: (t) => projectName(t.project_id) },
    {
      key: "status",
      label: "Status",
      getGroup: (t) => t.status ?? "No status",
      getTone: (t) => statusTone(statusGroupOf(TASK_STATUS_GROUPED, t.status)),
    },
    { key: "assignee", label: "Assignee", getGroup: (t) => ownerName(t.assignee_id) },
    {
      key: "effort",
      label: "Effort",
      getGroup: (t) => t.effort ?? "No effort set",
      getTone: (t) => (t.effort ? effortColors[t.effort] ?? "neutral" : "neutral"),
    },
  ];

  const taskSortOptions: SortOption<TaskWithDepth>[] = [
    { key: "name", label: "Name", getValue: (t) => t.name ?? "" },
    { key: "project", label: "Project", getValue: (t) => projectName(t.project_id) },
    { key: "assignee", label: "Assignee", getValue: (t) => ownerName(t.assignee_id) },
    { key: "status", label: "Status", getValue: (t) => t.status ?? "" },
    { key: "start_date", label: "Start date", getValue: (t) => (t.start_date ? new Date(t.start_date).getTime() : null) },
    { key: "current_due_date", label: "Due date", getValue: (t) => (t.current_due_date ? new Date(t.current_due_date).getTime() : null) },
    { key: "estimated_hours", label: "Est. hrs", getValue: (t) => t.estimated_hours ?? null },
    { key: "time_spent_hours", label: "Spent hrs", getValue: (t) => t.time_spent_hours ?? null },
    { key: "effort", label: "Effort", getValue: (t) => (t.effort ? TASK_EFFORT_POINTS[t.effort] ?? null : null) },
  ];

  const taskViews = useTableViews("tasks", me?.id, {
    columnOrder: TASK_COLUMN_ORDER,
    hiddenColumns: [],
    columnWidths: {},
    groupBy: "project",
    hiddenGroups: [],
    color: "neutral",
    showCount: false,
    sorts: [],
  });

  // Instant, Notion-style row creation (mirrors createBlankProject): insert
  // a sensibly-defaulted task immediately and let the person fill it in via
  // the same inline cells every other row uses, instead of a separate
  // multi-field add form.
  async function createBlankTask(projectId: string) {
    if (!projectId) {
      window.alert("Create a project first before adding tasks.");
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const { error } = await supabase.from("tasks").insert({
      project_id: projectId,
      name: "Untitled task",
      status: "Not Started",
      original_due_date: today,
      current_due_date: today,
    });
    if (error) {
      window.alert(`Couldn't create task: ${error.message}`);
      return;
    }
    loadAll();
  }

  return (
    <div>
      {confirmDialog}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1>Projects &amp; Tasks</h1>
          <p className="subtitle">
            Every project and its tasks in one place. Owners can edit their project; anyone can edit their own tasks. Click any cell to edit it,
            like Notion.
          </p>
        </div>
        <button
          onClick={() => {
            setArchivedOpen(true);
            loadArchived();
          }}
          style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 10px", fontSize: 11.5, fontWeight: 500, color: "var(--text-secondary)", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", cursor: "pointer" }}
        >
          <ArchiveRestore size={13} />
          View archived
        </button>
      </div>

      <div className="card" style={{ padding: 0, marginBottom: 20 }}>
        <div className="table-toolbar">
          <ViewTabs
            views={projectViews.views}
            activeViewId={projectViews.activeViewId}
            rows={projects}
            groupOptions={projectGroupOptions}
            onSelect={projectViews.setActiveViewId}
            onCreate={projectViews.createView}
            onRename={projectViews.renameView}
            onDelete={projectViews.deleteView}
            onColorChange={projectViews.setViewColor}
            onDuplicate={projectViews.duplicateView}
            onEditView={(id) => {
              projectViews.setActiveViewId(id);
              setProjectSettingsOpen(true);
            }}
            confirm={confirm}
          />
          <ViewSettingsMenu
            open={projectSettingsOpen}
            onOpenChange={setProjectSettingsOpen}
            rows={projects}
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
            hiddenGroups={projectViews.activeView.hiddenGroups}
            onGroupByChange={(groupBy) => projectViews.updateActiveView({ groupBy, hiddenGroups: [] })}
            onHiddenGroupsChange={(hiddenGroups) => projectViews.updateActiveView({ hiddenGroups })}
            showCount={projectViews.activeView.showCount}
            onShowCountChange={(showCount) => projectViews.updateActiveView({ showCount })}
            sortOptions={projectSortOptions}
            sorts={projectViews.activeView.sorts}
            onSortsChange={(sorts) => projectViews.updateActiveView({ sorts })}
          />
        </div>
        {loading ? (
          <div style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>Loading…</div>
        ) : (
          <div className="data-table-dense">
            <DataTable
              columns={[
                ...projectColumns,
                {
                  key: "__archive",
                  label: "",
                  defaultWidth: 40,
                  minWidth: 36,
                  maxWidth: 48,
                  render: (p) =>
                    canEditProject(p) ? (
                      <button className="row-icon-btn" onClick={() => archiveProject(p)} title="Archive project">
                        <Archive size={12} />
                      </button>
                    ) : null,
                },
              ]}
              rows={projects}
              rowKey={(p) => p.id}
              view={projectViews.activeView}
              onViewChange={projectViews.updateActiveView}
              groupOptions={projectGroupOptions}
              sortOptions={projectSortOptions}
              emptyLabel="No projects yet. Add one below."
              footerRow={
                canCreateProject
                  ? (colSpan) => (
                      <td colSpan={colSpan} className="add-row-cell">
                        <div className="add-row-trigger" onClick={createBlankProject}>
                          <Plus size={12} />
                          New project
                        </div>
                      </td>
                    )
                  : undefined
              }
            />
          </div>
        )}
      </div>

      <h2 style={{ marginTop: 0 }}>Tasks</h2>

      <div className="card" style={{ padding: 0 }}>
        <div className="table-toolbar">
          <ViewTabs
            views={taskViews.views}
            activeViewId={taskViews.activeViewId}
            rows={visibleTasks}
            groupOptions={taskGroupOptions}
            onSelect={taskViews.setActiveViewId}
            onCreate={taskViews.createView}
            onRename={taskViews.renameView}
            onDelete={taskViews.deleteView}
            onColorChange={taskViews.setViewColor}
            onDuplicate={taskViews.duplicateView}
            onEditView={(id) => {
              taskViews.setActiveViewId(id);
              setTaskSettingsOpen(true);
            }}
            confirm={confirm}
          />
          <ViewSettingsMenu
            open={taskSettingsOpen}
            onOpenChange={setTaskSettingsOpen}
            rows={visibleTasks}
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
            hiddenGroups={taskViews.activeView.hiddenGroups}
            onGroupByChange={(groupBy) => taskViews.updateActiveView({ groupBy, hiddenGroups: [] })}
            onHiddenGroupsChange={(hiddenGroups) => taskViews.updateActiveView({ hiddenGroups })}
            showCount={taskViews.activeView.showCount}
            onShowCountChange={(showCount) => taskViews.updateActiveView({ showCount })}
            sortOptions={taskSortOptions}
            sorts={taskViews.activeView.sorts}
            onSortsChange={(sorts) => taskViews.updateActiveView({ sorts })}
          />
          {isFullAccess && (
            <button
              className="row-icon-btn"
              title="Customize Task Effort colors"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                setEffortMenuPos(effortMenuPos ? null : { x: rect.left, y: rect.bottom + 4 });
              }}
            >
              <Palette size={13} />
            </button>
          )}
        </div>
        {effortMenuPos && (
          <div style={{ position: "fixed", left: effortMenuPos.x, top: effortMenuPos.y, zIndex: 50 }}>
            <EffortColorMenu
              effortColors={effortColors}
              onPick={(level, tone) => setEffortColor(level, tone)}
              onClose={() => setEffortMenuPos(null)}
            />
          </div>
        )}
        {loading ? (
          <div style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>Loading…</div>
        ) : (
          <div className="data-table-dense">
            <DataTable
              columns={[
                ...taskColumns,
                {
                  key: "__archive",
                  label: "",
                  defaultWidth: 40,
                  minWidth: 36,
                  maxWidth: 48,
                  render: (t) =>
                    canManageTasksIn(t.project_id) ? (
                      <button className="row-icon-btn" onClick={() => archiveTask(t)} title="Archive task">
                        <Archive size={12} />
                      </button>
                    ) : null,
                },
              ]}
              rows={visibleTasks}
              rowKey={(t) => t.id}
              view={taskViews.activeView}
              onViewChange={taskViews.updateActiveView}
              groupOptions={taskGroupOptions}
              sortOptions={taskSortOptions}
              emptyLabel="No tasks yet. Add one below."
              footerRow={
                canCreateTask && taskViews.activeView.groupBy !== "project"
                  ? (colSpan) => (
                      <td colSpan={colSpan} className="add-row-cell">
                        <div className="add-row-trigger" onClick={() => createBlankTask(projects[0]?.id ?? "")}>
                          <Plus size={12} />
                          New task
                        </div>
                      </td>
                    )
                  : undefined
              }
              groupFooterRow={
                taskViews.activeView.groupBy === "project"
                  ? (colSpan, group) => {
                      const projectId = group.rows[0]?.project_id;
                      if (!projectId || !canManageTasksIn(projectId)) return null;
                      return (
                        <td colSpan={colSpan} className="add-row-cell">
                          <div className="add-row-trigger" onClick={() => createBlankTask(projectId)}>
                            <Plus size={12} />
                            New task
                          </div>
                        </td>
                      );
                    }
                  : undefined
              }
            />
          </div>
        )}
      </div>

      {archivedOpen && (
        <Modal title="Archived items" onClose={() => setArchivedOpen(false)} width={560}>
          {archivedLoading ? (
            <p style={{ fontSize: 12.5, color: "var(--muted)" }}>Loading…</p>
          ) : archivedProjects.length === 0 && archivedTasks.length === 0 ? (
            <p style={{ fontSize: 12.5, color: "var(--muted)" }}>Nothing archived right now.</p>
          ) : (
            <>
              <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 0 }}>
                Archived items are permanently deleted {ARCHIVE_RETENTION_DAYS} days after archiving unless restored.
              </p>
              {archivedProjects.length > 0 && (
                <>
                  <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3, color: "var(--muted)", margin: "10px 0 4px" }}>
                    Projects
                  </div>
                  {archivedProjects.map((p) => {
                    const daysLeft = p.archived_at
                      ? ARCHIVE_RETENTION_DAYS - Math.floor((Date.now() - new Date(p.archived_at).getTime()) / (1000 * 60 * 60 * 24))
                      : ARCHIVE_RETENTION_DAYS;
                    return (
                      <div key={p.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 2px", borderBottom: "1px solid var(--border)" }}>
                        <div>
                          <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy)" }}>{p.name}</div>
                          <div style={{ fontSize: 10.5, color: "var(--muted)" }}>{daysLeft > 0 ? `${daysLeft} days left` : "Deleting soon"}</div>
                        </div>
                        <button
                          onClick={() => restoreProject(p.id)}
                          style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 600, color: "var(--accent)", background: "none", border: "none", cursor: "pointer" }}
                        >
                          <ArchiveRestore size={13} />
                          Restore
                        </button>
                      </div>
                    );
                  })}
                </>
              )}
              {archivedTasks.length > 0 && (
                <>
                  <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3, color: "var(--muted)", margin: "10px 0 4px" }}>
                    Tasks
                  </div>
                  {archivedTasks.map((t) => {
                    const daysLeft = t.archived_at
                      ? ARCHIVE_RETENTION_DAYS - Math.floor((Date.now() - new Date(t.archived_at).getTime()) / (1000 * 60 * 60 * 24))
                      : ARCHIVE_RETENTION_DAYS;
                    return (
                      <div key={t.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 2px", borderBottom: "1px solid var(--border)" }}>
                        <div>
                          <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy)" }}>{t.name}</div>
                          <div style={{ fontSize: 10.5, color: "var(--muted)" }}>{daysLeft > 0 ? `${daysLeft} days left` : "Deleting soon"}</div>
                        </div>
                        <button
                          onClick={() => restoreTask(t.id)}
                          style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 600, color: "var(--accent)", background: "none", border: "none", cursor: "pointer" }}
                        >
                          <ArchiveRestore size={13} />
                          Restore
                        </button>
                      </div>
                    );
                  })}
                </>
              )}
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
