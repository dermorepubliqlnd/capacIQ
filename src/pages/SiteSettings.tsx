import { useEffect, useState, type CSSProperties } from "react";
import { ShieldCheck, ShieldOff, Pencil, Check, X, Plus, ArrowUp, ArrowDown, Trash2, CalendarClock, CalendarDays, GripVertical, ChevronRight } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useSession } from "../lib/useSession";

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
  const [openPanel, setOpenPanel] = useState<{ kind: "work_type" | "output_type"; id: string } | null>(null);
  const [draggedWorkTypeId, setDraggedWorkTypeId] = useState<string | null>(null);
  const [draggedOutputTypeId, setDraggedOutputTypeId] = useState<string | null>(null);

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
    if (!window.confirm(`Delete "${w.name}"? This can't be undone.`)) {
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
    if (!window.confirm(`Delete "${s.name}"? This can't be undone.`)) {
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
    if (!window.confirm(`Delete "${o.name}"? This can't be undone.`)) {
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

  useEffect(() => {
    if (me?.access_level === "full") {
      loadWorkTypes();
      loadProjectSources();
      loadOutputTypes();
      loadMappings();
      loadHistoricalLocking();
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
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>Task Types</div>
          <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
            The list of Task Type options offered on every task (Projects &amp; WBS Planning). Alphabetized by
            default -- drag the grip handle to reorder. Click a row to rename, deactivate, mark it Fixed-Schedule, set
            which Output Types it allows, or delete it.
          </div>
        </div>
        {workTypesLoading && <div style={{ fontSize: 11.5, color: "var(--muted)" }}>Loading…</div>}
        {!workTypesLoading && workTypes.length === 0 && (
          <div style={{ fontSize: 11.5, color: "var(--muted)" }}>None yet.</div>
        )}
        <div style={{ display: "flex", flexDirection: "column", maxWidth: 480 }}>
          {workTypes.map((w) => {
            const isDragging = draggedWorkTypeId === w.id;
            const isSelected = openPanel?.kind === "work_type" && openPanel.id === w.id;
            return (
              <div
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
                onClick={() => {
                  setOpenPanel({ kind: "work_type", id: w.id });
                  startEditWorkType(w);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 8px",
                  borderBottom: "1px solid var(--border)",
                  opacity: isDragging ? 0.4 : w.is_active ? 1 : 0.55,
                  cursor: "pointer",
                  background: isSelected ? "var(--surface-hover, #f4f6fa)" : "transparent",
                }}
              >
                {/* Grip handle: drag-to-reorder (Sandra, 2026-08-25: "let's
                    use drag handles instead of the arrows for easier
                    organization"), same affordance as ViewSettingsMenu's
                    sort-priority list. Reorder persists a full 1..N
                    re-sequence of sort_order, not just a neighbor swap. */}
                <span
                  draggable
                  onDragStart={(e) => {
                    e.stopPropagation();
                    setDraggedWorkTypeId(w.id);
                  }}
                  onDragEnd={() => setDraggedWorkTypeId(null)}
                  onClick={(e) => e.stopPropagation()}
                  title="Drag to reorder"
                  style={{ display: "flex", cursor: "grab", color: "var(--text-secondary)", flexShrink: 0 }}
                >
                  <GripVertical size={14} />
                </span>
                <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: "var(--navy)" }}>{w.name}</span>
                {w.is_fixed_schedule && (
                  <span className="status-pill warning" style={{ fontSize: 10 }} title="Fixed-Schedule -- hours never defer">
                    Fixed
                  </span>
                )}
                <span className={`status-pill ${w.is_active ? "success" : "neutral"}`} style={{ fontSize: 10 }}>
                  {w.is_active ? "Active" : "Off"}
                </span>
                <ChevronRight size={13} color="var(--muted)" />
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 10, maxWidth: 480 }}>
          <input
            value={newWorkTypeName}
            onChange={(e) => setNewWorkTypeName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addWorkType();
            }}
            placeholder="New task type name"
            spellCheck={false}
            autoComplete="off"
            style={{ ...inputStyle, marginTop: 0, flex: 1 }}
          />
          <button
            onClick={addWorkType}
            disabled={workTypeBusy || !newWorkTypeName.trim()}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "7px 12px",
              fontSize: 12,
              fontWeight: 600,
              color: "#fff",
              background: "var(--navy)",
              border: "none",
              opacity: !newWorkTypeName.trim() ? 0.6 : 1,
              cursor: !newWorkTypeName.trim() ? "default" : "pointer",
            }}
          >
            <Plus size={14} />
            Add
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 600 }}>Project Sources</div>
            <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
              The list of Source options offered on every project (Projects &amp; the Portfolio Dashboard's Source
              filter/breakdown). Tracks how/why a project originated -- separate from Category, which classifies the
              training type. Reorder with the arrows, rename inline, deactivate a source you no longer want offered on
              NEW projects, or delete one outright if no project uses it.
            </div>
          </div>
        </div>
        <table className="data-table" style={{ width: "100%", maxWidth: 420 }}>
          <thead>
            <tr>
              <th style={{ width: 40 }} />
              <th>Name</th>
              <th style={{ width: 90 }}>Status</th>
              <th style={{ width: 100 }} />
            </tr>
          </thead>
          <tbody>
            {projectSourcesLoading && (
              <tr>
                <td colSpan={4} style={{ color: "var(--muted)" }}>Loading…</td>
              </tr>
            )}
            {!projectSourcesLoading && projectSources.length === 0 && (
              <tr>
                <td colSpan={4} style={{ color: "var(--muted)" }}>None yet.</td>
              </tr>
            )}
            {projectSources.map((s, idx) => {
              const isEditing = editingProjectSourceId === s.id;
              return (
                <tr key={s.id}>
                  <td>
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <button
                        onClick={() => moveProjectSource(s, "up")}
                        disabled={projectSourceBusy || idx === 0}
                        title="Move up"
                        style={{ background: "none", border: "none", cursor: idx === 0 ? "default" : "pointer", opacity: idx === 0 ? 0.3 : 1, padding: 0 }}
                      >
                        <ArrowUp size={13} />
                      </button>
                      <button
                        onClick={() => moveProjectSource(s, "down")}
                        disabled={projectSourceBusy || idx === projectSources.length - 1}
                        title="Move down"
                        style={{
                          background: "none",
                          border: "none",
                          cursor: idx === projectSources.length - 1 ? "default" : "pointer",
                          opacity: idx === projectSources.length - 1 ? 0.3 : 1,
                          padding: 0,
                        }}
                      >
                        <ArrowDown size={13} />
                      </button>
                    </div>
                  </td>
                  <td style={{ fontWeight: 600, color: "var(--navy)" }}>
                    {isEditing ? (
                      <input
                        value={editProjectSourceName}
                        onChange={(e) => setEditProjectSourceName(e.target.value)}
                        spellCheck={false}
                        autoComplete="off"
                        style={{ ...inputStyle, marginTop: 0, fontWeight: 600 }}
                      />
                    ) : (
                      s.name
                    )}
                  </td>
                  <td>
                    <span className={`status-pill ${s.is_active ? "success" : "neutral"}`}>{s.is_active ? "Active" : "Deactivated"}</span>
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 8 }}>
                      {isEditing ? (
                        <>
                          <button
                            onClick={() => saveProjectSourceRename(s.id)}
                            disabled={projectSourceBusy}
                            title="Save"
                            style={{ display: "flex", background: "none", border: "none", cursor: "pointer", color: "var(--success-text)" }}
                          >
                            <Check size={14} />
                          </button>
                          <button
                            onClick={() => setEditingProjectSourceId(null)}
                            title="Cancel"
                            style={{ display: "flex", background: "none", border: "none", cursor: "pointer", color: "var(--muted)" }}
                          >
                            <X size={14} />
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => startEditProjectSource(s)}
                            title="Rename"
                            style={{ display: "flex", background: "none", border: "none", cursor: "pointer", color: "var(--navy)" }}
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            onClick={() => toggleProjectSourceActive(s)}
                            disabled={projectSourceBusy}
                            title={s.is_active ? "Deactivate" : "Reactivate"}
                            style={{ display: "flex", background: "none", border: "none", cursor: "pointer", color: s.is_active ? "var(--danger-text)" : "var(--success-text)" }}
                          >
                            {s.is_active ? <ShieldOff size={13} /> : <ShieldCheck size={13} />}
                          </button>
                          <button
                            onClick={() => deleteProjectSource(s)}
                            disabled={projectSourceBusy}
                            title="Delete (only if unused)"
                            style={{ display: "flex", background: "none", border: "none", cursor: "pointer", color: "var(--danger-text)" }}
                          >
                            <Trash2 size={13} />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div style={{ display: "flex", gap: 8, marginTop: 10, maxWidth: 480 }}>
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
          <button
            onClick={addProjectSource}
            disabled={projectSourceBusy || !newProjectSourceName.trim()}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "7px 12px",
              fontSize: 12,
              fontWeight: 600,
              color: "#fff",
              background: "var(--navy)",
              border: "none",
              opacity: !newProjectSourceName.trim() ? 0.6 : 1,
              cursor: !newProjectSourceName.trim() ? "default" : "pointer",
            }}
          >
            <Plus size={14} />
            Add
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>Output Types</div>
          <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
            The list of Output Type options offered on every task (WBS Planning's Output Type field and the
            Portfolio Dashboard's Materials Output breakdown). Alphabetized by default -- drag the grip handle to
            reorder. Which Output Types are pickable on a task depends on that task's Task Type -- set that mapping
            from each Task Type's own panel above. Click a row here to rename, deactivate, or delete it.
          </div>
        </div>
        {outputTypesLoading && <div style={{ fontSize: 11.5, color: "var(--muted)" }}>Loading…</div>}
        {!outputTypesLoading && outputTypes.length === 0 && (
          <div style={{ fontSize: 11.5, color: "var(--muted)" }}>None yet.</div>
        )}
        <div style={{ display: "flex", flexDirection: "column", maxWidth: 480 }}>
          {outputTypes.map((o) => {
            const isDragging = draggedOutputTypeId === o.id;
            const isSelected = openPanel?.kind === "output_type" && openPanel.id === o.id;
            const usedByCount = mappings.filter((m) => m.output_type_id === o.id).length;
            return (
              <div
                key={o.id}
                onDragOver={(e) => {
                  if (!draggedOutputTypeId || draggedOutputTypeId === o.id) return;
                  e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (!draggedOutputTypeId) return;
                  const ids = outputTypes.map((x) => x.id);
                  const without = ids.filter((id) => id !== draggedOutputTypeId);
                  without.splice(without.indexOf(o.id), 0, draggedOutputTypeId);
                  setDraggedOutputTypeId(null);
                  reorderOutputTypes(without);
                }}
                onClick={() => {
                  setOpenPanel({ kind: "output_type", id: o.id });
                  startEditOutputType(o);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 8px",
                  borderBottom: "1px solid var(--border)",
                  opacity: isDragging ? 0.4 : o.is_active ? 1 : 0.55,
                  cursor: "pointer",
                  background: isSelected ? "var(--surface-hover, #f4f6fa)" : "transparent",
                }}
              >
                <span
                  draggable
                  onDragStart={(e) => {
                    e.stopPropagation();
                    setDraggedOutputTypeId(o.id);
                  }}
                  onDragEnd={() => setDraggedOutputTypeId(null)}
                  onClick={(e) => e.stopPropagation()}
                  title="Drag to reorder"
                  style={{ display: "flex", cursor: "grab", color: "var(--text-secondary)", flexShrink: 0 }}
                >
                  <GripVertical size={14} />
                </span>
                <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: "var(--navy)" }}>{o.name}</span>
                <span style={{ fontSize: 10, color: "var(--muted)" }} title="Number of Task Types this Output Type is allowed on">
                  {usedByCount} task type{usedByCount === 1 ? "" : "s"}
                </span>
                <span className={`status-pill ${o.is_active ? "success" : "neutral"}`} style={{ fontSize: 10 }}>
                  {o.is_active ? "Active" : "Off"}
                </span>
                <ChevronRight size={13} color="var(--muted)" />
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 10, maxWidth: 480 }}>
          <input
            value={newOutputTypeName}
            onChange={(e) => setNewOutputTypeName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addOutputType();
            }}
            placeholder="New output type name"
            spellCheck={false}
            autoComplete="off"
            style={{ ...inputStyle, marginTop: 0, flex: 1 }}
          />
          <button
            onClick={addOutputType}
            disabled={outputTypeBusy || !newOutputTypeName.trim()}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "7px 12px",
              fontSize: 12,
              fontWeight: 600,
              color: "#fff",
              background: "var(--navy)",
              border: "none",
              opacity: !newOutputTypeName.trim() ? 0.6 : 1,
              cursor: !newOutputTypeName.trim() ? "default" : "pointer",
            }}
          >
            <Plus size={14} />
            Add
          </button>
        </div>
      </div>

      {openPanel && (() => {
        const w = openPanel.kind === "work_type" ? workTypes.find((x) => x.id === openPanel.id) ?? null : null;
        const o = openPanel.kind === "output_type" ? outputTypes.find((x) => x.id === openPanel.id) ?? null : null;
        return (
          <>
            {/* Side-peek panel (Phase 23 redesign, Sandra: "an edit panel
                -- can be a side peep"). Backdrop closes it on click
                outside; the panel itself is fixed so it doesn't scroll
                away from a tall outline list. */}
            <div onClick={() => setOpenPanel(null)} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.35)", zIndex: 40 }} />
            <div
              style={{
                position: "fixed",
                top: 0,
                right: 0,
                height: "100vh",
                width: 360,
                maxWidth: "90vw",
                background: "var(--surface, #fff)",
                boxShadow: "-8px 0 24px rgba(0,0,0,0.18)",
                zIndex: 41,
                display: "flex",
                flexDirection: "column",
                padding: 18,
                overflowY: "auto",
              }}
            >
              {w && (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "var(--navy)" }}>Task Type</div>
                    <button onClick={() => setOpenPanel(null)} style={{ display: "flex", background: "none", border: "none", cursor: "pointer", color: "var(--muted)" }}>
                      <X size={16} />
                    </button>
                  </div>

                  <label style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)" }}>Name</label>
                  <div style={{ display: "flex", gap: 6, marginTop: 4, marginBottom: 14 }}>
                    <input
                      value={editWorkTypeName}
                      onChange={(e) => setEditWorkTypeName(e.target.value)}
                      spellCheck={false}
                      autoComplete="off"
                      style={{ ...inputStyle, marginTop: 0, flex: 1 }}
                    />
                    <button
                      onClick={() => saveWorkTypeRename(w.id)}
                      disabled={workTypeBusy || !editWorkTypeName.trim()}
                      title="Save name"
                      style={{ display: "flex", alignItems: "center", background: "var(--navy)", border: "none", borderRadius: "var(--radius-sm)", color: "#fff", cursor: "pointer", padding: "0 10px" }}
                    >
                      <Check size={14} />
                    </button>
                  </div>

                  <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                    <button
                      onClick={() => toggleWorkTypeActive(w)}
                      disabled={workTypeBusy}
                      style={{
                        flex: 1,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 6,
                        padding: "7px 10px",
                        fontSize: 12,
                        fontWeight: 600,
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-sm)",
                        background: "var(--surface)",
                        color: w.is_active ? "var(--danger-text)" : "var(--success-text)",
                        cursor: "pointer",
                      }}
                    >
                      {w.is_active ? <ShieldOff size={13} /> : <ShieldCheck size={13} />}
                      {w.is_active ? "Deactivate" : "Reactivate"}
                    </button>
                    <button
                      onClick={() => toggleWorkTypeFixedSchedule(w)}
                      disabled={workTypeBusy}
                      title={w.is_fixed_schedule ? "Hours never defer to another day" : "Hours can defer if the assignee is busy"}
                      style={{
                        flex: 1,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 6,
                        padding: "7px 10px",
                        fontSize: 12,
                        fontWeight: 600,
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-sm)",
                        background: "var(--surface)",
                        color: w.is_fixed_schedule ? "var(--warning-text)" : "var(--muted)",
                        cursor: "pointer",
                      }}
                    >
                      {w.is_fixed_schedule ? <CalendarClock size={13} /> : <CalendarDays size={13} />}
                      {w.is_fixed_schedule ? "Fixed-Schedule" : "Flexible"}
                    </button>
                  </div>

                  <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>Allowed Output Types</div>
                  <div style={{ fontSize: 10.5, color: "var(--muted)", marginBottom: 8 }}>
                    Only checked Output Types will be pickable on a task set to this Task Type in WBS Planning.
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 18, maxHeight: 280, overflowY: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: 8 }}>
                    {outputTypes.filter((o2) => o2.is_active).map((o2) => {
                      const checked = mappings.some((m) => m.work_type_id === w.id && m.output_type_id === o2.id);
                      return (
                        <label key={o2.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                          <input type="checkbox" checked={checked} onChange={() => toggleMapping(w.id, o2.id)} disabled={mappingBusy} />
                          {o2.name}
                        </label>
                      );
                    })}
                    {outputTypes.filter((o2) => o2.is_active).length === 0 && (
                      <div style={{ fontSize: 11.5, color: "var(--muted)" }}>No active Output Types yet.</div>
                    )}
                  </div>

                  <button
                    onClick={() => deleteWorkType(w)}
                    disabled={workTypeBusy}
                    style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", fontSize: 12, fontWeight: 600, border: "1px solid var(--danger-text)", borderRadius: "var(--radius-sm)", background: "none", color: "var(--danger-text)", cursor: "pointer" }}
                  >
                    <Trash2 size={13} />
                    Delete (only if unused)
                  </button>
                </>
              )}

              {o && (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "var(--navy)" }}>Output Type</div>
                    <button onClick={() => setOpenPanel(null)} style={{ display: "flex", background: "none", border: "none", cursor: "pointer", color: "var(--muted)" }}>
                      <X size={16} />
                    </button>
                  </div>

                  <label style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)" }}>Name</label>
                  <div style={{ display: "flex", gap: 6, marginTop: 4, marginBottom: 14 }}>
                    <input
                      value={editOutputTypeName}
                      onChange={(e) => setEditOutputTypeName(e.target.value)}
                      spellCheck={false}
                      autoComplete="off"
                      style={{ ...inputStyle, marginTop: 0, flex: 1 }}
                    />
                    <button
                      onClick={() => saveOutputTypeRename(o.id)}
                      disabled={outputTypeBusy || !editOutputTypeName.trim()}
                      title="Save name"
                      style={{ display: "flex", alignItems: "center", background: "var(--navy)", border: "none", borderRadius: "var(--radius-sm)", color: "#fff", cursor: "pointer", padding: "0 10px" }}
                    >
                      <Check size={14} />
                    </button>
                  </div>

                  <button
                    onClick={() => toggleOutputTypeActive(o)}
                    disabled={outputTypeBusy}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 6,
                      padding: "7px 10px",
                      fontSize: 12,
                      fontWeight: 600,
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-sm)",
                      background: "var(--surface)",
                      color: o.is_active ? "var(--danger-text)" : "var(--success-text)",
                      cursor: "pointer",
                      marginBottom: 16,
                    }}
                  >
                    {o.is_active ? <ShieldOff size={13} /> : <ShieldCheck size={13} />}
                    {o.is_active ? "Deactivate" : "Reactivate"}
                  </button>

                  <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 4 }}>Used by these Task Types</div>
                  <div style={{ fontSize: 10.5, color: "var(--muted)", marginBottom: 8 }}>
                    Edit this from each Task Type's own panel above -- open a Task Type, then check/uncheck Output Types there.
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 18 }}>
                    {workTypes.filter((w2) => mappings.some((m) => m.output_type_id === o.id && m.work_type_id === w2.id)).map((w2) => (
                      <span key={w2.id} className="status-pill neutral" style={{ fontSize: 10.5 }}>
                        {w2.name}
                      </span>
                    ))}
                    {!workTypes.some((w2) => mappings.some((m) => m.output_type_id === o.id && m.work_type_id === w2.id)) && (
                      <div style={{ fontSize: 11.5, color: "var(--muted)" }}>Not mapped to any Task Type yet.</div>
                    )}
                  </div>

                  <button
                    onClick={() => deleteOutputType(o)}
                    disabled={outputTypeBusy}
                    style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", fontSize: 12, fontWeight: 600, border: "1px solid var(--danger-text)", borderRadius: "var(--radius-sm)", background: "none", color: "var(--danger-text)", cursor: "pointer" }}
                  >
                    <Trash2 size={13} />
                    Delete (only if unused)
                  </button>
                </>
              )}
            </div>
          </>
        );
      })()}

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
