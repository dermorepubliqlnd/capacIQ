import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, CornerDownRight, ChevronRight, ChevronDown, ArchiveRestore, Trash2, Feather, Weight, BicepsFlexed } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useSession } from "../lib/useSession";
import { useTableViews } from "../lib/useTableViews";
import DataTable from "../components/DataTable";
import BoardView, { type BoardColumnDef } from "../components/BoardView";
import ViewTabs from "../components/ViewTabs";
import ViewSettingsMenu, { ViewFilterPills } from "../components/ViewSettingsMenu";
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
  PROJECT_STATUS_OPTIONS,
  TASK_STATUS_GROUPED,
  TASK_STATUS_OPTIONS,
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
  sort_order: number | null;
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
  sort_order: number | null;
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

// Same worst-first idea as healthRank, for Tasks' analogous computed
// "Timing" column (Overdue/Due soon/On track while open, Late/On time once
// complete).
function timingRank(label: string): number {
  if (label === "Overdue") return 0;
  if (label === "Late") return 1;
  if (label === "Due soon") return 2;
  if (label === "On track") return 3;
  return 4;
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

// Board view (v1) always groups by Status specifically -- it doesn't yet
// generalize to grouping by any field the way Table view's "Group by" does.
// Every exact status value gets its own column (not just the 3 To-do/In
// Progress/Complete buckets), matching Table view's Status pill exactly so
// dropping a card into a column sets an unambiguous, real status value.
// clusterLabel groups adjacent columns under one small section label so an
// 11-wide Projects board still reads with some structure.
const PROJECT_BOARD_COLUMNS: BoardColumnDef[] = PROJECT_STATUS_GROUPED.flatMap((group) =>
  group.options.map((value) => ({
    value,
    label: value,
    clusterLabel: group.label,
    tone: statusTone(statusGroupOf(PROJECT_STATUS_GROUPED, value)),
  }))
);

const TASK_BOARD_COLUMNS: BoardColumnDef[] = TASK_STATUS_GROUPED.flatMap((group) =>
  group.options.map((value) => ({
    value,
    label: value,
    clusterLabel: group.label,
    tone: statusTone(statusGroupOf(TASK_STATUS_GROUPED, value)),
  }))
);

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

// Small anchored dropdown for the bulk-action bar's field pickers (e.g.
// "Priority" -> Low/Medium/High). Deliberately minimal -- reuses the same
// .view-tab-dropdown look as other menus in this file rather than
// introducing a new visual style.
function FieldPickerButton({ label, options, onPick }: { label: string; options: string[]; onPick: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="bulk-bar-field-btn" onClick={() => setOpen((v) => !v)}>
        {label}
      </button>
      {open && (
        <div className="view-tab-dropdown" style={{ width: 170 }}>
          {options.map((o) => (
            <button
              key={o}
              onClick={() => {
                onPick(o);
                setOpen(false);
              }}
            >
              {o}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Notion-style fractional positioning: given the full ordered list (with
// each row's current sort_order) and a drag from `draggedId` onto
// `targetId`, returns the sort_order value that places the dragged row
// immediately before the target -- the midpoint between the target's
// previous neighbor and the target itself, so no other row needs to be
// renumbered.
function reorderedSortValue(list: { id: string; sort_order: number | null }[], draggedId: string, targetId: string): number | null {
  const filtered = list.filter((r) => r.id !== draggedId);
  const idx = filtered.findIndex((r) => r.id === targetId);
  if (idx === -1) return null;
  const target = filtered[idx];
  const before = filtered[idx - 1];
  const afterVal = target.sort_order ?? (idx + 1) * 1000;
  const beforeVal = before ? before.sort_order ?? 0 : afterVal - 1000;
  return (beforeVal + afterVal) / 2;
}

export default function Projects() {
  const { person: me } = useSession();
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [people, setPeople] = useState<PersonOption[]>([]);
  const [loading, setLoading] = useState(true);

  const [collapsedParents, setCollapsedParents] = useState<string[]>([]);
  const { confirm, alert, dialog: confirmDialog } = useConfirm();

  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archivedProjects, setArchivedProjects] = useState<ProjectRow[]>([]);
  const [archivedTasks, setArchivedTasks] = useState<TaskRow[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);

  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);

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
    const [{ data: projectData }, { data: taskData }, { data: peopleData }] = await Promise.all([
      supabase.from("projects").select("*").eq("is_archived", false).order("sort_order"),
      supabase.from("tasks").select("*").eq("is_archived", false).order("sort_order"),
      supabase.from("people").select("id,name").eq("is_active", true).order("name"),
    ]);
    const nextProjects = (projectData as ProjectRow[]) ?? [];
    const nextTasks = (taskData as TaskRow[]) ?? [];
    setProjects(nextProjects);
    setTasks(nextTasks);
    setPeople((peopleData as PersonOption[]) ?? []);
    // Drop any selection for rows that no longer exist in the fresh load
    // (e.g. after a bulk delete) so the bulk-action bar doesn't linger.
    const projectIds = new Set(nextProjects.map((p) => p.id));
    const taskIds = new Set(nextTasks.map((t) => t.id));
    setSelectedProjectIds((prev) => prev.filter((id) => projectIds.has(id)));
    setSelectedTaskIds((prev) => prev.filter((id) => taskIds.has(id)));
    setLoading(false);
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
      alert(`Couldn't save: ${error.message}`);
      loadAll();
    }
  }

  async function updateTask(id: string, patch: Partial<TaskRow>) {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    const { error } = await supabase.from("tasks").update(patch).eq("id", id);
    if (error) {
      alert(`Couldn't save: ${error.message}`);
      loadAll();
    }
  }

  async function restoreProject(id: string) {
    const { error } = await supabase.from("projects").update({ is_archived: false, archived_at: null }).eq("id", id);
    if (error) {
      alert(`Couldn't restore: ${error.message}`);
      return;
    }
    await supabase.from("tasks").update({ is_archived: false, archived_at: null }).eq("project_id", id);
    loadArchived();
    loadAll();
  }

  async function deleteProjectPermanently(p: ProjectRow) {
    const ok = await confirm({
      title: "Delete permanently",
      message: `Permanently delete "${p.name}"? This can't be undone.`,
      confirmLabel: "Delete permanently",
      danger: true,
    });
    if (!ok) return;
    await supabase.from("tasks").delete().eq("project_id", p.id);
    const { error } = await supabase.from("projects").delete().eq("id", p.id);
    if (error) {
      alert(`Couldn't delete: ${error.message}`);
      return;
    }
    loadArchived();
  }

  async function bulkUpdateProjects(patch: Partial<ProjectRow>) {
    const ids = selectedProjectIds;
    if (ids.length === 0) return;
    setProjects((prev) => prev.map((p) => (ids.includes(p.id) ? { ...p, ...patch } : p)));
    const { error } = await supabase.from("projects").update(patch).in("id", ids);
    if (error) {
      alert(`Couldn't update: ${error.message}`);
      loadAll();
    }
  }

  async function bulkDeleteProjects() {
    const ids = selectedProjectIds;
    if (ids.length === 0) return;
    const childTaskCount = tasks.filter((t) => ids.includes(t.project_id)).length;
    const ok = await confirm({
      title: "Delete projects",
      message:
        childTaskCount > 0
          ? `Delete ${ids.length} project${ids.length > 1 ? "s" : ""}? This will also archive ${childTaskCount} task${childTaskCount > 1 ? "s" : ""} in them. Everything can be restored within ${ARCHIVE_RETENTION_DAYS} days unless permanently deleted.`
          : `Delete ${ids.length} project${ids.length > 1 ? "s" : ""}? They'll be archived and can be restored within ${ARCHIVE_RETENTION_DAYS} days unless permanently deleted.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    const now = new Date().toISOString();
    const { error } = await supabase.from("projects").update({ is_archived: true, archived_at: now }).in("id", ids);
    if (error) {
      alert(`Couldn't delete: ${error.message}`);
      return;
    }
    await supabase.from("tasks").update({ is_archived: true, archived_at: now }).in("project_id", ids);
    setSelectedProjectIds([]);
    loadAll();
  }

  async function reorderProjects(draggedId: string, targetId: string) {
    if (projectViews.activeView.sorts.length > 0) {
      const ok = await confirm({
        title: "Clear sort to reorder",
        message: "This view is currently sorted. Dragging to reorder will clear that sort so your manual order can show. Continue?",
        confirmLabel: "Clear sort & reorder",
      });
      if (!ok) return;
      projectViews.updateActiveView({ sorts: [] });
    }
    const newVal = reorderedSortValue(projects.map((p) => ({ id: p.id, sort_order: p.sort_order })), draggedId, targetId);
    if (newVal == null) return;
    setProjects((prev) => prev.map((p) => (p.id === draggedId ? { ...p, sort_order: newVal } : p)).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)));
    const { error } = await supabase.from("projects").update({ sort_order: newVal }).eq("id", draggedId);
    if (error) {
      alert(`Couldn't reorder: ${error.message}`);
      loadAll();
    }
  }

  function toggleProjectSelectAll(keys: string[]) {
    setSelectedProjectIds((prev) => (keys.every((k) => prev.includes(k)) ? prev.filter((k) => !keys.includes(k)) : Array.from(new Set([...prev, ...keys]))));
  }

  // Tasks are never archived on their own -- only projects get the 30-day
  // archive/restore treatment (a task can still end up briefly archived as
  // a side effect of its parent project being deleted, see bulkDeleteProjects
  // above). Deleting a task is always via checkbox selection + the bulk
  // Delete button (bulkDeleteTasks below) -- there's no separate per-row
  // delete affordance since selecting one row already surfaces Delete.
  async function restoreTask(id: string) {
    const { error } = await supabase.from("tasks").update({ is_archived: false, archived_at: null }).eq("id", id);
    if (error) {
      alert(`Couldn't restore: ${error.message}`);
      return;
    }
    loadArchived();
    loadAll();
  }

  async function deleteTaskPermanently(t: TaskRow) {
    const ok = await confirm({
      title: "Delete permanently",
      message: `Permanently delete "${t.name}"? This can't be undone.`,
      confirmLabel: "Delete permanently",
      danger: true,
    });
    if (!ok) return;
    const { error } = await supabase.from("tasks").delete().eq("id", t.id);
    if (error) {
      alert(`Couldn't delete: ${error.message}`);
      return;
    }
    loadArchived();
  }

  async function bulkUpdateTasks(patch: Partial<TaskRow>) {
    const ids = selectedTaskIds;
    if (ids.length === 0) return;
    setTasks((prev) => prev.map((t) => (ids.includes(t.id) ? { ...t, ...patch } : t)));
    const { error } = await supabase.from("tasks").update(patch).in("id", ids);
    if (error) {
      alert(`Couldn't update: ${error.message}`);
      loadAll();
    }
  }

  async function bulkDeleteTasks() {
    const ids = selectedTaskIds;
    if (ids.length === 0) return;
    const childIds = tasks.filter((t) => t.parent_task_id && ids.includes(t.parent_task_id)).map((t) => t.id);
    const allIds = Array.from(new Set([...ids, ...childIds]));
    const ok = await confirm({
      title: "Delete tasks",
      message: `Delete ${ids.length} task${ids.length > 1 ? "s" : ""}${childIds.length ? ` (and ${childIds.length} sub-task${childIds.length > 1 ? "s" : ""})` : ""}? This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    const { error } = await supabase.from("tasks").delete().in("id", allIds);
    if (error) {
      alert(`Couldn't delete: ${error.message}`);
      return;
    }
    setSelectedTaskIds([]);
    loadAll();
  }

  async function reorderTasks(draggedId: string, targetId: string) {
    if (taskViews.activeView.sorts.length > 0) {
      const ok = await confirm({
        title: "Clear sort to reorder",
        message: "This view is currently sorted. Dragging to reorder will clear that sort so your manual order can show. Continue?",
        confirmLabel: "Clear sort & reorder",
      });
      if (!ok) return;
      taskViews.updateActiveView({ sorts: [] });
    }
    const newVal = reorderedSortValue(tasks.map((t) => ({ id: t.id, sort_order: t.sort_order })), draggedId, targetId);
    if (newVal == null) return;
    setTasks((prev) => prev.map((t) => (t.id === draggedId ? { ...t, sort_order: newVal } : t)).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)));
    const { error } = await supabase.from("tasks").update({ sort_order: newVal }).eq("id", draggedId);
    if (error) {
      alert(`Couldn't reorder: ${error.message}`);
      loadAll();
    }
  }

  function toggleTaskSelectAll(keys: string[]) {
    setSelectedTaskIds((prev) => (keys.every((k) => prev.includes(k)) ? prev.filter((k) => !keys.includes(k)) : Array.from(new Set([...prev, ...keys]))));
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
                alert("Start date can't be after the due date.");
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
                alert("Due date can't be before the start date.");
                return;
              }
              updateProject(p.id, { end_date: v || null });
            }}
          />
        ),
      },
    ],
    [people, projects, me]
  );

  // Board-view card body: picks a handful of the same column render()
  // functions Table view already uses (bold name, owner picker, priority
  // pill, due date) so a card is editable exactly like a row is -- no
  // separate card-editing UI to build or keep in sync.
  function renderProjectCard(p: ProjectRow) {
    const find = (key: string) => projectColumns.find((c) => c.key === key);
    return (
      <>
        <div>{find("name")?.render(p)}</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {find("priority")?.render(p)}
          {find("owner")?.render(p)}
        </div>
        <div>{find("end_date")?.render(p)}</div>
      </>
    );
  }

  // Labels here are kept identical to each column's own header text
  // (e.g. "Project" not "Name", "Start"/"Due" not "Start date"/"Due date")
  // so the Sort/Group-by pickers read as the same fields people see in the
  // table, and every column that makes sense to sort or group by is listed
  // -- previously Owner and Effort were missing from Sort, silently making
  // some columns impossible to sort on.
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
      key: "effort_level",
      label: "Effort",
      getGroup: (p) => p.effort_level ?? "No effort set",
      getTone: (p) => PROJECT_EFFORT_LEVEL_TONES[p.effort_level ?? ""] ?? "neutral",
    },
    {
      key: "health",
      label: "Health",
      getGroup: (p) => healthOf(p).label,
      getTone: (p) => healthOf(p).tone,
    },
  ];

  const projectSortOptions: SortOption<ProjectRow>[] = [
    { key: "name", label: "Project", getValue: (p) => p.name ?? "" },
    { key: "owner", label: "Owner", getValue: (p) => ownerName(p.owner_id) },
    { key: "priority", label: "Priority", getValue: (p) => PROJECT_PRIORITY_OPTIONS.indexOf(p.priority ?? "") },
    { key: "project_status", label: "Status", getValue: (p) => p.project_status ?? "" },
    { key: "category", label: "Category", getValue: (p) => p.category ?? "" },
    { key: "effort_level", label: "Effort", getValue: (p) => PROJECT_EFFORT_LEVEL_OPTIONS.indexOf(p.effort_level ?? "") },
    { key: "start_date", label: "Start", getValue: (p) => (p.start_date ? new Date(p.start_date).getTime() : null) },
    { key: "end_date", label: "Due", getValue: (p) => (p.end_date ? new Date(p.end_date).getTime() : null) },
    { key: "health", label: "Health", getValue: (p) => healthRank(healthOf(p).label) },
  ];

  const projectViews = useTableViews("projects", me?.id, {
    viewType: "table",
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
    const { error } = await supabase.from("projects").insert({ name: "Untitled", sort_order: Date.now() });
    if (error) {
      alert(`Couldn't create project: ${error.message}`);
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
      sort_order: Date.now(),
    });
    if (error) {
      alert(`Couldn't add subtask: ${error.message}`);
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
          const tone = t.effort ? TASK_EFFORT_DEFAULT_TONES[t.effort] ?? "neutral" : "neutral";
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
                alert("Start date can't be after the due date.");
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
                alert("Due date can't be before the start date.");
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

  function renderTaskCard(t: TaskWithDepth) {
    const find = (key: string) => taskColumns.find((c) => c.key === key);
    return (
      <>
        <div>{find("name")?.render(t)}</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {find("project")?.render(t)}
          {find("assignee")?.render(t)}
        </div>
        <div>{find("current_due_date")?.render(t)}</div>
      </>
    );
  }

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
      getTone: (t) => (t.effort ? TASK_EFFORT_DEFAULT_TONES[t.effort] ?? "neutral" : "neutral"),
    },
    {
      key: "timing",
      label: "Timing",
      getGroup: (t) => timingOf(t).label,
      getTone: (t) => timingOf(t).tone,
    },
  ];

  // Labels here match each column's own header text exactly (e.g. "Task"
  // not "Name", "Start"/"Due" not "Start date"/"Due date"), and every
  // sortable column is listed -- "Timing" was previously missing entirely.
  const taskSortOptions: SortOption<TaskWithDepth>[] = [
    { key: "name", label: "Task", getValue: (t) => t.name ?? "" },
    { key: "project", label: "Project", getValue: (t) => projectName(t.project_id) },
    { key: "assignee", label: "Assignee", getValue: (t) => ownerName(t.assignee_id) },
    { key: "status", label: "Status", getValue: (t) => t.status ?? "" },
    { key: "effort", label: "Effort", getValue: (t) => (t.effort ? TASK_EFFORT_POINTS[t.effort] ?? null : null) },
    { key: "start_date", label: "Start", getValue: (t) => (t.start_date ? new Date(t.start_date).getTime() : null) },
    { key: "timing", label: "Timing", getValue: (t) => timingRank(timingOf(t).label) },
    { key: "current_due_date", label: "Due", getValue: (t) => (t.current_due_date ? new Date(t.current_due_date).getTime() : null) },
    { key: "estimated_hours", label: "Est. hrs", getValue: (t) => t.estimated_hours ?? null },
    { key: "time_spent_hours", label: "Spent hrs", getValue: (t) => t.time_spent_hours ?? null },
  ];

  const taskViews = useTableViews("tasks", me?.id, {
    viewType: "table",
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
      alert("Create a project first before adding tasks.");
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const { error } = await supabase.from("tasks").insert({
      project_id: projectId,
      name: "Untitled task",
      status: "Not Started",
      original_due_date: today,
      current_due_date: today,
      sort_order: Date.now(),
    });
    if (error) {
      alert(`Couldn't create task: ${error.message}`);
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
            confirm={confirm}
          />
          {projectViews.activeView.viewType !== "board" && (
            <div className="toolbar-actions">
              <ViewSettingsMenu
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
          )}
        </div>
        {projectViews.activeView.viewType !== "board" && (
          <ViewFilterPills
            groupOptions={projectGroupOptions}
            groupBy={projectViews.activeView.groupBy}
            hiddenGroups={projectViews.activeView.hiddenGroups}
            onGroupByChange={(groupBy) => projectViews.updateActiveView({ groupBy, hiddenGroups: [] })}
            onHiddenGroupsChange={(hiddenGroups) => projectViews.updateActiveView({ hiddenGroups })}
            sortOptions={projectSortOptions}
            sorts={projectViews.activeView.sorts}
            onSortsChange={(sorts) => projectViews.updateActiveView({ sorts })}
          />
        )}
        {projectViews.activeView.viewType !== "board" && selectedProjectIds.length > 0 && (
          <div className="bulk-bar">
            <span className="bulk-bar-count">{selectedProjectIds.length} selected</span>
            <button className="bulk-bar-clear" onClick={() => setSelectedProjectIds([])}>
              Clear
            </button>
            <div className="bulk-bar-actions">
              <FieldPickerButton label="Priority" options={PROJECT_PRIORITY_OPTIONS} onPick={(v) => bulkUpdateProjects({ priority: v as ProjectRow["priority"] })} />
              <FieldPickerButton
                label="Owner"
                options={people.map((x) => x.name)}
                onPick={(v) => {
                  const person = people.find((x) => x.name === v);
                  bulkUpdateProjects({ owner_id: person?.id ?? null });
                }}
              />
              <FieldPickerButton label="Status" options={PROJECT_STATUS_OPTIONS} onPick={(v) => bulkUpdateProjects({ project_status: v || null })} />
              <button className="bulk-bar-delete" onClick={bulkDeleteProjects}>
                <Trash2 size={12} />
                Delete
              </button>
            </div>
          </div>
        )}
        {loading ? (
          <div style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>Loading…</div>
        ) : projectViews.activeView.viewType === "board" ? (
          <>
            <BoardView
              rows={projects}
              rowKey={(p) => p.id}
              columns={PROJECT_BOARD_COLUMNS}
              getValue={(p) => p.project_status}
              hiddenColumns={[]}
              renderCard={renderProjectCard}
              onMoveCard={(p, newValue) => updateProject(p.id, { project_status: newValue || null })}
              onReorderCard={reorderProjects}
            />
            {canCreateProject && (
              <div className="add-row-trigger" style={{ margin: "0 12px 12px" }} onClick={createBlankProject}>
                <Plus size={12} />
                New project
              </div>
            )}
          </>
        ) : (
          <div className="data-table-dense">
            <DataTable
              columns={projectColumns}
              rows={projects}
              rowKey={(p) => p.id}
              view={projectViews.activeView}
              onViewChange={projectViews.updateActiveView}
              groupOptions={projectGroupOptions}
              sortOptions={projectSortOptions}
              emptyLabel="No projects yet. Add one below."
              selectable
              selectedKeys={selectedProjectIds}
              onToggleSelect={(key) => setSelectedProjectIds((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))}
              onToggleSelectAll={toggleProjectSelectAll}
              orderable
              onReorder={reorderProjects}
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
            confirm={confirm}
          />
          {taskViews.activeView.viewType !== "board" && (
            <div className="toolbar-actions">
              <ViewSettingsMenu
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
            </div>
          )}
        </div>
        {taskViews.activeView.viewType !== "board" && (
          <ViewFilterPills
            groupOptions={taskGroupOptions}
            groupBy={taskViews.activeView.groupBy}
            hiddenGroups={taskViews.activeView.hiddenGroups}
            onGroupByChange={(groupBy) => taskViews.updateActiveView({ groupBy, hiddenGroups: [] })}
            onHiddenGroupsChange={(hiddenGroups) => taskViews.updateActiveView({ hiddenGroups })}
            sortOptions={taskSortOptions}
            sorts={taskViews.activeView.sorts}
            onSortsChange={(sorts) => taskViews.updateActiveView({ sorts })}
          />
        )}
        {taskViews.activeView.viewType !== "board" && selectedTaskIds.length > 0 && (
          <div className="bulk-bar">
            <span className="bulk-bar-count">{selectedTaskIds.length} selected</span>
            <button className="bulk-bar-clear" onClick={() => setSelectedTaskIds([])}>
              Clear
            </button>
            <div className="bulk-bar-actions">
              <FieldPickerButton label="Status" options={TASK_STATUS_OPTIONS} onPick={(v) => bulkUpdateTasks({ status: v || null })} />
              <FieldPickerButton
                label="Assignee"
                options={people.map((x) => x.name)}
                onPick={(v) => {
                  const person = people.find((x) => x.name === v);
                  bulkUpdateTasks({ assignee_id: person?.id ?? null });
                }}
              />
              <button className="bulk-bar-delete" onClick={bulkDeleteTasks}>
                <Trash2 size={12} />
                Delete
              </button>
            </div>
          </div>
        )}
        {loading ? (
          <div style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>Loading…</div>
        ) : taskViews.activeView.viewType === "board" ? (
          <>
            <BoardView
              rows={visibleTasks}
              rowKey={(t) => t.id}
              columns={TASK_BOARD_COLUMNS}
              getValue={(t) => t.status}
              hiddenColumns={[]}
              renderCard={renderTaskCard}
              onMoveCard={(t, newValue) => updateTask(t.id, { status: newValue || null })}
              onReorderCard={reorderTasks}
            />
            {canCreateTask && (
              <div className="add-row-trigger" style={{ margin: "0 12px 12px" }} onClick={() => createBlankTask(projects[0]?.id ?? "")}>
                <Plus size={12} />
                New task
              </div>
            )}
          </>
        ) : (
          <div className="data-table-dense">
            <DataTable
              columns={taskColumns}
              rows={visibleTasks}
              rowKey={(t) => t.id}
              view={taskViews.activeView}
              onViewChange={taskViews.updateActiveView}
              groupOptions={taskGroupOptions}
              sortOptions={taskSortOptions}
              emptyLabel="No tasks yet. Add one below."
              selectable
              selectedKeys={selectedTaskIds}
              onToggleSelect={(key) => setSelectedTaskIds((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))}
              onToggleSelectAll={toggleTaskSelectAll}
              orderable
              onReorder={reorderTasks}
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
                        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                          <button
                            onClick={() => restoreProject(p.id)}
                            style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 600, color: "var(--accent)", background: "none", border: "none", cursor: "pointer" }}
                          >
                            <ArchiveRestore size={13} />
                            Restore
                          </button>
                          <button
                            onClick={() => deleteProjectPermanently(p)}
                            style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 600, color: "var(--danger-text)", background: "none", border: "none", cursor: "pointer" }}
                          >
                            <Trash2 size={13} />
                            Delete permanently
                          </button>
                        </div>
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
                        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                          <button
                            onClick={() => restoreTask(t.id)}
                            style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 600, color: "var(--accent)", background: "none", border: "none", cursor: "pointer" }}
                          >
                            <ArchiveRestore size={13} />
                            Restore
                          </button>
                          <button
                            onClick={() => deleteTaskPermanently(t)}
                            style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 600, color: "var(--danger-text)", background: "none", border: "none", cursor: "pointer" }}
                          >
                            <Trash2 size={13} />
                            Delete permanently
                          </button>
                        </div>
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
