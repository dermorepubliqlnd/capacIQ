import { useEffect, useState, type CSSProperties } from "react";
import { ShieldCheck, ShieldOff, Pencil, Check, X, Plus, ArrowUp, ArrowDown, Trash2, CalendarClock, CalendarDays, GripVertical, ChevronRight } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useSession } from "../lib/useSession";
import { CATEGORY_ICON_LIBRARY, CATEGORY_ICON_NAMES, CATEGORY_TONE_NAMES, CATEGORY_TONE_ICON_COLOR } from "../lib/categoryIcons";

function AccessDenied() {
  return (
    <div>
      <h1>Site settings</h1>
      <p className="subtitle">Admin only.</p>
      <div className="card">
        <p style={{ margin: 0, fontSize: 12.5 }}>
          Your account doesn&apos;t have Full Access, so this page isn&apos;t available. Ask a director or manager
          with Full Access to make changes here.
        </p>
      </div>
    </div>
  );
}

// Rename/delete safety reminders (2026-09-03, Sandra: "for all list if
// something is renamed, all existing tags will be renamed. for deleting
// do not allow deleting if there is an existing tag. Also always add a
// reminder for these before saving changes"). Delete-blocked-if-in-use
// was already true for every list below (each delete function does its
// own usage-count check before ever offering a confirm) -- this only
// adds the confirm-dialog reminder itself, and fixes the one real gap:
// Category/Phase/Time Logging Reason are plain-text tags copied onto
// projects/time_entries (not an id FK like Source/Work Type/Output
// Type), so renaming the list item alone silently left every
// already-tagged row on the old string forever. confirmPlainTextRename +
// cascadePlainTextRename fix that -- confirmFkRename is the lighter
// version for the three FK-based lists, where nothing needs migrating
// since every read already joins live off the id.
function confirmFkRename(oldName: string, newName: string, label: string): boolean {
  if (oldName === newName) return true;
  return window.confirm(`Rename "${oldName}" to "${newName}"? Every ${label} already using it will show "${newName}" immediately -- nothing else to update.`);
}

async function confirmPlainTextRename(table: string, column: string, oldName: string, newName: string, label: string): Promise<boolean> {
  if (oldName === newName) return true;
  const { count } = await supabase.from(table).select("id", { count: "exact", head: true }).eq(column, oldName);
  const n = count ?? 0;
  return window.confirm(
    n > 0
      ? `Rename "${oldName}" to "${newName}"? ${n} ${label}${n === 1 ? "" : "s"} currently tagged "${oldName}" will be updated to show "${newName}" instead. Continue?`
      : `Rename "${oldName}" to "${newName}"? No ${label}s currently use "${oldName}".`
  );
}

async function cascadePlainTextRename(table: string, column: string, oldName: string, newName: string): Promise<string | undefined> {
  if (oldName === newName) return undefined;
  const { error } = await supabase.from(table).update({ [column]: newName }).eq(column, oldName);
  return error?.message;
}

// Work Type -- admin-configurable lookup (Phase 12, 2026-08-20; moved out
// of Admin.tsx into its own Site Settings page in a later round). See
// supabase/phase12_migration.sql for the table itself (work_types) and
// supabase/phase12_migration_2.sql for the delete RLS policy added
// alongside the Delete button below.
interface WorkTypeRow {
  id: string;
  name: string;
  sort_order: number;
  is_active: boolean;
  is_fixed_schedule: boolean;
}

// Project Source -- admin-configurable lookup (Phase 20, 2026-08-24) for
// the Portfolio Dashboard's "Source" donut/filter. Mirrors Work Types'
// own table/RLS/UI shape exactly, minus the Fixed-Schedule concept
// (that's a task-scheduling idea, not applicable at the project level).
// See supabase/phase20_migration.sql for the table itself
// (project_sources) and projects.source_id.
interface ProjectSourceRow {
  id: string;
  name: string;
  sort_order: number;
  is_active: boolean;
}

// Time Logging Reason -- admin-configurable lookup (Phase 37,
// 2026-09-03). Was a fixed array in code (TIME_ENTRY_REASON_OPTIONS in
// timeTracking.ts); Sandra: "add in list settings the reasons for
// manual time logging, we want to be able to control it." Same
// plain-text-tag pattern as Category/Phase (time_entries.reason_category
// is plain text, not a reason_id FK) -- rename here cascades into every
// existing time_entries row via confirmPlainTextRename/
// cascadePlainTextRename above, same as Category/Phase.
interface TimeEntryReasonRow {
  id: string;
  name: string;
  sort_order: number;
  is_active: boolean;
}

// Project Category -- admin-configurable lookup (2026-09-03). Mirrors
// Project Sources' own table/RLS/UI shape exactly. Unlike Source,
// projects.category stays plain text (no category_id FK) -- see the
// comment on ProjectCategoryOption in Projects.tsx for why. See
// supabase/phase34_migration.sql for the table itself (project_categories).
interface ProjectCategoryRow {
  id: string;
  name: string;
  sort_order: number;
  is_active: boolean;
  // Self-service icon/color (Phase 36, 2026-09-03) -- see categoryIcons.ts
  // for the fixed palettes the picker offers.
  icon: string;
  color: string;
}

// Project Phase -- admin-configurable lookup (2026-09-03), same shape
// as Project Category. Which Phases are offered under Status "Not
// Started"/"In Progress" is a separate mapping table
// (project_status_phase_mapping), edited as a matrix below -- same
// pattern as the Task Type <-> Output Type mapping. See
// supabase/phase35_migration.sql.
interface ProjectPhaseRow {
  id: string;
  name: string;
  sort_order: number;
  is_active: boolean;
}

// Output Type -- admin-configurable lookup (Phase 21, 2026-08-24) for
// Materials Output tracking. Mirrors Project Sources' own table/RLS/UI
// shape exactly, but keyed off tasks.output_type_id instead of
// projects.source_id -- Sandra: Output Type + Output Count should appear
// on every task, not just the project level. See
// supabase/phase21_migration.sql for the table itself (output_types).
interface OutputTypeRow {
  id: string;
  name: string;
  sort_order: number;
  is_active: boolean;
}

export default function SiteSettings() {
  const { person: me, loading: sessionLoading } = useSession();

  // Work Types (Phase 12, 2026-08-20): admin-configurable lookup backing
  // the new task-level "Work Type" field on Projects/WBS Planning, so
  // Sandra can add/rename/reorder/deactivate categories herself with no
  // code change. Reorder is done with simple up/down buttons rather than
  // the grip-handle drag used for table columns elsewhere -- this list is
  // short (starts at 8 rows) and swapping sort_order with a neighbor via
  // two buttons is simpler/less fragile to build correctly here than
  // replicating the full drag machinery for a brand-new list; worth
  // revisiting if this list grows much longer.
  const [workTypes, setWorkTypes] = useState<WorkTypeRow[]>([]);
  const [workTypesLoading, setWorkTypesLoading] = useState(true);
  const [newWorkTypeName, setNewWorkTypeName] = useState("");
  const [workTypeBusy, setWorkTypeBusy] = useState(false);
  const [editingWorkTypeId, setEditingWorkTypeId] = useState<string | null>(null);
  const [editWorkTypeName, setEditWorkTypeName] = useState("");

  // Project Sources (Phase 20, 2026-08-24) -- same list-management state
  // shape as Work Types above, one level up (projects, not tasks).
  const [projectSources, setProjectSources] = useState<ProjectSourceRow[]>([]);
  const [projectSourcesLoading, setProjectSourcesLoading] = useState(true);
  const [newProjectSourceName, setNewProjectSourceName] = useState("");
  const [projectSourceBusy, setProjectSourceBusy] = useState(false);
  const [editingProjectSourceId, setEditingProjectSourceId] = useState<string | null>(null);
  const [editProjectSourceName, setEditProjectSourceName] = useState("");

  // Project Categories (2026-09-03) -- same list-management state shape as
  // Project Sources above.
  const [projectCategories, setProjectCategories] = useState<ProjectCategoryRow[]>([]);
  const [projectCategoriesLoading, setProjectCategoriesLoading] = useState(true);
  const [newProjectCategoryName, setNewProjectCategoryName] = useState("");
  const [projectCategoryBusy, setProjectCategoryBusy] = useState(false);
  const [editingProjectCategoryId, setEditingProjectCategoryId] = useState<string | null>(null);
  const [editProjectCategoryName, setEditProjectCategoryName] = useState("");
  // Icon/color picker popover (Phase 36, 2026-09-03) -- which category
  // row's swatch button is currently open; only one at a time.
  const [categoryIconPickerId, setCategoryIconPickerId] = useState<string | null>(null);

  // Project Phases (2026-09-03) -- same list-management state shape as
  // Project Categories above.
  const [projectPhases, setProjectPhases] = useState<ProjectPhaseRow[]>([]);
  const [projectPhasesLoading, setProjectPhasesLoading] = useState(true);
  const [newProjectPhaseName, setNewProjectPhaseName] = useState("");
  const [projectPhaseBusy, setProjectPhaseBusy] = useState(false);
  const [editingProjectPhaseId, setEditingProjectPhaseId] = useState<string | null>(null);
  const [editProjectPhaseName, setEditProjectPhaseName] = useState("");
  const [draggedProjectPhaseId, setDraggedProjectPhaseId] = useState<string | null>(null);

  // Status <-> Phase conditional mapping (2026-09-03) -- Sandra: "the
  // phase is conditional/dependent on the project status so make sure I
  // can make that mapping." Only Not Started/In Progress get a real,
  // editable subset here -- Completed/Paused/Cancelled follow fixed
  // rules baked into Projects.tsx (see phaseOptionsForStatus there).
  const [phaseStatusMapping, setPhaseStatusMapping] = useState<{ status: string; phase_id: string }[]>([]);
  const [phaseMappingBusy, setPhaseMappingBusy] = useState(false);
  const PHASE_MAPPABLE_STATUSES = ["Not Started", "In Progress"] as const;

  // Output Types (Phase 21, 2026-08-24) -- same list-management state
  // shape as Work Types/Project Sources above, keyed off tasks.
  const [outputTypes, setOutputTypes] = useState<OutputTypeRow[]>([]);
  const [outputTypesLoading, setOutputTypesLoading] = useState(true);
  const [newOutputTypeName, setNewOutputTypeName] = useState("");
  const [outputTypeBusy, setOutputTypeBusy] = useState(false);
  const [editingOutputTypeId, setEditingOutputTypeId] = useState<string | null>(null);
  const [editOutputTypeName, setEditOutputTypeName] = useState("");

  // Task Type <-> Output Type conditional mapping (Phase 23, 2026-08-25) --
  // Sandra: "I want the output be conditional based on task type." Each
  // row here is one allowed pairing; edited from the Task Type side (her
  // choice) via a checklist in its side-peek panel below.
  const [mappings, setMappings] = useState<{ work_type_id: string; output_type_id: string }[]>([]);
  const [mappingBusy, setMappingBusy] = useState(false);

  // Outline + side-peek panel (Phase 23 redesign): the outline itself only
  // shows a collapsed row per item -- clicking one opens this panel
  // instead of exposing every control inline. Only one panel open at a
  // time, shared between both lists via `kind`. Reuses the existing
  // editWorkTypeName/editOutputTypeName + editingWorkTypeId/
  // editingOutputTypeId state above as the panel's own name-draft field
  // (startEditWorkType/startEditOutputType already populate them).
  // Lists directory + Manage List drawer (2026-08-25 redesign, Sandra
  // pasted a reference app screenshot: Settings > Lists shows a summary
  // row per list -- name, item count, "Manage List" button -- instead of
  // every item always expanded on the page). Only one drawer open at a
  // time. Output Types has no directory row of its own -- Sandra's ask
  // was for the Work Types drawer to embed the Task Type x Output Type
  // matrix directly ("add by row or by column then just check"), so
  // Output Type rename/activate/delete/add all happen from inside that
  // matrix's column headers instead of a separate list.
  const [manageDrawer, setManageDrawer] = useState<"sources" | "categories" | "phases" | "phase_mapping" | "work_types" | "reasons" | null>(null);
  const [draggedWorkTypeId, setDraggedWorkTypeId] = useState<string | null>(null);
  const [draggedOutputTypeId, setDraggedOutputTypeId] = useState<string | null>(null);
  const [draggedProjectSourceId, setDraggedProjectSourceId] = useState<string | null>(null);

  // Time Logging Reasons (2026-09-03) -- same list-management state shape
  // as Project Sources above.
  const [timeEntryReasons, setTimeEntryReasons] = useState<TimeEntryReasonRow[]>([]);
  const [timeEntryReasonsLoading, setTimeEntryReasonsLoading] = useState(true);
  const [newTimeEntryReasonName, setNewTimeEntryReasonName] = useState("");
  const [timeEntryReasonBusy, setTimeEntryReasonBusy] = useState(false);
  const [editingTimeEntryReasonId, setEditingTimeEntryReasonId] = useState<string | null>(null);
  const [editTimeEntryReasonName, setEditTimeEntryReasonName] = useState("");
  const [draggedTimeEntryReasonId, setDraggedTimeEntryReasonId] = useState<string | null>(null);
  const [draggedProjectCategoryId, setDraggedProjectCategoryId] = useState<string | null>(null);

  // Global historical-locking switch (Sandra, 2026-08-14): "we're still
  // playing around with the system" -- while off, Utilization/Day Planner
  // ignore ownership/assignee history and just use each project/task's
  // current owner_id/assignee_id, same as before that feature existed.
  // Moved here from Admin.tsx (2026-08-20 User Management redesign) --
  // this is a site-wide setting, not a per-user one, so it belongs on
  // this page instead of cluttering User Management.
  const [historicalLockingEnabled, setHistoricalLockingEnabled] = useState(false);
  const [historicalLockingSaving, setHistoricalLockingSaving] = useState(false);

  async function loadHistoricalLocking() {
    const { data } = await supabase.from("app_settings").select("historical_locking_enabled").eq("id", true).single();
    setHistoricalLockingEnabled((data as { historical_locking_enabled?: boolean } | null)?.historical_locking_enabled ?? false);
  }

  async function toggleHistoricalLocking() {
    const next = !historicalLockingEnabled;
    setHistoricalLockingSaving(true);
    const { error } = await supabase.from("app_settings").update({ historical_locking_enabled: next }).eq("id", true);
    setHistoricalLockingSaving(false);
    if (error) {
      window.alert(`Couldn't save: ${error.message}`);
      return;
    }
    setHistoricalLockingEnabled(next);
  }

  async function loadWorkTypes() {
    setWorkTypesLoading(true);
    const { data } = await supabase.from("work_types").select("id,name,sort_order,is_active,is_fixed_schedule").order("sort_order");
    setWorkTypes((data as WorkTypeRow[]) ?? []);
    setWorkTypesLoading(false);
  }

  async function addWorkType() {
    const name = newWorkTypeName.trim();
    if (!name) return;
    setWorkTypeBusy(true);
    const nextSortOrder = workTypes.length > 0 ? Math.max(...workTypes.map((w) => w.sort_order)) + 1 : 1;
    const { error } = await supabase.from("work_types").insert({ name, sort_order: nextSortOrder });
    setWorkTypeBusy(false);
    if (error) {
      window.alert(`Couldn't add: ${error.message}`);
      return;
    }
    setNewWorkTypeName("");
    loadWorkTypes();
  }

  function startEditWorkType(w: WorkTypeRow) {
    setEditingWorkTypeId(w.id);
    setEditWorkTypeName(w.name);
  }

  async function saveWorkTypeRename(id: string) {
    const name = editWorkTypeName.trim();
    if (!name) return;
    const current = workTypes.find((w) => w.id === id);
    if (current && !confirmFkRename(current.name, name, "task")) {
      setEditingWorkTypeId(null);
      return;
    }
    setWorkTypeBusy(true);
    const { error } = await supabase.from("work_types").update({ name }).eq("id", id);
    setWorkTypeBusy(false);
    if (error) {
      window.alert(`Couldn't rename: ${error.message}`);
      return;
    }
    setEditingWorkTypeId(null);
    loadWorkTypes();
  }

  async function toggleWorkTypeActive(w: WorkTypeRow) {
    setWorkTypeBusy(true);
    const { error } = await supabase.from("work_types").update({ is_active: !w.is_active }).eq("id", w.id);
    setWorkTypeBusy(false);
    if (error) {
      window.alert(`Couldn't update: ${error.message}`);
      return;
    }
    loadWorkTypes();
  }

  // Phase 3 (2026-08-21, quality-audit follow-on): Fixed-Schedule work
  // types (Training Delivery is the concrete case) don't defer their
  // hours to the next day when the assignee is already busy -- they land
  // on their own scheduled day(s) exactly like Full Effort assumes, so
  // Utilization/Day Planner can honestly show over 100% instead of
  // quietly smoothing the overflow into tomorrow. See
  // capacityScheduler.ts's fixedQueue pass for the scheduling-side half
  // of this.
  async function toggleWorkTypeFixedSchedule(w: WorkTypeRow) {
    setWorkTypeBusy(true);
    const { error } = await supabase.from("work_types").update({ is_fixed_schedule: !w.is_fixed_schedule }).eq("id", w.id);
    setWorkTypeBusy(false);
    if (error) {
      window.alert(`Couldn't update: ${error.message}`);
      return;
    }
    loadWorkTypes();
  }

  // Swaps this row's sort_order with its immediate neighbor (up or down)
  // in the currently-loaded, already sort_order-ordered list.
  async function moveWorkType(w: WorkTypeRow, direction: "up" | "down") {
    const idx = workTypes.findIndex((x) => x.id === w.id);
    const neighborIdx = direction === "up" ? idx - 1 : idx + 1;
    if (idx === -1 || neighborIdx < 0 || neighborIdx >= workTypes.length) return;
    const neighbor = workTypes[neighborIdx];
    setWorkTypeBusy(true);
    const [{ error: e1 }, { error: e2 }] = await Promise.all([
      supabase.from("work_types").update({ sort_order: neighbor.sort_order }).eq("id", w.id),
      supabase.from("work_types").update({ sort_order: w.sort_order }).eq("id", neighbor.id),
    ]);
    setWorkTypeBusy(false);
    if (e1 || e2) {
      window.alert(`Couldn't reorder: ${(e1 ?? e2)?.message}`);
      return;
    }
    loadWorkTypes();
  }

  // Delete (2026-08-20 round): only allowed when no task currently
  // references this Work Type. We check client-side first (cheap, gives
  // a friendly message with the actual count) -- the DB itself is also a
  // backstop: tasks.work_type_id's FK to work_types is default NO ACTION
  // (not CASCADE/SET NULL), so even a delete that raced past this check
  // against a concurrent insert would still be rejected by Postgres with
  // a raw FK-violation error rather than silently orphaning/blanking any
  // task. See supabase/phase12_migration_2.sql for the delete RLS policy
  // this needs (work_types had no delete policy until now -- see
  // [[feedback_supabase_rls_silent_delete_noop]], a delete with no
  // policy silently no-ops instead of erroring, which is why the count
  // check below is the primary UX path rather than relying on catching
  // an RLS failure).
  async function deleteWorkType(w: WorkTypeRow) {
    setWorkTypeBusy(true);
    const { count, error: countError } = await supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("work_type_id", w.id);
    if (countError) {
      setWorkTypeBusy(false);
      window.alert(`Couldn't check usage: ${countError.message}`);
      return;
    }
    if ((count ?? 0) > 0) {
      setWorkTypeBusy(false);
      window.alert(
        `Can't delete -- ${count} task${count === 1 ? "" : "s"} still use this Work Type. Deactivate it instead, or reassign those tasks first.`
      );
      return;
    }
    if (!window.confirm(`Delete "${w.name}"? This can't be undone. (Only possible because no task currently uses it -- Work Types in use can't be deleted.)`)) {
      setWorkTypeBusy(false);
      return;
    }
    const { error } = await supabase.from("work_types").delete().eq("id", w.id);
    setWorkTypeBusy(false);
    if (error) {
      window.alert(`Couldn't delete: ${error.message}`);
      return;
    }
    loadWorkTypes();
  }

  async function loadProjectSources() {
    setProjectSourcesLoading(true);
    const { data } = await supabase.from("project_sources").select("id,name,sort_order,is_active").order("sort_order");
    setProjectSources((data as ProjectSourceRow[]) ?? []);
    setProjectSourcesLoading(false);
  }

  async function addProjectSource() {
    const name = newProjectSourceName.trim();
    if (!name) return;
    setProjectSourceBusy(true);
    const nextSortOrder = projectSources.length > 0 ? Math.max(...projectSources.map((s) => s.sort_order)) + 1 : 1;
    const { error } = await supabase.from("project_sources").insert({ name, sort_order: nextSortOrder });
    setProjectSourceBusy(false);
    if (error) {
      window.alert(`Couldn't add: ${error.message}`);
      return;
    }
    setNewProjectSourceName("");
    loadProjectSources();
  }

  function startEditProjectSource(s: ProjectSourceRow) {
    setEditingProjectSourceId(s.id);
    setEditProjectSourceName(s.name);
  }

  async function saveProjectSourceRename(id: string) {
    const name = editProjectSourceName.trim();
    if (!name) return;
    const current = projectSources.find((s) => s.id === id);
    if (current && !confirmFkRename(current.name, name, "project")) {
      setEditingProjectSourceId(null);
      return;
    }
    setProjectSourceBusy(true);
    const { error } = await supabase.from("project_sources").update({ name }).eq("id", id);
    setProjectSourceBusy(false);
    if (error) {
      window.alert(`Couldn't rename: ${error.message}`);
      return;
    }
    setEditingProjectSourceId(null);
    loadProjectSources();
  }

  async function toggleProjectSourceActive(s: ProjectSourceRow) {
    setProjectSourceBusy(true);
    const { error } = await supabase.from("project_sources").update({ is_active: !s.is_active }).eq("id", s.id);
    setProjectSourceBusy(false);
    if (error) {
      window.alert(`Couldn't update: ${error.message}`);
      return;
    }
    loadProjectSources();
  }

  async function moveProjectSource(s: ProjectSourceRow, direction: "up" | "down") {
    const idx = projectSources.findIndex((x) => x.id === s.id);
    const neighborIdx = direction === "up" ? idx - 1 : idx + 1;
    if (idx === -1 || neighborIdx < 0 || neighborIdx >= projectSources.length) return;
    const neighbor = projectSources[neighborIdx];
    setProjectSourceBusy(true);
    const [{ error: e1 }, { error: e2 }] = await Promise.all([
      supabase.from("project_sources").update({ sort_order: neighbor.sort_order }).eq("id", s.id),
      supabase.from("project_sources").update({ sort_order: s.sort_order }).eq("id", neighbor.id),
    ]);
    setProjectSourceBusy(false);
    if (e1 || e2) {
      window.alert(`Couldn't reorder: ${(e1 ?? e2)?.message}`);
      return;
    }
    loadProjectSources();
  }

  // Delete: only allowed when no project currently references this
  // Source, same convention/reasoning as deleteWorkType above.
  async function deleteProjectSource(s: ProjectSourceRow) {
    setProjectSourceBusy(true);
    const { count, error: countError } = await supabase
      .from("projects")
      .select("id", { count: "exact", head: true })
      .eq("source_id", s.id);
    if (countError) {
      setProjectSourceBusy(false);
      window.alert(`Couldn't check usage: ${countError.message}`);
      return;
    }
    if ((count ?? 0) > 0) {
      setProjectSourceBusy(false);
      window.alert(
        `Can't delete -- ${count} project${count === 1 ? "" : "s"} still use this Source. Deactivate it instead, or reassign those projects first.`
      );
      return;
    }
    if (!window.confirm(`Delete "${s.name}"? This can't be undone. (Only possible because no project currently uses it -- Sources in use can't be deleted.)`)) {
      setProjectSourceBusy(false);
      return;
    }
    const { error } = await supabase.from("project_sources").delete().eq("id", s.id);
    setProjectSourceBusy(false);
    if (error) {
      window.alert(`Couldn't delete: ${error.message}`);
      return;
    }
    loadProjectSources();
  }


  async function loadProjectCategories() {
    setProjectCategoriesLoading(true);
    const { data } = await supabase.from("project_categories").select("id,name,sort_order,is_active,icon,color").order("sort_order");
    setProjectCategories((data as ProjectCategoryRow[]) ?? []);
    setProjectCategoriesLoading(false);
  }

  // Self-service icon/color picker (Phase 36, 2026-09-03) -- Sandra:
  // "let's do self service" after asking why a new category defaulted to
  // a generic folder icon. Picker grid lives inline in the drawer below;
  // this just persists whichever CATEGORY_ICON_LIBRARY/CATEGORY_TONE_NAMES
  // key she picked.
  async function updateProjectCategoryIcon(c: ProjectCategoryRow, icon: string) {
    setProjectCategoryBusy(true);
    const { error } = await supabase.from("project_categories").update({ icon }).eq("id", c.id);
    setProjectCategoryBusy(false);
    if (error) {
      window.alert(`Couldn't update icon: ${error.message}`);
      return;
    }
    loadProjectCategories();
  }

  async function updateProjectCategoryColor(c: ProjectCategoryRow, color: string) {
    setProjectCategoryBusy(true);
    const { error } = await supabase.from("project_categories").update({ color }).eq("id", c.id);
    setProjectCategoryBusy(false);
    if (error) {
      window.alert(`Couldn't update color: ${error.message}`);
      return;
    }
    loadProjectCategories();
  }

  async function addProjectCategory() {
    const name = newProjectCategoryName.trim();
    if (!name) return;
    setProjectCategoryBusy(true);
    const nextSortOrder = projectCategories.length > 0 ? Math.max(...projectCategories.map((c) => c.sort_order)) + 1 : 1;
    const { error } = await supabase.from("project_categories").insert({ name, sort_order: nextSortOrder });
    setProjectCategoryBusy(false);
    if (error) {
      window.alert(`Couldn't add: ${error.message}`);
      return;
    }
    setNewProjectCategoryName("");
    loadProjectCategories();
  }

  function startEditProjectCategory(c: ProjectCategoryRow) {
    setEditingProjectCategoryId(c.id);
    setEditProjectCategoryName(c.name);
  }

  async function saveProjectCategoryRename(id: string) {
    const name = editProjectCategoryName.trim();
    if (!name) return;
    const current = projectCategories.find((c) => c.id === id);
    if (current && current.name !== name) {
      const ok = await confirmPlainTextRename("projects", "category", current.name, name, "project");
      if (!ok) {
        setEditingProjectCategoryId(null);
        return;
      }
    }
    setProjectCategoryBusy(true);
    const { error } = await supabase.from("project_categories").update({ name }).eq("id", id);
    if (error) {
      setProjectCategoryBusy(false);
      window.alert(`Couldn't rename: ${error.message}`);
      return;
    }
    if (current && current.name !== name) {
      const cascadeError = await cascadePlainTextRename("projects", "category", current.name, name);
      if (cascadeError) window.alert(`Category renamed, but couldn't update tagged projects: ${cascadeError}. Please check manually.`);
    }
    setProjectCategoryBusy(false);
    setEditingProjectCategoryId(null);
    loadProjectCategories();
  }

  async function toggleProjectCategoryActive(c: ProjectCategoryRow) {
    setProjectCategoryBusy(true);
    const { error } = await supabase.from("project_categories").update({ is_active: !c.is_active }).eq("id", c.id);
    setProjectCategoryBusy(false);
    if (error) {
      window.alert(`Couldn't update: ${error.message}`);
      return;
    }
    loadProjectCategories();
  }

  // Delete: only allowed when no project currently references this
  // Category by name (category is plain text, not a category_id FK --
  // see ProjectCategoryRow above), same usage-check convention as
  // deleteProjectSource/deleteWorkType.
  async function deleteProjectCategory(c: ProjectCategoryRow) {
    setProjectCategoryBusy(true);
    const { count, error: countError } = await supabase
      .from("projects")
      .select("id", { count: "exact", head: true })
      .eq("category", c.name);
    if (countError) {
      setProjectCategoryBusy(false);
      window.alert(`Couldn't check usage: ${countError.message}`);
      return;
    }
    if ((count ?? 0) > 0) {
      setProjectCategoryBusy(false);
      window.alert(
        `Can't delete -- ${count} project${count === 1 ? "" : "s"} still use this Category. Deactivate it instead, or reassign those projects first.`
      );
      return;
    }
    if (!window.confirm(`Delete "${c.name}"? This can't be undone. (Only possible because no project currently uses it -- Categories in use can't be deleted.)`)) {
      setProjectCategoryBusy(false);
      return;
    }
    const { error } = await supabase.from("project_categories").delete().eq("id", c.id);
    setProjectCategoryBusy(false);
    if (error) {
      window.alert(`Couldn't delete: ${error.message}`);
      return;
    }
    loadProjectCategories();
  }


  async function loadProjectPhases() {
    setProjectPhasesLoading(true);
    const { data } = await supabase.from("project_phases").select("id,name,sort_order,is_active").order("sort_order");
    setProjectPhases((data as ProjectPhaseRow[]) ?? []);
    setProjectPhasesLoading(false);
  }

  async function addProjectPhase() {
    const name = newProjectPhaseName.trim();
    if (!name) return;
    setProjectPhaseBusy(true);
    const nextSortOrder = projectPhases.length > 0 ? Math.max(...projectPhases.map((ph) => ph.sort_order)) + 1 : 1;
    const { error } = await supabase.from("project_phases").insert({ name, sort_order: nextSortOrder });
    setProjectPhaseBusy(false);
    if (error) {
      window.alert(`Couldn't add: ${error.message}`);
      return;
    }
    setNewProjectPhaseName("");
    loadProjectPhases();
  }

  function startEditProjectPhase(ph: ProjectPhaseRow) {
    setEditingProjectPhaseId(ph.id);
    setEditProjectPhaseName(ph.name);
  }

  async function saveProjectPhaseRename(id: string) {
    const name = editProjectPhaseName.trim();
    if (!name) return;
    const current = projectPhases.find((ph) => ph.id === id);
    if (current && current.name !== name) {
      const ok = await confirmPlainTextRename("projects", "phase", current.name, name, "project");
      if (!ok) {
        setEditingProjectPhaseId(null);
        return;
      }
    }
    setProjectPhaseBusy(true);
    const { error } = await supabase.from("project_phases").update({ name }).eq("id", id);
    if (error) {
      setProjectPhaseBusy(false);
      window.alert(`Couldn't rename: ${error.message}`);
      return;
    }
    if (current && current.name !== name) {
      const cascadeError = await cascadePlainTextRename("projects", "phase", current.name, name);
      if (cascadeError) window.alert(`Phase renamed, but couldn't update tagged projects: ${cascadeError}. Please check manually.`);
    }
    setProjectPhaseBusy(false);
    setEditingProjectPhaseId(null);
    loadProjectPhases();
  }

  async function toggleProjectPhaseActive(ph: ProjectPhaseRow) {
    setProjectPhaseBusy(true);
    const { error } = await supabase.from("project_phases").update({ is_active: !ph.is_active }).eq("id", ph.id);
    setProjectPhaseBusy(false);
    if (error) {
      window.alert(`Couldn't update: ${error.message}`);
      return;
    }
    loadProjectPhases();
  }

  // Delete: only allowed when no project currently references this Phase
  // by name (phase is plain text, same convention as Category).
  async function deleteProjectPhase(ph: ProjectPhaseRow) {
    setProjectPhaseBusy(true);
    const { count, error: countError } = await supabase
      .from("projects")
      .select("id", { count: "exact", head: true })
      .eq("phase", ph.name);
    if (countError) {
      setProjectPhaseBusy(false);
      window.alert(`Couldn't check usage: ${countError.message}`);
      return;
    }
    if ((count ?? 0) > 0) {
      setProjectPhaseBusy(false);
      window.alert(
        `Can't delete -- ${count} project${count === 1 ? "" : "s"} still use this Phase. Deactivate it instead, or reassign those projects first.`
      );
      return;
    }
    if (!window.confirm(`Delete "${ph.name}"? This can't be undone. (Only possible because no project currently uses it -- Phases in use can't be deleted.)`)) {
      setProjectPhaseBusy(false);
      return;
    }
    const { error } = await supabase.from("project_phases").delete().eq("id", ph.id);
    setProjectPhaseBusy(false);
    if (error) {
      window.alert(`Couldn't delete: ${error.message}`);
      return;
    }
    loadProjectPhases();
  }

  async function reorderProjectPhases(orderedIds: string[]) {
    setProjectPhaseBusy(true);
    const results = await Promise.all(
      orderedIds.map((id, idx) => supabase.from("project_phases").update({ sort_order: idx + 1 }).eq("id", id))
    );
    setProjectPhaseBusy(false);
    const err = results.find((r) => r.error)?.error;
    if (err) {
      window.alert(`Couldn't reorder: ${err.message}`);
      return;
    }
    loadProjectPhases();
  }

  async function loadPhaseStatusMapping() {
    const { data } = await supabase.from("project_status_phase_mapping").select("status,phase_id");
    setPhaseStatusMapping((data as { status: string; phase_id: string }[]) ?? []);
  }

  // Toggle one Status <-> Phase pairing -- same toggle-by-existence
  // pattern as toggleMapping (Task Type <-> Output Type) above.
  async function togglePhaseStatusMapping(status: string, phaseId: string) {
    const exists = phaseStatusMapping.some((m) => m.status === status && m.phase_id === phaseId);
    setPhaseMappingBusy(true);
    const { error } = exists
      ? await supabase.from("project_status_phase_mapping").delete().eq("status", status).eq("phase_id", phaseId)
      : await supabase.from("project_status_phase_mapping").insert({ status, phase_id: phaseId });
    setPhaseMappingBusy(false);
    if (error) {
      window.alert(`Couldn't update mapping: ${error.message}`);
      return;
    }
    loadPhaseStatusMapping();
  }

  async function loadOutputTypes() {
    setOutputTypesLoading(true);
    const { data } = await supabase.from("output_types").select("id,name,sort_order,is_active").order("sort_order");
    setOutputTypes((data as OutputTypeRow[]) ?? []);
    setOutputTypesLoading(false);
  }

  async function addOutputType() {
    const name = newOutputTypeName.trim();
    if (!name) return;
    setOutputTypeBusy(true);
    const nextSortOrder = outputTypes.length > 0 ? Math.max(...outputTypes.map((o) => o.sort_order)) + 1 : 1;
    const { error } = await supabase.from("output_types").insert({ name, sort_order: nextSortOrder });
    setOutputTypeBusy(false);
    if (error) {
      window.alert(`Couldn't add: ${error.message}`);
      return;
    }
    setNewOutputTypeName("");
    loadOutputTypes();
  }

  function startEditOutputType(o: OutputTypeRow) {
    setEditingOutputTypeId(o.id);
    setEditOutputTypeName(o.name);
  }

  async function saveOutputTypeRename(id: string) {
    const name = editOutputTypeName.trim();
    if (!name) return;
    const current = outputTypes.find((o) => o.id === id);
    if (current && !confirmFkRename(current.name, name, "task")) {
      setEditingOutputTypeId(null);
      return;
    }
    setOutputTypeBusy(true);
    const { error } = await supabase.from("output_types").update({ name }).eq("id", id);
    setOutputTypeBusy(false);
    if (error) {
      window.alert(`Couldn't rename: ${error.message}`);
      return;
    }
    setEditingOutputTypeId(null);
    loadOutputTypes();
  }

  async function toggleOutputTypeActive(o: OutputTypeRow) {
    setOutputTypeBusy(true);
    const { error } = await supabase.from("output_types").update({ is_active: !o.is_active }).eq("id", o.id);
    setOutputTypeBusy(false);
    if (error) {
      window.alert(`Couldn't update: ${error.message}`);
      return;
    }
    loadOutputTypes();
  }

  async function moveOutputType(o: OutputTypeRow, direction: "up" | "down") {
    const idx = outputTypes.findIndex((x) => x.id === o.id);
    const neighborIdx = direction === "up" ? idx - 1 : idx + 1;
    if (idx === -1 || neighborIdx < 0 || neighborIdx >= outputTypes.length) return;
    const neighbor = outputTypes[neighborIdx];
    setOutputTypeBusy(true);
    const [{ error: e1 }, { error: e2 }] = await Promise.all([
      supabase.from("output_types").update({ sort_order: neighbor.sort_order }).eq("id", o.id),
      supabase.from("output_types").update({ sort_order: o.sort_order }).eq("id", neighbor.id),
    ]);
    setOutputTypeBusy(false);
    if (e1 || e2) {
      window.alert(`Couldn't reorder: ${(e1 ?? e2)?.message}`);
      return;
    }
    loadOutputTypes();
  }

  // Delete: only allowed when no task currently references this Output
  // Type, same convention/reasoning as deleteWorkType/deleteProjectSource.
  async function deleteOutputType(o: OutputTypeRow) {
    setOutputTypeBusy(true);
    const { count, error: countError } = await supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("output_type_id", o.id);
    if (countError) {
      setOutputTypeBusy(false);
      window.alert(`Couldn't check usage: ${countError.message}`);
      return;
    }
    if ((count ?? 0) > 0) {
      setOutputTypeBusy(false);
      window.alert(
        `Can't delete -- ${count} task${count === 1 ? "" : "s"} still use this Output Type. Deactivate it instead, or reassign those tasks first.`
      );
      return;
    }
    if (!window.confirm(`Delete "${o.name}"? This can't be undone. (Only possible because no task currently uses it -- Output Types in use can't be deleted.)`)) {
      setOutputTypeBusy(false);
      return;
    }
    const { error } = await supabase.from("output_types").delete().eq("id", o.id);
    setOutputTypeBusy(false);
    if (error) {
      window.alert(`Couldn't delete: ${error.message}`);
      return;
    }
    loadOutputTypes();
  }

  async function loadMappings() {
    const { data } = await supabase.from("work_type_output_types").select("work_type_id,output_type_id");
    setMappings((data as { work_type_id: string; output_type_id: string }[]) ?? []);
  }

  // Toggle one Task Type <-> Output Type pairing. Edited from either
  // panel is unnecessary -- Sandra picked the Task Type panel as the one
  // source of truth -- but the helper itself is symmetric so it doesn't
  // care which side called it.
  async function toggleMapping(workTypeId: string, outputTypeId: string) {
    const exists = mappings.some((m) => m.work_type_id === workTypeId && m.output_type_id === outputTypeId);
    setMappingBusy(true);
    const { error } = exists
      ? await supabase.from("work_type_output_types").delete().eq("work_type_id", workTypeId).eq("output_type_id", outputTypeId)
      : await supabase.from("work_type_output_types").insert({ work_type_id: workTypeId, output_type_id: outputTypeId });
    setMappingBusy(false);
    if (error) {
      window.alert(`Couldn't update mapping: ${error.message}`);
      return;
    }
    loadMappings();
  }

  // Drag-handle reorder (Phase 23, replaces the old up/down arrow
  // stepper -- Sandra: "let's use drag handles instead of the arrows for
  // easier organization"). Re-sequences ALL rows to 1..N in the dropped
  // order, same grip-handle affordance as ViewSettingsMenu's sort list.
  async function reorderWorkTypes(orderedIds: string[]) {
    setWorkTypeBusy(true);
    const results = await Promise.all(
      orderedIds.map((id, idx) => supabase.from("work_types").update({ sort_order: idx + 1 }).eq("id", id))
    );
    setWorkTypeBusy(false);
    const err = results.find((r) => r.error)?.error;
    if (err) {
      window.alert(`Couldn't reorder: ${err.message}`);
      return;
    }
    loadWorkTypes();
  }

  async function reorderOutputTypes(orderedIds: string[]) {
    setOutputTypeBusy(true);
    const results = await Promise.all(
      orderedIds.map((id, idx) => supabase.from("output_types").update({ sort_order: idx + 1 }).eq("id", id))
    );
    setOutputTypeBusy(false);
    const err = results.find((r) => r.error)?.error;
    if (err) {
      window.alert(`Couldn't reorder: ${err.message}`);
      return;
    }
    loadOutputTypes();
  }

  // Same drag-handle reorder as Work Types/Output Types above -- Project
  // Sources moved into the same "Manage List" drawer treatment, so it
  // gets the same reorder affordance instead of staying the odd one out.
  async function reorderProjectSources(orderedIds: string[]) {
    setProjectSourceBusy(true);
    const results = await Promise.all(
      orderedIds.map((id, idx) => supabase.from("project_sources").update({ sort_order: idx + 1 }).eq("id", id))
    );
    setProjectSourceBusy(false);
    const err = results.find((r) => r.error)?.error;
    if (err) {
      window.alert(`Couldn't reorder: ${err.message}`);
      return;
    }
    loadProjectSources();
  }

  // Time Logging Reasons (Phase 37, 2026-09-03) -- full CRUD set, same
  // shape as Project Sources above, except rename cascades into
  // time_entries.reason_category (plain text, not a reason_id FK -- see
  // TimeEntryReasonRow's comment).
  async function loadTimeEntryReasons() {
    setTimeEntryReasonsLoading(true);
    const { data } = await supabase.from("time_entry_reasons").select("id,name,sort_order,is_active").order("sort_order");
    setTimeEntryReasons((data as TimeEntryReasonRow[]) ?? []);
    setTimeEntryReasonsLoading(false);
  }

  async function addTimeEntryReason() {
    const name = newTimeEntryReasonName.trim();
    if (!name) return;
    setTimeEntryReasonBusy(true);
    const nextSortOrder = timeEntryReasons.length > 0 ? Math.max(...timeEntryReasons.map((r) => r.sort_order)) + 1 : 1;
    const { error } = await supabase.from("time_entry_reasons").insert({ name, sort_order: nextSortOrder });
    setTimeEntryReasonBusy(false);
    if (error) {
      window.alert(`Couldn't add: ${error.message}`);
      return;
    }
    setNewTimeEntryReasonName("");
    loadTimeEntryReasons();
  }

  function startEditTimeEntryReason(r: TimeEntryReasonRow) {
    setEditingTimeEntryReasonId(r.id);
    setEditTimeEntryReasonName(r.name);
  }

  async function saveTimeEntryReasonRename(id: string) {
    const name = editTimeEntryReasonName.trim();
    if (!name) return;
    const current = timeEntryReasons.find((r) => r.id === id);
    if (current && current.name !== name) {
      const ok = await confirmPlainTextRename("time_entries", "reason_category", current.name, name, "time entry");
      if (!ok) {
        setEditingTimeEntryReasonId(null);
        return;
      }
    }
    setTimeEntryReasonBusy(true);
    const { error } = await supabase.from("time_entry_reasons").update({ name }).eq("id", id);
    if (error) {
      setTimeEntryReasonBusy(false);
      window.alert(`Couldn't rename: ${error.message}`);
      return;
    }
    if (current && current.name !== name) {
      const cascadeError = await cascadePlainTextRename("time_entries", "reason_category", current.name, name);
      if (cascadeError) window.alert(`Reason renamed, but couldn't update tagged time entries: ${cascadeError}. Please check manually.`);
    }
    setTimeEntryReasonBusy(false);
    setEditingTimeEntryReasonId(null);
    loadTimeEntryReasons();
  }

  async function toggleTimeEntryReasonActive(r: TimeEntryReasonRow) {
    setTimeEntryReasonBusy(true);
    const { error } = await supabase.from("time_entry_reasons").update({ is_active: !r.is_active }).eq("id", r.id);
    setTimeEntryReasonBusy(false);
    if (error) {
      window.alert(`Couldn't update: ${error.message}`);
      return;
    }
    loadTimeEntryReasons();
  }

  // Delete: only allowed when no time entry currently references this
  // Reason by name (plain text, same convention as Category/Phase).
  async function deleteTimeEntryReason(r: TimeEntryReasonRow) {
    setTimeEntryReasonBusy(true);
    const { count, error: countError } = await supabase
      .from("time_entries")
      .select("id", { count: "exact", head: true })
      .eq("reason_category", r.name);
    if (countError) {
      setTimeEntryReasonBusy(false);
      window.alert(`Couldn't check usage: ${countError.message}`);
      return;
    }
    if ((count ?? 0) > 0) {
      setTimeEntryReasonBusy(false);
      window.alert(
        `Can't delete -- ${count} time ${count === 1 ? "entry" : "entries"} still use this Reason. Deactivate it instead.`
      );
      return;
    }
    if (!window.confirm(`Delete "${r.name}"? This can't be undone. (Only possible because no time entry currently uses it -- Reasons in use can't be deleted.)`)) {
      setTimeEntryReasonBusy(false);
      return;
    }
    const { error } = await supabase.from("time_entry_reasons").delete().eq("id", r.id);
    setTimeEntryReasonBusy(false);
    if (error) {
      window.alert(`Couldn't delete: ${error.message}`);
      return;
    }
    loadTimeEntryReasons();
  }

  async function reorderTimeEntryReasons(orderedIds: string[]) {
    setTimeEntryReasonBusy(true);
    const results = await Promise.all(
      orderedIds.map((id, idx) => supabase.from("time_entry_reasons").update({ sort_order: idx + 1 }).eq("id", id))
    );
    setTimeEntryReasonBusy(false);
    const err = results.find((r) => r.error)?.error;
    if (err) {
      window.alert(`Couldn't reorder: ${err.message}`);
      return;
    }
    loadTimeEntryReasons();
  }

  // Same drag-handle reorder as Project Sources above.
  async function reorderProjectCategories(orderedIds: string[]) {
    setProjectCategoryBusy(true);
    const results = await Promise.all(
      orderedIds.map((id, idx) => supabase.from("project_categories").update({ sort_order: idx + 1 }).eq("id", id))
    );
    setProjectCategoryBusy(false);
    const err = results.find((r) => r.error)?.error;
    if (err) {
      window.alert(`Couldn't reorder: ${err.message}`);
      return;
    }
    loadProjectCategories();
  }

  function listSummary(items: { is_active: boolean }[]): string {
    const active = items.filter((i) => i.is_active).length;
    const inactive = items.length - active;
    return inactive > 0 ? `${active} active \u00b7 ${inactive} inactive` : `${active} active`;
  }

  useEffect(() => {
    if (me?.access_level === "full") {
      loadWorkTypes();
      loadProjectSources();
      loadProjectCategories();
      loadProjectPhases();
      loadPhaseStatusMapping();
      loadOutputTypes();
      loadMappings();
      loadHistoricalLocking();
      loadTimeEntryReasons();
    }
  }, [me?.access_level]);

  if (sessionLoading) return null;
  if (!me || me.access_level !== "full") return <AccessDenied />;

  return (
    <div>
      <div>
        <h1>Site settings</h1>
        <p className="subtitle">Full Access only. Configure options shared across the whole app.</p>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>Lists</div>
          <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
            Dropdown options used across Projects, Tasks, and WBS Planning.
          </div>
        </div>
        <table className="data-table" style={{ width: "100%" }}>
          <thead>
            <tr>
              <th>List</th>
              <th style={{ width: 150 }}>Items</th>
              <th style={{ width: 120 }} />
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <div style={{ fontWeight: 600, color: "var(--navy)", fontSize: 12.5 }}>Project Sources</div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
                  How/why a project originated. Offered on every project and the Portfolio Dashboard's Source filter.
                </div>
              </td>
              <td style={{ fontSize: 12, color: "var(--text-secondary)" }}>{projectSourcesLoading ? "…" : listSummary(projectSources)}</td>
              <td>
                <button onClick={() => setManageDrawer("sources")} style={manageButtonStyle}>
                  Manage List
                </button>
              </td>
            </tr>
            <tr>
              <td>
                <div style={{ fontWeight: 600, color: "var(--navy)", fontSize: 12.5 }}>Project Categories</div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
                  What kind of training a project is. Offered on every project's Category field.
                </div>
              </td>
              <td style={{ fontSize: 12, color: "var(--text-secondary)" }}>{projectCategoriesLoading ? "…" : listSummary(projectCategories)}</td>
              <td>
                <button onClick={() => setManageDrawer("categories")} style={manageButtonStyle}>
                  Manage List
                </button>
              </td>
            </tr>
            <tr>
              <td>
                <div style={{ fontWeight: 600, color: "var(--navy)", fontSize: 12.5 }}>Project Phases</div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
                  Pipeline stage. Offered on every project's Phase field and the Board's default (Phase) grouping.
                </div>
              </td>
              <td style={{ fontSize: 12, color: "var(--text-secondary)" }}>{projectPhasesLoading ? "…" : listSummary(projectPhases)}</td>
              <td>
                <button onClick={() => setManageDrawer("phases")} style={manageButtonStyle}>
                  Manage List
                </button>
              </td>
            </tr>
            <tr>
              <td>
                <div style={{ fontWeight: 600, color: "var(--navy)", fontSize: 12.5 }}>Status &rarr; Phase Mapping</div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
                  Which Phases are offered when a project's Status is Not Started or In Progress. (Completed is always
                  "Done"; Paused/Cancelled always offer every active Phase -- those three aren't editable here.)
                </div>
              </td>
              <td style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                {phaseStatusMapping.length} pairing{phaseStatusMapping.length === 1 ? "" : "s"}
              </td>
              <td>
                <button onClick={() => setManageDrawer("phase_mapping")} style={manageButtonStyle}>
                  Manage List
                </button>
              </td>
            </tr>
            <tr>
              <td>
                <div style={{ fontWeight: 600, color: "var(--navy)", fontSize: 12.5 }}>Task Types</div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
                  Offered on every task (Projects &amp; WBS Planning). Also sets which Output Types each Task Type allows.
                </div>
              </td>
              <td style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                {workTypesLoading ? "…" : listSummary(workTypes)}
                {!outputTypesLoading && <span style={{ color: "var(--muted)" }}> · {listSummary(outputTypes)} output types</span>}
              </td>
              <td>
                <button onClick={() => setManageDrawer("work_types")} style={manageButtonStyle}>
                  Manage List
                </button>
              </td>
            </tr>
            <tr>
              <td>
                <div style={{ fontWeight: 600, color: "var(--navy)", fontSize: 12.5 }}>Time Logging Reasons</div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
                  Offered when someone logs time manually (not needed for the Start/Stop timer). Required on every
                  manual entry.
                </div>
              </td>
              <td style={{ fontSize: 12, color: "var(--text-secondary)" }}>{timeEntryReasonsLoading ? "…" : listSummary(timeEntryReasons)}</td>
              <td>
                <button onClick={() => setManageDrawer("reasons")} style={manageButtonStyle}>
                  Manage List
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {manageDrawer && (
        <>
          <div onClick={() => setManageDrawer(null)} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.35)", zIndex: 40 }} />
          <div
            style={{
              position: "fixed",
              top: 0,
              right: 0,
              height: "100vh",
              width: manageDrawer === "work_types" || manageDrawer === "phase_mapping" ? "min(1120px, 94vw)" : 480,
              maxWidth: "94vw",
              background: "var(--surface, #fff)",
              boxShadow: "-8px 0 24px rgba(0,0,0,0.18)",
              zIndex: 41,
              display: "flex",
              flexDirection: "column",
              padding: 20,
              overflowY: "auto",
            }}
          >
            {manageDrawer === "sources" ? (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "var(--navy)" }}>Manage Project Sources</div>
                  <button onClick={() => setManageDrawer(null)} style={{ display: "flex", background: "none", border: "none", cursor: "pointer", color: "var(--muted)" }}>
                    <X size={16} />
                  </button>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 14 }}>
                  Drag the grip handle to reorder. Deactivating keeps a source's label on any project that already has it
                  set -- it just disappears from the picker on new projects.
                </div>

                <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                  <input
                    value={newProjectSourceName}
                    onChange={(e) => setNewProjectSourceName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addProjectSource();
                    }}
                    placeholder="New source name"
                    spellCheck={false}
                    autoComplete="off"
                    style={{ ...inputStyle, marginTop: 0, flex: 1 }}
                  />
                  <button onClick={addProjectSource} disabled={projectSourceBusy || !newProjectSourceName.trim()} style={addButtonStyle(!newProjectSourceName.trim())}>
                    <Plus size={14} />
                    Add
                  </button>
                </div>

                <div style={{ display: "flex", flexDirection: "column", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}>
                  {projectSourcesLoading && <div style={{ padding: 10, fontSize: 11.5, color: "var(--muted)" }}>Loading…</div>}
                  {!projectSourcesLoading && projectSources.length === 0 && (
                    <div style={{ padding: 10, fontSize: 11.5, color: "var(--muted)" }}>None yet.</div>
                  )}
                  {projectSources.map((s) => {
                    const isEditing = editingProjectSourceId === s.id;
                    const isDragging = draggedProjectSourceId === s.id;
                    return (
                      <div
                        key={s.id}
                        onDragOver={(e) => {
                          if (!draggedProjectSourceId || draggedProjectSourceId === s.id) return;
                          e.preventDefault();
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (!draggedProjectSourceId) return;
                          const ids = projectSources.map((x) => x.id);
                          const without = ids.filter((id) => id !== draggedProjectSourceId);
                          without.splice(without.indexOf(s.id), 0, draggedProjectSourceId);
                          setDraggedProjectSourceId(null);
                          reorderProjectSources(without);
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "7px 10px",
                          borderBottom: "1px solid var(--border)",
                          opacity: isDragging ? 0.4 : s.is_active ? 1 : 0.55,
                        }}
                      >
                        <span
                          draggable
                          onDragStart={() => setDraggedProjectSourceId(s.id)}
                          onDragEnd={() => setDraggedProjectSourceId(null)}
                          title="Drag to reorder"
                          style={{ display: "flex", cursor: "grab", color: "var(--text-secondary)", flexShrink: 0 }}
                        >
                          <GripVertical size={14} />
                        </span>
                        {isEditing ? (
                          <input
                            value={editProjectSourceName}
                            onChange={(e) => setEditProjectSourceName(e.target.value)}
                            onBlur={() => saveProjectSourceRename(s.id)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveProjectSourceRename(s.id);
                              if (e.key === "Escape") setEditingProjectSourceId(null);
                            }}
                            autoFocus
                            spellCheck={false}
                            autoComplete="off"
                            style={{ ...inputStyle, marginTop: 0, flex: 1, fontWeight: 600 }}
                          />
                        ) : (
                          <span
                            onClick={() => startEditProjectSource(s)}
                            title="Click to rename"
                            style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: "var(--navy)", cursor: "pointer" }}
                          >
                            {s.name}
                          </span>
                        )}
                        <span className={`status-pill ${s.is_active ? "success" : "neutral"}`} style={{ fontSize: 10 }}>
                          {s.is_active ? "Active" : "Off"}
                        </span>
                        <button onClick={() => toggleProjectSourceActive(s)} disabled={projectSourceBusy} title={s.is_active ? "Deactivate" : "Reactivate"} style={iconBtnStyle(s.is_active ? "var(--danger-text)" : "var(--success-text)")}>
                          {s.is_active ? <ShieldOff size={13} /> : <ShieldCheck size={13} />}
                        </button>
                        <button onClick={() => deleteProjectSource(s)} disabled={projectSourceBusy} title="Delete (only if unused)" style={iconBtnStyle("var(--danger-text)")}>
                          <Trash2 size={13} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : manageDrawer === "categories" ? (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "var(--navy)" }}>Manage Project Categories</div>
                  <button onClick={() => setManageDrawer(null)} style={{ display: "flex", background: "none", border: "none", cursor: "pointer", color: "var(--muted)" }}>
                    <X size={16} />
                  </button>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 14 }}>
                  Drag the grip handle to reorder. Click the icon swatch to change a category's icon and color.
                  Deactivating keeps a category's label on any project that already has it set -- it just disappears
                  from the picker on new projects.
                </div>

                <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                  <input
                    value={newProjectCategoryName}
                    onChange={(e) => setNewProjectCategoryName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addProjectCategory();
                    }}
                    placeholder="New category name"
                    spellCheck={false}
                    autoComplete="off"
                    style={{ ...inputStyle, marginTop: 0, flex: 1 }}
                  />
                  <button onClick={addProjectCategory} disabled={projectCategoryBusy || !newProjectCategoryName.trim()} style={addButtonStyle(!newProjectCategoryName.trim())}>
                    <Plus size={14} />
                    Add
                  </button>
                </div>

                <div style={{ display: "flex", flexDirection: "column", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}>
                  {projectCategoriesLoading && <div style={{ padding: 10, fontSize: 11.5, color: "var(--muted)" }}>Loading…</div>}
                  {!projectCategoriesLoading && projectCategories.length === 0 && (
                    <div style={{ padding: 10, fontSize: 11.5, color: "var(--muted)" }}>None yet.</div>
                  )}
                  {projectCategories.map((c) => {
                    const isEditing = editingProjectCategoryId === c.id;
                    const isDragging = draggedProjectCategoryId === c.id;
                    return (
                      <div
                        key={c.id}
                        onDragOver={(e) => {
                          if (!draggedProjectCategoryId || draggedProjectCategoryId === c.id) return;
                          e.preventDefault();
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (!draggedProjectCategoryId) return;
                          const ids = projectCategories.map((x) => x.id);
                          const without = ids.filter((id) => id !== draggedProjectCategoryId);
                          without.splice(without.indexOf(c.id), 0, draggedProjectCategoryId);
                          setDraggedProjectCategoryId(null);
                          reorderProjectCategories(without);
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "7px 10px",
                          borderBottom: "1px solid var(--border)",
                          opacity: isDragging ? 0.4 : c.is_active ? 1 : 0.55,
                          position: "relative",
                        }}
                      >
                        <span
                          draggable
                          onDragStart={() => setDraggedProjectCategoryId(c.id)}
                          onDragEnd={() => setDraggedProjectCategoryId(null)}
                          title="Drag to reorder"
                          style={{ display: "flex", cursor: "grab", color: "var(--text-secondary)", flexShrink: 0 }}
                        >
                          <GripVertical size={14} />
                        </span>
                        {(() => {
                          const SwatchIcon = CATEGORY_ICON_LIBRARY[c.icon] ?? CATEGORY_ICON_LIBRARY.Folder;
                          const swatchColor = CATEGORY_TONE_ICON_COLOR[c.color] ?? CATEGORY_TONE_ICON_COLOR.neutral;
                          return (
                            <button
                              onClick={() => setCategoryIconPickerId(categoryIconPickerId === c.id ? null : c.id)}
                              title="Change icon and color"
                              style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                width: 26,
                                height: 26,
                                borderRadius: "var(--radius-sm)",
                                border: "1px solid var(--border)",
                                background: "var(--bg-subtle, #f5f6f8)",
                                cursor: "pointer",
                                flexShrink: 0,
                              }}
                            >
                              <SwatchIcon size={14} color={swatchColor} />
                            </button>
                          );
                        })()}
                        {categoryIconPickerId === c.id && (
                          <div
                            style={{
                              position: "absolute",
                              top: 32,
                              left: 34,
                              zIndex: 20,
                              background: "var(--card-bg, #fff)",
                              border: "1px solid var(--border)",
                              borderRadius: "var(--radius-sm)",
                              boxShadow: "0 6px 20px rgba(0,0,0,0.14)",
                              padding: 10,
                              width: 260,
                            }}
                          >
                            <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.3 }}>
                              Icon
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 4, marginBottom: 10 }}>
                              {CATEGORY_ICON_NAMES.map((iconName) => {
                                const IconOption = CATEGORY_ICON_LIBRARY[iconName];
                                const selected = c.icon === iconName;
                                return (
                                  <button
                                    key={iconName}
                                    onClick={() => updateProjectCategoryIcon(c, iconName)}
                                    title={iconName}
                                    style={{
                                      display: "flex",
                                      alignItems: "center",
                                      justifyContent: "center",
                                      width: 30,
                                      height: 30,
                                      borderRadius: "var(--radius-sm)",
                                      border: selected ? "2px solid var(--accent)" : "1px solid var(--border)",
                                      background: "none",
                                      cursor: "pointer",
                                    }}
                                  >
                                    <IconOption size={14} color={CATEGORY_TONE_ICON_COLOR[c.color] ?? CATEGORY_TONE_ICON_COLOR.neutral} />
                                  </button>
                                );
                              })}
                            </div>
                            <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.3 }}>
                              Color
                            </div>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                              {CATEGORY_TONE_NAMES.map((toneName) => {
                                const selected = c.color === toneName;
                                return (
                                  <button
                                    key={toneName}
                                    onClick={() => updateProjectCategoryColor(c, toneName)}
                                    title={toneName}
                                    style={{
                                      width: 22,
                                      height: 22,
                                      borderRadius: "50%",
                                      border: selected ? "2px solid var(--navy)" : "1px solid var(--border)",
                                      background: CATEGORY_TONE_ICON_COLOR[toneName],
                                      cursor: "pointer",
                                      padding: 0,
                                    }}
                                  />
                                );
                              })}
                            </div>
                            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                              <button
                                onClick={() => setCategoryIconPickerId(null)}
                                style={{ fontSize: 11, color: "var(--accent)", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}
                              >
                                Done
                              </button>
                            </div>
                          </div>
                        )}
                        {isEditing ? (
                          <input
                            value={editProjectCategoryName}
                            onChange={(e) => setEditProjectCategoryName(e.target.value)}
                            onBlur={() => saveProjectCategoryRename(c.id)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveProjectCategoryRename(c.id);
                              if (e.key === "Escape") setEditingProjectCategoryId(null);
                            }}
                            autoFocus
                            spellCheck={false}
                            autoComplete="off"
                            style={{ ...inputStyle, marginTop: 0, flex: 1, fontWeight: 600 }}
                          />
                        ) : (
                          <span
                            onClick={() => startEditProjectCategory(c)}
                            title="Click to rename"
                            style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: "var(--navy)", cursor: "pointer" }}
                          >
                            {c.name}
                          </span>
                        )}
                        <span className={`status-pill ${c.is_active ? "success" : "neutral"}`} style={{ fontSize: 10 }}>
                          {c.is_active ? "Active" : "Off"}
                        </span>
                        <button onClick={() => toggleProjectCategoryActive(c)} disabled={projectCategoryBusy} title={c.is_active ? "Deactivate" : "Reactivate"} style={iconBtnStyle(c.is_active ? "var(--danger-text)" : "var(--success-text)")}>
                          {c.is_active ? <ShieldOff size={13} /> : <ShieldCheck size={13} />}
                        </button>
                        <button onClick={() => deleteProjectCategory(c)} disabled={projectCategoryBusy} title="Delete (only if unused)" style={iconBtnStyle("var(--danger-text)")}>
                          <Trash2 size={13} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : manageDrawer === "phases" ? (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "var(--navy)" }}>Manage Project Phases</div>
                  <button onClick={() => setManageDrawer(null)} style={{ display: "flex", background: "none", border: "none", cursor: "pointer", color: "var(--muted)" }}>
                    <X size={16} />
                  </button>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 14 }}>
                  Drag the grip handle to reorder. Deactivating keeps a phase's label on any project that already has
                  it set -- it just disappears from the picker on new selections. To control which of these show up
                  under Status "Not Started" vs "In Progress", use the "Status &rarr; Phase Mapping" list instead.
                </div>

                <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                  <input
                    value={newProjectPhaseName}
                    onChange={(e) => setNewProjectPhaseName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addProjectPhase();
                    }}
                    placeholder="New phase name"
                    spellCheck={false}
                    autoComplete="off"
                    style={{ ...inputStyle, marginTop: 0, flex: 1 }}
                  />
                  <button onClick={addProjectPhase} disabled={projectPhaseBusy || !newProjectPhaseName.trim()} style={addButtonStyle(!newProjectPhaseName.trim())}>
                    <Plus size={14} />
                    Add
                  </button>
                </div>

                <div style={{ display: "flex", flexDirection: "column", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}>
                  {projectPhasesLoading && <div style={{ padding: 10, fontSize: 11.5, color: "var(--muted)" }}>Loading…</div>}
                  {!projectPhasesLoading && projectPhases.length === 0 && (
                    <div style={{ padding: 10, fontSize: 11.5, color: "var(--muted)" }}>None yet.</div>
                  )}
                  {projectPhases.map((ph) => {
                    const isEditing = editingProjectPhaseId === ph.id;
                    const isDragging = draggedProjectPhaseId === ph.id;
                    return (
                      <div
                        key={ph.id}
                        onDragOver={(e) => {
                          if (!draggedProjectPhaseId || draggedProjectPhaseId === ph.id) return;
                          e.preventDefault();
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (!draggedProjectPhaseId) return;
                          const ids = projectPhases.map((x) => x.id);
                          const without = ids.filter((id) => id !== draggedProjectPhaseId);
                          without.splice(without.indexOf(ph.id), 0, draggedProjectPhaseId);
                          setDraggedProjectPhaseId(null);
                          reorderProjectPhases(without);
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "7px 10px",
                          borderBottom: "1px solid var(--border)",
                          opacity: isDragging ? 0.4 : ph.is_active ? 1 : 0.55,
                        }}
                      >
                        <span
                          draggable
                          onDragStart={() => setDraggedProjectPhaseId(ph.id)}
                          onDragEnd={() => setDraggedProjectPhaseId(null)}
                          title="Drag to reorder"
                          style={{ display: "flex", cursor: "grab", color: "var(--text-secondary)", flexShrink: 0 }}
                        >
                          <GripVertical size={14} />
                        </span>
                        {isEditing ? (
                          <input
                            value={editProjectPhaseName}
                            onChange={(e) => setEditProjectPhaseName(e.target.value)}
                            onBlur={() => saveProjectPhaseRename(ph.id)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveProjectPhaseRename(ph.id);
                              if (e.key === "Escape") setEditingProjectPhaseId(null);
                            }}
                            autoFocus
                            spellCheck={false}
                            autoComplete="off"
                            style={{ ...inputStyle, marginTop: 0, flex: 1, fontWeight: 600 }}
                          />
                        ) : (
                          <span
                            onClick={() => startEditProjectPhase(ph)}
                            title="Click to rename"
                            style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: "var(--navy)", cursor: "pointer" }}
                          >
                            {ph.name}
                          </span>
                        )}
                        <span className={`status-pill ${ph.is_active ? "success" : "neutral"}`} style={{ fontSize: 10 }}>
                          {ph.is_active ? "Active" : "Off"}
                        </span>
                        <button onClick={() => toggleProjectPhaseActive(ph)} disabled={projectPhaseBusy} title={ph.is_active ? "Deactivate" : "Reactivate"} style={iconBtnStyle(ph.is_active ? "var(--danger-text)" : "var(--success-text)")}>
                          {ph.is_active ? <ShieldOff size={13} /> : <ShieldCheck size={13} />}
                        </button>
                        <button onClick={() => deleteProjectPhase(ph)} disabled={projectPhaseBusy} title="Delete (only if unused)" style={iconBtnStyle("var(--danger-text)")}>
                          <Trash2 size={13} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : manageDrawer === "phase_mapping" ? (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "var(--navy)" }}>Manage Status &rarr; Phase Mapping</div>
                  <button onClick={() => setManageDrawer(null)} style={{ display: "flex", background: "none", border: "none", cursor: "pointer", color: "var(--muted)" }}>
                    <X size={16} />
                  </button>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 14 }}>
                  Check a box to offer that Phase when a project's Status is set to that row. To rename, reorder, add,
                  or deactivate a Phase itself, use "Project Phases" instead -- only active Phases are shown as
                  columns here.
                </div>

                <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}>
                  <table style={{ borderCollapse: "collapse", width: "max-content" }}>
                    <thead>
                      <tr>
                        <th
                          style={{
                            position: "sticky",
                            left: 0,
                            zIndex: 2,
                            background: "var(--surface)",
                            minWidth: 130,
                            borderBottom: "1px solid var(--border)",
                            borderRight: "1px solid var(--border)",
                            padding: "6px 10px",
                            textAlign: "left",
                            fontSize: 10.5,
                            color: "var(--muted)",
                          }}
                        >
                          Status \ Phase
                        </th>
                        {projectPhases.filter((ph) => ph.is_active).map((ph) => (
                          <th
                            key={ph.id}
                            style={{
                              minWidth: 92,
                              padding: "6px 5px",
                              borderBottom: "1px solid var(--border)",
                              borderLeft: "1px solid var(--border)",
                              fontSize: 10.5,
                              fontWeight: 600,
                              color: "var(--navy)",
                              textAlign: "center",
                            }}
                          >
                            {ph.name}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {PHASE_MAPPABLE_STATUSES.map((status) => (
                        <tr key={status}>
                          <td
                            style={{
                              position: "sticky",
                              left: 0,
                              background: "var(--surface)",
                              borderRight: "1px solid var(--border)",
                              borderBottom: "1px solid var(--border)",
                              padding: "7px 10px",
                              fontSize: 12,
                              fontWeight: 600,
                              color: "var(--navy)",
                            }}
                          >
                            {status}
                          </td>
                          {projectPhases.filter((ph) => ph.is_active).map((ph) => {
                            const checked = phaseStatusMapping.some((m) => m.status === status && m.phase_id === ph.id);
                            return (
                              <td
                                key={ph.id}
                                style={{ borderLeft: "1px solid var(--border)", borderBottom: "1px solid var(--border)", textAlign: "center", padding: "7px 5px" }}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={phaseMappingBusy}
                                  onChange={() => togglePhaseStatusMapping(status, ph.id)}
                                />
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : manageDrawer === "reasons" ? (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "var(--navy)" }}>Manage Time Logging Reasons</div>
                  <button onClick={() => setManageDrawer(null)} style={{ display: "flex", background: "none", border: "none", cursor: "pointer", color: "var(--muted)" }}>
                    <X size={16} />
                  </button>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 14 }}>
                  Drag the grip handle to reorder. Renaming updates every time entry already tagged with the old
                  name. Deactivating keeps a reason's label on any entry that already has it set -- it just
                  disappears from the picker on new manual entries.
                </div>

                <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                  <input
                    value={newTimeEntryReasonName}
                    onChange={(e) => setNewTimeEntryReasonName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addTimeEntryReason();
                    }}
                    placeholder="New reason name"
                    spellCheck={false}
                    autoComplete="off"
                    style={{ ...inputStyle, marginTop: 0, flex: 1 }}
                  />
                  <button onClick={addTimeEntryReason} disabled={timeEntryReasonBusy || !newTimeEntryReasonName.trim()} style={addButtonStyle(!newTimeEntryReasonName.trim())}>
                    <Plus size={14} />
                    Add
                  </button>
                </div>

                <div style={{ display: "flex", flexDirection: "column", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}>
                  {timeEntryReasonsLoading && <div style={{ padding: 10, fontSize: 11.5, color: "var(--muted)" }}>Loading…</div>}
                  {!timeEntryReasonsLoading && timeEntryReasons.length === 0 && (
                    <div style={{ padding: 10, fontSize: 11.5, color: "var(--muted)" }}>None yet.</div>
                  )}
                  {timeEntryReasons.map((r) => {
                    const isEditing = editingTimeEntryReasonId === r.id;
                    const isDragging = draggedTimeEntryReasonId === r.id;
                    return (
                      <div
                        key={r.id}
                        onDragOver={(e) => {
                          if (!draggedTimeEntryReasonId || draggedTimeEntryReasonId === r.id) return;
                          e.preventDefault();
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (!draggedTimeEntryReasonId) return;
                          const ids = timeEntryReasons.map((x) => x.id);
                          const without = ids.filter((id) => id !== draggedTimeEntryReasonId);
                          without.splice(without.indexOf(r.id), 0, draggedTimeEntryReasonId);
                          setDraggedTimeEntryReasonId(null);
                          reorderTimeEntryReasons(without);
                        }}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          padding: "7px 10px",
                          borderBottom: "1px solid var(--border)",
                          opacity: isDragging ? 0.4 : r.is_active ? 1 : 0.55,
                        }}
                      >
                        <span
                          draggable
                          onDragStart={() => setDraggedTimeEntryReasonId(r.id)}
                          onDragEnd={() => setDraggedTimeEntryReasonId(null)}
                          title="Drag to reorder"
                          style={{ display: "flex", cursor: "grab", color: "var(--text-secondary)", flexShrink: 0 }}
                        >
                          <GripVertical size={14} />
                        </span>
                        {isEditing ? (
                          <input
                            value={editTimeEntryReasonName}
                            onChange={(e) => setEditTimeEntryReasonName(e.target.value)}
                            onBlur={() => saveTimeEntryReasonRename(r.id)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveTimeEntryReasonRename(r.id);
                              if (e.key === "Escape") setEditingTimeEntryReasonId(null);
                            }}
                            autoFocus
                            spellCheck={false}
                            autoComplete="off"
                            style={{ ...inputStyle, marginTop: 0, flex: 1, fontWeight: 600 }}
                          />
                        ) : (
                          <span
                            onClick={() => startEditTimeEntryReason(r)}
                            title="Click to rename"
                            style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: "var(--navy)", cursor: "pointer" }}
                          >
                            {r.name}
                          </span>
                        )}
                        <span className={`status-pill ${r.is_active ? "success" : "neutral"}`} style={{ fontSize: 10 }}>
                          {r.is_active ? "Active" : "Off"}
                        </span>
                        <button onClick={() => toggleTimeEntryReasonActive(r)} disabled={timeEntryReasonBusy} title={r.is_active ? "Deactivate" : "Reactivate"} style={iconBtnStyle(r.is_active ? "var(--danger-text)" : "var(--success-text)")}>
                          {r.is_active ? <ShieldOff size={13} /> : <ShieldCheck size={13} />}
                        </button>
                        <button onClick={() => deleteTimeEntryReason(r)} disabled={timeEntryReasonBusy} title="Delete (only if unused)" style={iconBtnStyle("var(--danger-text)")}>
                          <Trash2 size={13} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "var(--navy)" }}>Manage Task Types</div>
                  <button onClick={() => setManageDrawer(null)} style={{ display: "flex", background: "none", border: "none", cursor: "pointer", color: "var(--muted)" }}>
                    <X size={16} />
                  </button>
                </div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 14 }}>
                  Rows are Task Types, columns are Output Types. Check a box to allow that Output Type on tasks set to
                  that Task Type -- this is exactly what WBS Planning's Output Type picker filters against. Click a
                  name to rename it; drag a row's grip handle to reorder.
                </div>

                <div style={{ display: "flex", gap: 16, marginBottom: 14, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                      value={newWorkTypeName}
                      onChange={(e) => setNewWorkTypeName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") addWorkType();
                      }}
                      placeholder="New task type"
                      spellCheck={false}
                      autoComplete="off"
                      style={{ ...inputStyle, marginTop: 0, width: 170 }}
                    />
                    <button onClick={addWorkType} disabled={workTypeBusy || !newWorkTypeName.trim()} style={addButtonStyle(!newWorkTypeName.trim())}>
                      <Plus size={13} />
                      Add row
                    </button>
                  </div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                      value={newOutputTypeName}
                      onChange={(e) => setNewOutputTypeName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") addOutputType();
                      }}
                      placeholder="New output type"
                      spellCheck={false}
                      autoComplete="off"
                      style={{ ...inputStyle, marginTop: 0, width: 170 }}
                    />
                    <button onClick={addOutputType} disabled={outputTypeBusy || !newOutputTypeName.trim()} style={addButtonStyle(!newOutputTypeName.trim())}>
                      <Plus size={13} />
                      Add column
                    </button>
                  </div>
                </div>

                <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}>
                  <table style={{ borderCollapse: "collapse", width: "max-content" }}>
                    <thead>
                      <tr>
                        <th
                          style={{
                            position: "sticky",
                            left: 0,
                            zIndex: 2,
                            background: "var(--surface)",
                            minWidth: 230,
                            borderBottom: "1px solid var(--border)",
                            borderRight: "1px solid var(--border)",
                            padding: "6px 10px",
                            textAlign: "left",
                            fontSize: 10.5,
                            color: "var(--muted)",
                          }}
                        >
                          Task Type \ Output Type
                        </th>
                        {outputTypes.map((o) => {
                          const isEditingCol = editingOutputTypeId === o.id;
                          return (
                            <th
                              key={o.id}
                              style={{
                                minWidth: 92,
                                padding: "6px 5px",
                                borderBottom: "1px solid var(--border)",
                                borderLeft: "1px solid var(--border)",
                                verticalAlign: "bottom",
                                opacity: o.is_active ? 1 : 0.5,
                              }}
                            >
                              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                                {isEditingCol ? (
                                  <input
                                    value={editOutputTypeName}
                                    onChange={(e) => setEditOutputTypeName(e.target.value)}
                                    onBlur={() => saveOutputTypeRename(o.id)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") saveOutputTypeRename(o.id);
                                      if (e.key === "Escape") setEditingOutputTypeId(null);
                                    }}
                                    autoFocus
                                    spellCheck={false}
                                    autoComplete="off"
                                    style={{ ...inputStyle, marginTop: 0, width: 84, fontSize: 10.5, textAlign: "center", padding: "3px 4px" }}
                                  />
                                ) : (
                                  <span
                                    onClick={() => startEditOutputType(o)}
                                    title="Click to rename"
                                    style={{ fontSize: 10.5, fontWeight: 600, color: "var(--navy)", cursor: "pointer", textAlign: "center" }}
                                  >
                                    {o.name}
                                  </span>
                                )}
                                <div style={{ display: "flex", gap: 4 }}>
                                  <button
                                    onClick={() => toggleOutputTypeActive(o)}
                                    disabled={outputTypeBusy}
                                    title={o.is_active ? "Deactivate" : "Reactivate"}
                                    style={iconBtnStyle(o.is_active ? "var(--muted)" : "var(--success-text)")}
                                  >
                                    {o.is_active ? <ShieldOff size={11} /> : <ShieldCheck size={11} />}
                                  </button>
                                  <button onClick={() => deleteOutputType(o)} disabled={outputTypeBusy} title="Delete (only if unused)" style={iconBtnStyle("var(--danger-text)")}>
                                    <Trash2 size={11} />
                                  </button>
                                </div>
                              </div>
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {workTypesLoading && (
                        <tr>
                          <td style={{ padding: 10, fontSize: 11.5, color: "var(--muted)" }}>Loading…</td>
                        </tr>
                      )}
                      {!workTypesLoading && workTypes.length === 0 && (
                        <tr>
                          <td style={{ padding: 10, fontSize: 11.5, color: "var(--muted)" }}>None yet.</td>
                        </tr>
                      )}
                      {workTypes.map((w) => {
                        const isDragging = draggedWorkTypeId === w.id;
                        const isEditingRow = editingWorkTypeId === w.id;
                        return (
                          <tr
                            key={w.id}
                            onDragOver={(e) => {
                              if (!draggedWorkTypeId || draggedWorkTypeId === w.id) return;
                              e.preventDefault();
                            }}
                            onDrop={(e) => {
                              e.preventDefault();
                              if (!draggedWorkTypeId) return;
                              const ids = workTypes.map((x) => x.id);
                              const without = ids.filter((id) => id !== draggedWorkTypeId);
                              without.splice(without.indexOf(w.id), 0, draggedWorkTypeId);
                              setDraggedWorkTypeId(null);
                              reorderWorkTypes(without);
                            }}
                            style={{ opacity: isDragging ? 0.4 : w.is_active ? 1 : 0.55 }}
                          >
                            <td
                              style={{
                                position: "sticky",
                                left: 0,
                                zIndex: 1,
                                background: "var(--surface)",
                                borderRight: "1px solid var(--border)",
                                borderBottom: "1px solid var(--border)",
                                padding: "6px 8px",
                              }}
                            >
                              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                                <span
                                  draggable
                                  onDragStart={() => setDraggedWorkTypeId(w.id)}
                                  onDragEnd={() => setDraggedWorkTypeId(null)}
                                  title="Drag to reorder"
                                  style={{ display: "flex", cursor: "grab", color: "var(--text-secondary)", flexShrink: 0 }}
                                >
                                  <GripVertical size={13} />
                                </span>
                                {isEditingRow ? (
                                  <input
                                    value={editWorkTypeName}
                                    onChange={(e) => setEditWorkTypeName(e.target.value)}
                                    onBlur={() => saveWorkTypeRename(w.id)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") saveWorkTypeRename(w.id);
                                      if (e.key === "Escape") setEditingWorkTypeId(null);
                                    }}
                                    autoFocus
                                    spellCheck={false}
                                    autoComplete="off"
                                    style={{ ...inputStyle, marginTop: 0, flex: 1, fontSize: 12, fontWeight: 600, padding: "3px 5px" }}
                                  />
                                ) : (
                                  <span
                                    onClick={() => startEditWorkType(w)}
                                    title="Click to rename"
                                    style={{ flex: 1, fontSize: 12, fontWeight: 600, color: "var(--navy)", cursor: "pointer", whiteSpace: "nowrap" }}
                                  >
                                    {w.name}
                                  </span>
                                )}
                                <button
                                  onClick={() => toggleWorkTypeFixedSchedule(w)}
                                  disabled={workTypeBusy}
                                  title={w.is_fixed_schedule ? "Fixed-Schedule -- hours never defer" : "Flexible -- hours can defer if busy"}
                                  style={iconBtnStyle(w.is_fixed_schedule ? "var(--warning-text)" : "var(--muted)")}
                                >
                                  {w.is_fixed_schedule ? <CalendarClock size={12} /> : <CalendarDays size={12} />}
                                </button>
                                <button onClick={() => toggleWorkTypeActive(w)} disabled={workTypeBusy} title={w.is_active ? "Deactivate" : "Reactivate"} style={iconBtnStyle(w.is_active ? "var(--danger-text)" : "var(--success-text)")}>
                                  {w.is_active ? <ShieldOff size={12} /> : <ShieldCheck size={12} />}
                                </button>
                                <button onClick={() => deleteWorkType(w)} disabled={workTypeBusy} title="Delete (only if unused)" style={iconBtnStyle("var(--danger-text)")}>
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            </td>
                            {outputTypes.map((o) => {
                              const checked = mappings.some((m) => m.work_type_id === w.id && m.output_type_id === o.id);
                              return (
                                <td key={o.id} style={{ textAlign: "center", borderLeft: "1px solid var(--border)", borderBottom: "1px solid var(--border)", padding: 6 }}>
                                  <input type="checkbox" checked={checked} onChange={() => toggleMapping(w.id, o.id)} disabled={mappingBusy} />
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </>
      )}

      <div
        className="card"
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}
      >
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>Lock historical ownership/assignee attribution</div>
          <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
            {historicalLockingEnabled
              ? "On -- Utilization and Day Planner freeze past attribution when a project/task changes owner or assignee."
              : "Off -- Utilization and Day Planner always show the CURRENT owner/assignee, even for past dates. Turn this on when you're ready to stop testing and go live with real data."}
          </div>
        </div>
        <button
          onClick={toggleHistoricalLocking}
          disabled={historicalLockingSaving}
          title={historicalLockingEnabled ? "Turn off" : "Turn on"}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "7px 14px",
            fontSize: 12,
            fontWeight: 600,
            color: historicalLockingEnabled ? "#fff" : "var(--navy)",
            background: historicalLockingEnabled ? "var(--success-text)" : "var(--surface)",
            border: "1px solid var(--border)",
            opacity: historicalLockingSaving ? 0.6 : 1,
            cursor: historicalLockingSaving ? "default" : "pointer",
            flexShrink: 0,
          }}
        >
          {historicalLockingSaving ? "Saving…" : historicalLockingEnabled ? "On" : "Off"}
        </button>
      </div>
    </div>
  );
}

const inputStyle: CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: 4,
  padding: "6px 8px",
  fontSize: 12,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
};

const manageButtonStyle: CSSProperties = {
  padding: "6px 12px",
  fontSize: 11.5,
  fontWeight: 600,
  color: "var(--navy)",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  cursor: "pointer",
};

function addButtonStyle(disabled: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "7px 12px",
    fontSize: 12,
    fontWeight: 600,
    color: "#fff",
    background: "var(--navy)",
    border: "none",
    borderRadius: "var(--radius-sm)",
    opacity: disabled ? 0.6 : 1,
    cursor: disabled ? "default" : "pointer",
    whiteSpace: "nowrap",
  };
}

function iconBtnStyle(color: string): CSSProperties {
  return { display: "flex", background: "none", border: "none", cursor: "pointer", color, padding: 2, flexShrink: 0 };
}
