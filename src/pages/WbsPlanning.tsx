import { useState, useEffect, useRef, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams, Link } from "react-router-dom";
import { ArrowLeft, Plus, ChevronLeft, ChevronRight, ChevronDown, Info, AlertTriangle, Link2, Trash2, GripVertical, RefreshCw, Clock, ListPlus, TrendingUp, TrendingDown, Calendar, User } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useSession } from "../lib/useSession";
import { useConfirm } from "../lib/useConfirm";
import { InlineText, InlineNumber, InlineSelect, InlineDate } from "../components/InlineCell";
import { formatDate } from "../lib/formatDate";
import { addDays, buildHolidaySet, isWorkingDay, parseLocalDate, toISO, workingDaysBetween, type HolidaySet } from "../lib/workingDays";
import { standardScenario, fullCapacityScenario } from "../lib/taskScheduling";
import { TASK_EFFORT_OPTIONS, TASK_EFFORT_DEFAULT_TONES } from "../lib/notionOptions";
import {
  dailyPointsFor,
  dailyCapacityFor,
  tierOf,
  type UtilTaskRow,
  type UtilProjectRow,
  type UtilPersonRow,
} from "../lib/utilizationCalc";
import { colorForPerson, UNASSIGNED_BAR_COLOR } from "../lib/personColors";
import { WBS_STATUS_META, type WbsStatus } from "../lib/wbsStatus";

interface ProjectRow {
  id: string;
  name: string;
  owner_id: string | null;
  start_date: string | null;
  end_date: string | null;
  timelines_locked: boolean;
  phase: string | null;
  status: string | null;
  // Draft / Baseline Locked / Revision in Progress / Changed After
  // Baseline / Closed -- a distinct axis from Phase/Status above (Phase 1
  // migration, 2026-07-28). Drives the status banner and which actions
  // (Lock Baseline / Start Revision / Apply/Discard / Request Closure)
  // show below.
  wbs_status: WbsStatus;
  // Persists whichever mode Save last actually wrote onto the tasks
  // (migration 2026-07-28) -- shown read-back in the header as "Scoping
  // Effort" so a project's officially-saved mode stays visible on return
  // visits, not just whatever this page's own local toggle happens to be
  // set to right now.
  scoping_effort_mode: string | null;
}
interface TaskRow {
  id: string;
  project_id: string;
  parent_task_id: string | null;
  name: string;
  assignee_id: string | null;
  status: string | null;
  start_date: string | null;
  // Per-mode draft Start dates (migration 2026-07-24f). `start_date` above
  // stays the single canonical field the REST of the app reads (Projects &
  // Tasks table, Timeline, Calendar) -- only written by this page's own
  // Save button, same as `current_due_date` always was. Full Effort and
  // Conservative Effort each need their OWN Start now: a dependency's
  // predecessor finishes on a different date under each mode, so a single
  // shared Start could never sit "right after" both at once -- see
  // [[project_capaciq_wbs_planning]] Round 11 for the live bug this fixes.
  start_date_full: string | null;
  start_date_standard: string | null;
  // True while this mode's Start is still "on auto-pilot" -- i.e. still
  // tracking its dependencies' own End dates live, rather than having been
  // deliberately typed by hand. Set true whenever a dependency is added
  // (or a task has no dependencies at all, in which case it's simply
  // unused), and flipped to false the moment the user directly edits that
  // mode's Start date themselves. See the sync effect below (migration
  // 2026-07-24g) -- added because Sandra found that extending a
  // predecessor's Estimated hours moved ITS OWN End date but did nothing
  // to a dependent task's already-set Start, leaving only the warning icon
  // and a manual untick/retick-the-dependency workaround.
  start_full_auto: boolean;
  start_standard_auto: boolean;
  current_due_date: string;
  estimated_hours: number | null;
  effort: string | null;
  is_archived: boolean;
  sort_order: number | null;
}
interface PersonRow {
  id: string;
  name: string;
  daily_capacity_hours: number;
  is_active: boolean;
  color: string | null;
}
// Phase 2 (2026-07-28): Draft/Baseline/Revision/Final-Scope workflow rows.
// Only the ONE in-progress revision and ONE pending closure request (if
// any) matter to this page -- both are DB-enforced to be unique per
// project (partial unique indexes), so at most one of each ever exists.
interface RevisionRow {
  id: string;
  revision_number: number;
  reason: string;
  status: "in_progress" | "applied" | "discarded";
  started_at: string;
}
// Design spec item 4 (Sandra, 2026-07-29 follow-up, per her reference
// mockup): the task list's Changes/Notes columns compare CURRENT live
// tasks directly against the active Baseline V<n> snapshot -- not the
// latest-applied-revision log (that's still used for the Revision
// Summary panel/legend). project_baseline_tasks already captures
// everything needed for this (parent_task_id/assignee_name/effort/
// depends_on/start+end dates both modes -- confirmed via
// supabase/phase1_migration.sql's ALTER TABLE additions), so no schema
// change was needed.
interface BaselineTaskFull {
  task_id: string;
  estimated_hours: number | null;
  assignee_name: string | null;
  depends_on: string[] | null;
  end_date_full: string | null;
  end_date_standard: string | null;
}
interface RevisionChangeRow {
  id: string;
  revision_id?: string;
  task_id: string;
  task_name: string;
  change_type: string;
  field: string | null;
  previous_value: unknown;
  new_value: unknown;
}
interface ClosureRequestRow {
  id: string;
  status: "pending" | "approved" | "rejected";
  requested_at: string;
  requested_by: string | null;
}

interface ActiveBaselineRow {
  version_number: number;
  captured_at: string;
}
interface AvailabilityRow {
  person_id: string;
  date: string;
  status: "off" | "half_day";
}
interface HolidayRow {
  date: string;
}
// Task dependencies (Finish-to-Start only, v1, same-project only -- see
// migration 2026-07-24e). A task's own Start date STAYS a free, directly
// editable field (Sandra's explicit choice) -- a dependency only drives a
// soft conflict WARNING in the UI when this task's own Start falls on or
// before a predecessor's own End under the currently active mode. It does
// NOT lock or auto-compute Start the way parent-task rollups do.
interface DependencyRow {
  task_id: string;
  depends_on_task_id: string;
}

// Sandra, 2026-07-24: "this is getting complicated ... have a full and
// conservative computation - remove capacity based." Capacity-Based was
// trying to answer two questions at once (how long will this take, AND
// does this person have room) -- splitting those apart is why the
// Utilization panel below now carries the "does this person have room"
// job on its own, and Assignee becomes a normal per-task field again
// (same as the rest of the app), not something tied to a scheduling mode.
type Mode = "full_capacity" | "standard";
const MODE_LABEL: Record<Mode, string> = {
  full_capacity: "Full Effort",
  standard: "Conservative Effort",
};
const MODES: Mode[] = ["full_capacity", "standard"];

// Phase 3 (2026-07-28): status banner copy/colors for the Draft/Baseline/
// Revision/Final-Scope workflow. Deliberately reuses the app's existing
// --navy/--muted/--warning-text CSS vars rather than inventing new colors.
// WBS_STATUS_META moved to ../lib/wbsStatus (Phase 4, 2026-07-28) so the
// Projects page's WBS Status column can share the exact same labels/colors.

interface ChainEntry {
  start: string;
  end: string;
  durationDays: number;
  rawDays?: number;
}

const UTIL_WINDOW_DAYS = 28; // 4 weeks, daily view

// WBS planning page -- see project_capaciq_wbs_planning memory for the
// full design history across many rounds. Current shape (2026-07-24,
// round 7 -- Project Name/Owner + freely-editable per-task Start dates):
// - Per task: Estimated hours, Task name, Effort, Assignee, and now Start
//   date are all directly editable and autosave immediately, same
//   convention as the rest of the app.
// - End date is NOT typed -- it's computed from that same task's own
//   Start date, independently per task (no shared day-capacity ledger
//   between tasks -- Sandra confirmed this explicitly: two tasks can
//   freely overlap/run in parallel, the utilization panel below is where
//   over-allocation actually shows up, not a scheduling constraint here).
//   Full Effort uses a flat 7.5h/day rate, Conservative Effort a flat
//   4h/day rate -- both via the same `rateScenario` helper in
//   taskScheduling.ts.
// - A parent task's own Start/End/Est.hrs are all locked, computed from
//   its own sub-tasks (min start / max end / hours sum) -- never typed
//   directly, same rollup convention throughout.
// - The project's own Start date (shown at the top, and kept in sync with
//   `projects.start_date` for the rest of the app) is now DERIVED --
//   auto-pulled from the earliest top-level task's own Start date --
//   rather than being the thing tasks chain from. New tasks still default
//   their own Start to "the day after the previous task ends" purely as a
//   convenient starting point; it's a one-time seed, fully overridable.
// - Project Name and Owner are also directly editable here now. Owner
//   feeds the PM-overhead portion of the utilization heat-map below,
//   using this project's own (derived) Start-to-End span -- so picking an
//   Owner, or extending the schedule by adding tasks, fills in that
//   person's PM-overhead utilization live, before Save.
// - "Save" writes ONE active mode's computed End dates onto every task
//   (Start dates are already live/persisted per-task) and snapshots both
//   modes' numbers into task_planning_snapshots for reporting. Locking
//   timelines is only ever done from the Tasks page's own Lock button.
// - The Utilization snapshot panel (points/tier-based, same formula as
//   the Utilization page) shows a live "what happens if I plan this"
//   preview: every OTHER real task/project in the app counts as
//   committed, but for THIS project it uses whatever the active mode
//   currently computes -- so editing Start/Effort/Assignee/Owner updates
//   the heat-map instantly, before Save.
export default function WbsPlanning() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { person: me } = useSession();
  const { confirm, alert, dialog } = useConfirm();
  const isFullAccess = me?.access_level === "full";

  const [project, setProject] = useState<ProjectRow | null>(null);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [availability, setAvailability] = useState<AvailabilityRow[]>([]);
  const [holidays, setHolidays] = useState<HolidayRow[]>([]);
  // Cross-project data, fetched ONLY for the utilization heat-map -- a
  // person's real workload includes every task/project they're on, not
  // just this one, so the "does this person have room" question can't be
  // answered from this project's own tasks alone.
  const [allTasks, setAllTasks] = useState<UtilTaskRow[]>([]);
  const [allProjects, setAllProjects] = useState<UtilProjectRow[]>([]);
  const [dependencies, setDependencies] = useState<DependencyRow[]>([]);
  const [depPickerOpenFor, setDepPickerOpenFor] = useState<string | null>(null);
  // Grip-handle drag reorder (Sandra, 2026-07-28): constrained to siblings
  // -- a top-level task can only reorder among other top-level tasks, a
  // sub-task only among its own parent's other sub-tasks. Purely visual
  // (sort_order) -- does NOT touch Start/End dates on its own; pair with
  // the Refresh dates button below to re-seed dates from the new order.
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [dragOverTaskId, setDragOverTaskId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeMode, setActiveMode] = useState<Mode>("full_capacity");
  // Separate from `activeMode` (Sandra, 2026-07-28: split the old shared
  // toggle apart) -- this one only drives the Utilization snapshot
  // preview below; `activeMode` is now purely "which mode Save/Scoping
  // Effort points at." Both Gantts render always, unconditionally, so
  // neither state drives Gantt selection anymore.
  const [utilPreviewMode, setUtilPreviewMode] = useState<Mode>("full_capacity");
  const [saving, setSaving] = useState(false);
  const [utilWindowOffset, setUtilWindowOffset] = useState(0); // in units of UTIL_WINDOW_DAYS blocks

  // Phase 2/3 workflow state.
  const [activeRevision, setActiveRevision] = useState<RevisionRow | null>(null);
  const [pendingClosure, setPendingClosure] = useState<ClosureRequestRow | null>(null);
  // Phase 5 (2026-07-28): shown next to the status banner so it's clear
  // which baseline version Compare-with-Baseline/variance are measuring
  // against, e.g. after a re-baseline event.
  const [activeBaseline, setActiveBaseline] = useState<ActiveBaselineRow | null>(null);
  const [workflowBusy, setWorkflowBusy] = useState(false);
  const [revisionHistory, setRevisionHistory] = useState<RevisionRow[]>([]);
  const [revisionChangesById, setRevisionChangesById] = useState<Record<string, RevisionChangeRow[]>>({});
  const [expandedRevisionId, setExpandedRevisionId] = useState<string | null>(null);
  // Design spec item 7 (Sandra, 2026-07-29): task-list Changes/Notes
  // columns and the Revision Summary panel both read from the SAME
  // latest-applied-revision's change log (decision #1 in
  // [[project_capaciq_wbs_ui_redesign_plan]]: reuse the already-existing
  // per-revision project_revision_changes diff, latest revision only --
  // not new per-field diff-scoring against the original baseline).
  const [latestRevisionChanges, setLatestRevisionChanges] = useState<RevisionChangeRow[]>([]);
  const [baselineTasksById, setBaselineTasksById] = useState<Record<string, BaselineTaskFull>>({});

  async function loadAll() {
    if (!projectId) return;
    setLoading(true);
    const [{ data: proj }, { data: tks }, { data: ppl }, { data: avail }, { data: hols }, { data: allTks }, { data: allProjs }] = await Promise.all([
      supabase.from("projects").select("id,name,owner_id,start_date,end_date,timelines_locked,phase,status,scoping_effort_mode,wbs_status").eq("id", projectId).single(),
      supabase
        .from("tasks")
        .select(
          "id,project_id,parent_task_id,name,assignee_id,status,start_date,start_date_full,start_date_standard,start_full_auto,start_standard_auto,current_due_date,estimated_hours,effort,is_archived,sort_order"
        )
        .eq("project_id", projectId)
        .eq("is_archived", false)
        .order("sort_order"),
      supabase.from("people").select("id,name,daily_capacity_hours,is_active,color").eq("is_active", true).order("name"),
      supabase.from("person_availability").select("person_id,date,status"),
      supabase.from("holidays").select("date"),
      supabase.from("tasks").select("id,project_id,assignee_id,status,start_date,current_due_date,effort").eq("is_archived", false),
      supabase.from("projects").select("id,owner_id,start_date,end_date").eq("is_archived", false),
    ]);
    setProject((proj as ProjectRow) ?? null);
    setTasks((tks as TaskRow[]) ?? []);
    setPeople((ppl as PersonRow[]) ?? []);
    setAvailability((avail as AvailabilityRow[]) ?? []);
    setHolidays((hols as HolidayRow[]) ?? []);
    setAllTasks((allTks as UtilTaskRow[]) ?? []);
    setAllProjects((allProjs as UtilProjectRow[]) ?? []);

    // Dependencies are same-project only (v1), so fetched as a follow-up
    // query scoped to this project's own task ids, once they're known --
    // can't be folded into the Promise.all above since it needs the task
    // id list first.
    const taskIds = ((tks as TaskRow[]) ?? []).map((t) => t.id);
    if (taskIds.length) {
      const { data: deps } = await supabase.from("task_dependencies").select("task_id,depends_on_task_id").in("task_id", taskIds);
      setDependencies((deps as DependencyRow[]) ?? []);
    } else {
      setDependencies([]);
    }

    const [{ data: revRow }, { data: closureRow }, { data: baselineRow }] = await Promise.all([
      supabase
        .from("project_revisions")
        .select("id,revision_number,reason,status,started_at")
        .eq("project_id", projectId)
        .eq("status", "in_progress")
        .maybeSingle(),
      supabase
        .from("project_closure_requests")
        .select("id,status,requested_at,requested_by")
        .eq("project_id", projectId)
        .eq("status", "pending")
        .maybeSingle(),
      supabase
        .from("project_baselines")
        .select("version_number,captured_at")
        .eq("project_id", projectId)
        .eq("is_active", true)
        .maybeSingle(),
    ]);
    setActiveRevision((revRow as RevisionRow) ?? null);
    setPendingClosure((closureRow as ClosureRequestRow) ?? null);
    setActiveBaseline((baselineRow as ActiveBaselineRow) ?? null);
    if (baselineRow) {
      loadLatestRevisionChanges();
      loadBaselineTaskSnapshot();
    }
    // Design spec item 6 follow-up (Sandra, 2026-07-29): Revision Summary
    // + Revision History now live permanently in the right rail instead
    // of behind an Actions-menu toggle, so this loads unconditionally
    // (cheap -- just an empty list on a Draft project with no revisions).
    loadRevisionHistory();

    setLoading(false);
  }

  async function loadRevisionHistory() {
    if (!projectId) return;
    const { data } = await supabase
      .from("project_revisions")
      .select("id,revision_number,reason,status,started_at")
      .eq("project_id", projectId)
      .order("revision_number", { ascending: false });
    const revs = (data as RevisionRow[]) ?? [];
    setRevisionHistory(revs);
    // Sandra, 2026-07-29 follow-up: the right rail's Revision History now
    // shows each revision's Impact inline (last 5) without a click-to-
    // expand step, so preload their changes here instead of lazily on
    // click (toggleRevisionExpand below still works the same way for any
    // revision not covered by this preload, e.g. beyond the top 5).
    const last5 = revs.slice(0, 5);
    if (last5.length > 0) {
      const { data: changeRows } = await supabase
        .from("project_revision_changes")
        .select("id,revision_id,task_id,task_name,change_type,field,previous_value,new_value")
        .in(
          "revision_id",
          last5.map((r) => r.id)
        );
      const byRevision: Record<string, RevisionChangeRow[]> = {};
      for (const c of (changeRows as RevisionChangeRow[]) ?? []) {
        const key = c.revision_id ?? "";
        const list = byRevision[key] ?? [];
        list.push(c);
        byRevision[key] = list;
      }
      setRevisionChangesById((prev) => ({ ...prev, ...byRevision }));
    }
  }

  // Feeds the task list's Changes/Notes columns and the Revision Summary
  // panel -- the latest APPLIED revision's own diff log, not a fresh
  // baseline-vs-current computation. Empty on Draft (no revisions yet)
  // and while a revision is still in_progress (nothing "latest and
  // applied" to show notes for until it's applied).
  // Design spec item 4 follow-up: full per-task snapshot of the ACTIVE
  // baseline, keyed by task_id -- feeds the task list's Changes/Notes
  // columns (current vs Baseline V<n>), separate from
  // loadLatestRevisionChanges() above (which only covers the latest
  // applied revision, used for the Revision Summary panel).
  async function loadBaselineTaskSnapshot() {
    if (!projectId) return;
    const { data: activeBl } = await supabase
      .from("project_baselines")
      .select("id")
      .eq("project_id", projectId)
      .eq("is_active", true)
      .maybeSingle();
    if (!activeBl) {
      setBaselineTasksById({});
      return;
    }
    const { data } = await supabase
      .from("project_baseline_tasks")
      .select("task_id,estimated_hours,assignee_name,depends_on,end_date_full,end_date_standard")
      .eq("baseline_id", (activeBl as { id: string }).id);
    const byId: Record<string, BaselineTaskFull> = {};
    for (const row of (data as BaselineTaskFull[]) ?? []) {
      byId[row.task_id] = row;
    }
    setBaselineTasksById(byId);
  }

  async function loadLatestRevisionChanges() {
    if (!projectId) return;
    const { data: latestRev } = await supabase
      .from("project_revisions")
      .select("id")
      .eq("project_id", projectId)
      .eq("status", "applied")
      .order("revision_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!latestRev) {
      setLatestRevisionChanges([]);
      return;
    }
    const { data } = await supabase
      .from("project_revision_changes")
      .select("id,task_id,task_name,change_type,field,previous_value,new_value")
      .eq("revision_id", (latestRev as { id: string }).id);
    setLatestRevisionChanges((data as RevisionChangeRow[]) ?? []);
  }

  async function toggleRevisionExpand(revisionId: string) {
    if (expandedRevisionId === revisionId) {
      setExpandedRevisionId(null);
      return;
    }
    setExpandedRevisionId(revisionId);
    if (!revisionChangesById[revisionId]) {
      const { data } = await supabase
        .from("project_revision_changes")
        .select("id,task_id,task_name,change_type,field,previous_value,new_value")
        .eq("revision_id", revisionId)
        .order("changed_at");
      setRevisionChangesById((prev) => ({ ...prev, [revisionId]: (data as RevisionChangeRow[]) ?? [] }));
    }
  }

  function dependsOnIdsFor(taskId: string): string[] {
    return dependencies.filter((d) => d.task_id === taskId).map((d) => d.depends_on_task_id);
  }

  // Sandra, 2026-07-24: found live that setting "Task 2 depends on Task 1"
  // didn't move Task 2's Start at all -- v1 (Round 9) deliberately kept
  // Start fully manual with only a warning. Round 10 tried auto-moving a
  // single shared Start field, but that broke down the moment BOTH modes
  // needed to be correct at once: Task 1 finishes on a different date
  // under Full Effort vs Conservative Effort, so one shared Start could
  // only ever be "right after" one of them. Round 11 fix (her own
  // diagnosis: "I think the toggle on top cause the issue"): Full Effort
  // and Conservative Effort now each get their OWN Start field
  // (`start_date_full`/`start_date_standard`), each auto-moved
  // independently -- this computes the latest "day after a predecessor's
  // own End" across ALL of a task's dependencies, for ONE given mode. Used
  // only as a one-time default the moment a dependency is added (not a
  // continuous rollup), so both fields stay completely normal, freely
  // editable afterward. If the user later edits either into a conflict,
  // `dependencyConflict` (mode-parameterized, checked against that SAME
  // mode's own Start field) catches it.
  function suggestedStartFor(depIds: string[], mode: Mode): string | null {
    let latest: string | null = null;
    for (const depId of depIds) {
      const entry = chainByMode[mode].get(depId);
      if (!entry) continue;
      const candidate = nextWorkingDayAfter(entry.end, holidaySet);
      if (!latest || candidate > latest) latest = candidate;
    }
    return latest;
  }

  async function addDependency(taskId: string, dependsOnId: string) {
    // Basic guard against an immediate two-way cycle (A depends on B, which
    // already depends on A). Longer cycles aren't checked in this v1 --
    // acceptable given the small task counts these projects run at, but a
    // real limitation if this ever needs to be bulletproof.
    if (dependsOnIdsFor(dependsOnId).includes(taskId)) {
      await alert("Can't add this -- it would create a circular dependency (that task already depends on this one).");
      return;
    }
    setDependencies((prev) => [...prev, { task_id: taskId, depends_on_task_id: dependsOnId }]);
    const { error } = await supabase.from("task_dependencies").insert({ task_id: taskId, depends_on_task_id: dependsOnId });
    if (error) {
      await alert(`Couldn't add dependency: ${error.message}`);
      loadAll();
      return;
    }
    const allDeps = [...dependsOnIdsFor(taskId), dependsOnId];
    const patch: Partial<TaskRow> = {};
    const suggestedFull = suggestedStartFor(allDeps, "full_capacity");
    if (suggestedFull) {
      patch.start_date_full = suggestedFull;
      patch.start_full_auto = true; // fresh dependency -- start tracking it live again
    }
    const suggestedStandard = suggestedStartFor(allDeps, "standard");
    if (suggestedStandard) {
      patch.start_date_standard = suggestedStandard;
      patch.start_standard_auto = true;
    }
    if (Object.keys(patch).length) saveTaskField(taskId, patch);
  }

  async function removeDependency(taskId: string, dependsOnId: string) {
    setDependencies((prev) => prev.filter((d) => !(d.task_id === taskId && d.depends_on_task_id === dependsOnId)));
    const { error } = await supabase.from("task_dependencies").delete().eq("task_id", taskId).eq("depends_on_task_id", dependsOnId);
    if (error) {
      await alert(`Couldn't remove dependency: ${error.message}`);
      loadAll();
    }
  }

  // Conflict check for the currently active mode: this task's own Start
  // (as scheduled under `mode`) falls on or before a predecessor's own End
  // under that SAME mode -- i.e. the predecessor isn't actually finished
  // yet by the time this task starts. Returns the worst-offending
  // predecessor (latest End) so the tooltip can name it.
  function dependencyConflict(t: TaskRow, mode: Mode): { name: string; end: string } | null {
    const ownEntry = chainByMode[mode].get(t.id);
    if (!ownEntry) return null;
    let worst: { name: string; end: string } | null = null;
    for (const depId of dependsOnIdsFor(t.id)) {
      const depEntry = chainByMode[mode].get(depId);
      if (!depEntry) continue;
      if (ownEntry.start <= depEntry.end) {
        if (!worst || depEntry.end > worst.end) {
          const depTask = tasks.find((x) => x.id === depId);
          worst = { name: depTask?.name ?? "a predecessor", end: depEntry.end };
        }
      }
    }
    return worst;
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const holidaySet = buildHolidaySet(holidays.map((h) => h.date));
  // Fallback only -- used to seed the very first task's default Start
  // (and the header display) before any task has its own Start date yet.
  const fallbackStartDate = project?.start_date ? project.start_date.slice(0, 10) : new Date().toISOString().slice(0, 10);

  // Parent tasks first, each followed immediately by its own sub-tasks --
  // same 2-level nesting the Projects table uses elsewhere. Relies on
  // `tasks` already coming back sorted by sort_order from the query above
  // (Sandra, 2026-07-24: "when adding task the new untitled task gets in
  // the middle of the task list" -- the query had no explicit order
  // clause before, so Postgres returned rows in whatever physical order
  // they happened to be stored in, NOT creation order. Explicit
  // `.order("sort_order")` fixes this the same way Projects.tsx's own
  // Tasks query already does).
  // Round 20 (Sandra: "grip movement works but only reflects upon
  // refresh -- if I move the bottom task one row above, it doesn't move
  // real time"). Root cause: this used to rely entirely on `tasks`
  // already arriving pre-sorted by `sort_order` from the initial fetch
  // (`.order("sort_order")` in loadAll) -- true on page load, but
  // `reorderTask`'s own optimistic `setTasks((prev) => prev.map(...))`
  // only updates each row's `sort_order` VALUE in place, it doesn't
  // reorder the underlying array itself, so the on-screen row order
  // didn't change until the next full reload re-fetched (and re-sorted)
  // from the DB. Sorting explicitly by `sort_order` here -- exactly like
  // the Projects & Tasks page's own table already does -- makes the
  // drop feel instant instead of needing a refresh, and is harmless on
  // page load too (the fetch is already sorted, so this is a no-op then).
  function computeOrderedTasks(): (TaskRow & { depth: number })[] {
    const bySortOrder = (a: TaskRow, b: TaskRow) => (a.sort_order ?? 0) - (b.sort_order ?? 0);
    const roots = tasks.filter((t) => !t.parent_task_id).sort(bySortOrder);
    const out: (TaskRow & { depth: number })[] = [];
    for (const r of roots) {
      out.push({ ...r, depth: 0 });
      for (const c of tasks.filter((t) => t.parent_task_id === r.id).sort(bySortOrder)) out.push({ ...c, depth: 1 });
    }
    return out;
  }
  const orderedTasks = computeOrderedTasks();

  function hasChildren(taskId: string): boolean {
    return tasks.some((t) => t.parent_task_id === taskId);
  }

  // Same rollup rule as the Projects & Tasks page -- a parent task's own
  // Est. hrs is locked and always mirrors the sum of its direct
  // sub-tasks' Est. hrs, never typed directly. Duplicated here (rather
  // than imported from Projects.tsx) since this page has its own separate
  // `tasks` state/query.
  function subtaskHoursSum(parentId: string): number | null {
    const children = tasks.filter((t) => t.parent_task_id === parentId);
    const withEstimate = children.filter((t) => t.estimated_hours !== null && t.estimated_hours !== undefined);
    if (withEstimate.length === 0) return null;
    return Math.round(withEstimate.reduce((sum, t) => sum + (t.estimated_hours ?? 0), 0) * 100) / 100;
  }

  // Same idea, for Start date -- a parent's own Start is locked and
  // mirrors the EARLIEST of its direct sub-tasks' own Start dates (its
  // End mirrors the latest, computed live in buildChain below since End
  // isn't a stored field until Save). Round 11: Start is now three
  // separate fields (legacy `start_date` for the rest of the app, plus
  // `start_date_full`/`start_date_standard` for each mode's own draft) --
  // this rolls up whichever field is asked for.
  function subtaskStartMinField(parentId: string, field: "start_date" | "start_date_full" | "start_date_standard"): string | null {
    const children = tasks.filter((t) => t.parent_task_id === parentId);
    const withStart = children.filter((t) => !!t[field]);
    if (withStart.length === 0) return null;
    return withStart.reduce((min, t) => {
      const v = (t[field] as string).slice(0, 10);
      return v < min ? v : min;
    }, (withStart[0][field] as string).slice(0, 10));
  }

  // Parent-task Assignee rollup (Sandra, 2026-07-28): a parent's own
  // Assignee used to be a fully independent field, decoupled from its
  // children -- same gap Est. hrs had before its own rollup. That's a
  // real double-counting risk for utilization: if a parent happened to
  // carry its own Assignee+Effort, its points landed on top of its
  // children's, even though the parent's own span is just the union of
  // theirs. Fixed the same way Est. hrs already works: derived, locked,
  // never typed directly. "Multiple" is a display-only state (children
  // assigned to 2+ different people) -- never written to `assignee_id`
  // itself, which stays null in that case (or null for zero-assignee
  // children too).
  function parentAssigneeState(parentId: string): { id: string | null; multiple: boolean } {
    const children = tasks.filter((t) => t.parent_task_id === parentId);
    const ids = Array.from(new Set(children.map((t) => t.assignee_id).filter((id): id is string => !!id)));
    if (ids.length === 1) return { id: ids[0], multiple: false };
    if (ids.length > 1) return { id: null, multiple: true };
    return { id: null, multiple: false };
  }

  useEffect(() => {
    for (const t of tasks) {
      if (t.parent_task_id) continue;
      if (!hasChildren(t.id)) continue;
      const sum = subtaskHoursSum(t.id);
      const minLegacy = subtaskStartMinField(t.id, "start_date");
      const minFull = subtaskStartMinField(t.id, "start_date_full");
      const minStandard = subtaskStartMinField(t.id, "start_date_standard");
      const patch: Partial<TaskRow> = {};
      if (sum !== t.estimated_hours) patch.estimated_hours = sum;
      if (minLegacy !== (t.start_date ? t.start_date.slice(0, 10) : null)) patch.start_date = minLegacy;
      if (minFull !== (t.start_date_full ? t.start_date_full.slice(0, 10) : null)) patch.start_date_full = minFull;
      if (minStandard !== (t.start_date_standard ? t.start_date_standard.slice(0, 10) : null)) patch.start_date_standard = minStandard;
      const { id: rolledUpAssignee } = parentAssigneeState(t.id);
      if (rolledUpAssignee !== t.assignee_id) patch.assignee_id = rolledUpAssignee;
      if (Object.keys(patch).length > 0) saveTaskField(t.id, patch);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  // Round 12 (Sandra): "when i change the est hours for a task ... the end
  // date of that task has moved, but the dependency date did not move
  // though a warning shown. Workaround for now was to manually tick and
  // untick the task dependency." Round 10/11's auto-move only ever fired
  // ONCE, at the moment a dependency was added -- editing the predecessor
  // afterward (more hours, a different Effort, its own Start moved) changed
  // ITS OWN End but never re-touched the dependent task's already-set
  // Start. Fixed by keeping each mode's Start "on auto-pilot"
  // (`start_full_auto`/`start_standard_auto`, migration 2026-07-24g) until
  // the user directly edits that field themselves (see `renderModeCells`'
  // onCommit below, which flips the flag off) -- while on auto-pilot, this
  // effect keeps re-deriving the suggested Start from the live chain (which
  // already recomputes on every render from current Est. hrs/Effort/Start)
  // and re-saves it the moment it drifts, no manual untick/retick needed
  // anymore. A task the user has manually overridden is left alone --
  // `dependencyConflict`'s existing warning icon is still the only signal
  // for that case, exactly as Sandra originally asked for.
  useEffect(() => {
    for (const t of tasks) {
      const depIds = dependsOnIdsFor(t.id);
      if (!depIds.length) continue;
      for (const mode of MODES) {
        const autoField = mode === "full_capacity" ? "start_full_auto" : "start_standard_auto";
        const startField = mode === "full_capacity" ? "start_date_full" : "start_date_standard";
        if (t[autoField] === false) continue; // manually overridden -- leave it, warning icon covers this
        const suggested = suggestedStartFor(depIds, mode);
        const current = t[startField] ? (t[startField] as string).slice(0, 10) : null;
        if (suggested && suggested !== current) {
          saveTaskField(t.id, { [startField]: suggested } as Partial<TaskRow>);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, dependencies]);

  function nextWorkingDayAfter(dateStr: string, holidays: HolidaySet): string {
    let d = addDays(parseLocalDate(dateStr), 1);
    while (!isWorkingDay(d, holidays)) d = addDays(d, 1);
    return toISO(d);
  }

  // Per-task, per-mode End-date calculator -- a task's own Start date
  // (stored, freely editable) plus its Estimated hours, run through
  // whichever mode's flat daily rate. Deliberately independent of every
  // other task (Sandra confirmed: simpler, predictable, lets tasks
  // genuinely overlap/parallelize -- the utilization heat-map below is
  // where over-allocation actually shows up, not a scheduling
  // constraint here).
  function computeEntry(t: TaskRow, mode: Mode): ChainEntry | null {
    const hours = t.estimated_hours;
    const rawStart = mode === "full_capacity" ? t.start_date_full : t.start_date_standard;
    const start = rawStart ? rawStart.slice(0, 10) : null;
    if (hours === null || hours === undefined || !start) return null;
    const scenario = mode === "full_capacity" ? fullCapacityScenario : standardScenario;
    const r = scenario(hours, start, holidaySet);
    return { start, end: r.dueDate, durationDays: r.wholeDays, rawDays: r.rawDays };
  }

  // Builds the full per-mode map: leaf tasks computed directly from their
  // own Start date; a parent task's entry is then derived as the
  // min(start)/max(end) span across its own sub-tasks (never computed
  // from its own Start field directly, same as Est. hrs).
  function buildChain(mode: Mode): Map<string, ChainEntry | null> {
    const result = new Map<string, ChainEntry | null>();
    for (const t of orderedTasks) {
      if (t.depth === 0 && hasChildren(t.id)) continue; // parents handled below
      result.set(t.id, computeEntry(t, mode));
    }
    for (const t of orderedTasks) {
      if (t.depth !== 0 || !hasChildren(t.id)) continue;
      const children = orderedTasks.filter((c) => c.depth === 1 && c.parent_task_id === t.id);
      const entries = children.map((c) => result.get(c.id)).filter((e): e is ChainEntry => !!e);
      if (entries.length === children.length && entries.length > 0) {
        const start = entries.reduce((min, e) => (e.start < min ? e.start : min), entries[0].start);
        const end = entries.reduce((max, e) => (e.end > max ? e.end : max), entries[0].end);
        const durationDays = workingDaysBetween(parseLocalDate(start), parseLocalDate(end), holidaySet).length;
        result.set(t.id, { start, end, durationDays });
      } else {
        result.set(t.id, null);
      }
    }
    return result;
  }

  const fullChain = buildChain("full_capacity");
  const standardChain = buildChain("standard");
  const chainByMode: Record<Mode, Map<string, ChainEntry | null>> = {
    full_capacity: fullChain,
    standard: standardChain,
  };

  // Phase 2 (2026-07-28): builds the exact per-task snapshot the
  // lock/apply/decide RPCs persist. Deliberately reuses the SAME
  // fullChain/standardChain maps already computed above for the on-screen
  // table -- rather than recomputing scheduling in SQL (which would
  // duplicate refreshDates'/computeEntry's real business logic in two
  // places and risk drift), the RPC just persists whatever is already
  // showing on screen at the moment of Lock/Apply/Close.
  function buildTaskSnapshotPayload() {
    return orderedTasks.map((t) => {
      const fullEntry = fullChain.get(t.id);
      const standardEntry = standardChain.get(t.id);
      return {
        task_id: t.id,
        parent_task_id: t.parent_task_id,
        name: t.name,
        estimated_hours: t.estimated_hours,
        assignee_name: people.find((p) => p.id === t.assignee_id)?.name ?? null,
        effort: t.effort,
        depends_on: dependsOnIdsFor(t.id),
        start_date_full: fullEntry?.start ?? null,
        end_date_full: fullEntry?.end ?? null,
        start_date_standard: standardEntry?.start ?? null,
        end_date_standard: standardEntry?.end ?? null,
      };
    });
  }

  async function handleLockBaseline() {
    if (!project) return;
    if (orderedTasks.length === 0) {
      await alert("Add at least one task before locking a baseline.");
      return;
    }
    if (
      !(await confirm(
        `Lock ${MODE_LABEL[activeMode]} as this project's Baseline?\n\nThis records the current plan as the official commitment. The page becomes read-only until you Start a Revision.`
      ))
    )
      return;
    setWorkflowBusy(true);
    const { error } = await supabase.rpc("lock_wbs_baseline", {
      p_project_id: project.id,
      p_mode: activeMode,
      p_reason: null,
      p_tasks: buildTaskSnapshotPayload(),
    });
    setWorkflowBusy(false);
    if (error) {
      await alert(`Couldn't lock baseline: ${error.message}`);
      return;
    }
    await loadAll();
  }

  async function handleStartRevision() {
    if (!project) return;
    if (!(await confirm("Start a revision on this project? This unlocks editing until you Apply or Discard the revision."))) return;
    setWorkflowBusy(true);
    const { error } = await supabase.rpc("start_wbs_revision", { p_project_id: project.id, p_reason: "Revision started from WBS page" });
    setWorkflowBusy(false);
    if (error) {
      await alert(`Couldn't start revision: ${error.message}`);
      return;
    }
    await loadAll();
  }

  async function handleApplyRevision() {
    if (!project || !activeRevision) return;
    if (!(await confirm(`Apply this revision? This re-locks the project as the new Current Plan (status becomes Changed After Baseline).`))) return;
    setWorkflowBusy(true);
    const { error } = await supabase.rpc("apply_wbs_revision", {
      p_revision_id: activeRevision.id,
      p_tasks: buildTaskSnapshotPayload(),
    });
    setWorkflowBusy(false);
    if (error) {
      await alert(`Couldn't apply revision: ${error.message}`);
      return;
    }
    await loadAll();
  }

  async function handleDiscardRevision() {
    if (!project || !activeRevision) return;
    if (
      !(await confirm(
        `Discard this revision? Every change made since Start Revision -- edited tasks, added tasks, removed tasks -- will be undone back to how it was before. This cannot be undone.`
      ))
    )
      return;
    setWorkflowBusy(true);
    const { error } = await supabase.rpc("discard_wbs_revision", { p_revision_id: activeRevision.id });
    setWorkflowBusy(false);
    if (error) {
      await alert(`Couldn't discard revision: ${error.message}`);
      return;
    }
    await loadAll();
  }

  // Phase 5 (2026-07-28): re-baselining -- promotes the CURRENT plan to be
  // the new official Baseline once drift from the original has grown large
  // enough that comparing against it isn't useful any more. No task
  // snapshot to build here (see rebaseline_wbs_plan's own comment): the RPC
  // sources straight from the latest already-persisted plan version.
  async function handleRebaseline() {
    if (!project) return;
    if (
      !(await confirm(
        `Re-baseline "${project.name}"? This promotes the current plan to be the new official Baseline -- the old Baseline is kept in history but Compare with Baseline and variance tracking will measure against this new one going forward.`
      ))
    )
      return;
    setWorkflowBusy(true);
    const { error } = await supabase.rpc("rebaseline_wbs_plan", { p_project_id: project.id, p_reason: "Re-baselined from WBS page" });
    setWorkflowBusy(false);
    if (error) {
      await alert(`Couldn't re-baseline: ${error.message}`);
      return;
    }
    await loadAll();
  }

  async function handleRequestClosure() {
    if (!project) return;
    if (!(await confirm(`Request closure for "${project.name}"? This asks an approver to lock in the current plan as Final Scope.`))) return;
    setWorkflowBusy(true);
    const { error } = await supabase.rpc("request_wbs_closure", { p_project_id: project.id });
    setWorkflowBusy(false);
    if (error) {
      await alert(`Couldn't request closure: ${error.message}`);
      return;
    }
    await loadAll();
  }

  async function handleDecideClosure(approve: boolean) {
    if (!project || !pendingClosure) return;
    if (!(await confirm(approve ? "Approve this closure? This locks in the current plan as Final Scope -- final, no re-opening." : "Reject this closure request?"))) return;
    setWorkflowBusy(true);
    const { error } = await supabase.rpc("decide_wbs_closure", {
      p_request_id: pendingClosure.id,
      p_approve: approve,
      p_reason: null,
      p_tasks: buildTaskSnapshotPayload(),
    });
    setWorkflowBusy(false);
    if (error) {
      await alert(`Couldn't decide closure: ${error.message}`);
      return;
    }
    await loadAll();
  }

  // Round 11 (Sandra): the project's own Start date is now MANUAL again --
  // "the user can plot the start onset in the top bar. Start will no
  // longer depend on the earliest start of task." Reversing the earlier
  // "derived from earliest task Start" model was necessary once Full
  // Effort and Conservative Effort got their own independent Start
  // fields below -- there's no longer one single "earliest task start" to
  // derive from anyway (Full's earliest and Conservative's earliest can
  // differ). `project.start_date` is just a plain editable anchor now,
  // used as the fallback Start for the very first task in each mode's
  // chain when there's nothing earlier to chain from.
  const utilAnchorDate = fallbackStartDate;

  // Fixed 2026-07-24 (Sandra: "fix the glitch when adding task in WBS") --
  // the old default-Start logic for a new task only ever looked at the
  // LITERAL last task in the list, which is almost always the most
  // recently added "Untitled task" itself -- with no Est. hrs yet, its
  // chain entry is null, so every SUBSEQUENT new task silently fell back
  // to the project's own Start date instead of chaining after whichever
  // task actually has a real schedule. Walking backwards for the last
  // task that resolves to a real entry fixes this -- blank placeholder
  // rows in between no longer break the chain. Round 11: mode-parameterized
  // now that Full Effort and Conservative Effort each need their own
  // independent "what did the last real task end on" answer.
  function lastResolvedEntry(list: (TaskRow & { depth: number })[], mode: Mode): ChainEntry | null {
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = chainByMode[mode].get(list[i].id);
      if (entry) return entry;
    }
    return null;
  }

  async function addTopLevelTask() {
    if (!project) return;
    const today = new Date().toISOString().slice(0, 10);
    const roots = orderedTasks.filter((t) => t.depth === 0);
    const anchor = project.start_date ? project.start_date.slice(0, 10) : fallbackStartDate;
    let defaultStartFull = anchor;
    let defaultStartStandard = anchor;
    const entryFull = lastResolvedEntry(roots, "full_capacity");
    if (entryFull) defaultStartFull = nextWorkingDayAfter(entryFull.end, holidaySet);
    const entryStandard = lastResolvedEntry(roots, "standard");
    if (entryStandard) defaultStartStandard = nextWorkingDayAfter(entryStandard.end, holidaySet);
    const defaultDue = project.end_date ?? today;
    const { error } = await supabase.from("tasks").insert({
      project_id: project.id,
      name: "Untitled task",
      status: "Not Started",
      start_date: defaultStartFull, // legacy single field -- convenience placeholder for other pages until Save
      start_date_full: defaultStartFull,
      start_date_standard: defaultStartStandard,
      start_full_auto: true,
      start_standard_auto: true,
      original_due_date: defaultDue,
      current_due_date: defaultDue,
      sort_order: Date.now(),
    });
    if (error) {
      await alert(`Couldn't create task: ${error.message}`);
      return;
    }
    loadAll();
  }

  async function addSubtask(parent: TaskRow & { depth: number }) {
    if (parent.depth > 0) return; // only 2 layers total: parent + 1 sub-task level
    const siblings = orderedTasks.filter((t) => t.depth === 1 && t.parent_task_id === parent.id);
    const projectAnchor = project?.start_date ? project.start_date.slice(0, 10) : fallbackStartDate;
    let defaultStartFull = parent.start_date_full ? parent.start_date_full.slice(0, 10) : projectAnchor;
    let defaultStartStandard = parent.start_date_standard ? parent.start_date_standard.slice(0, 10) : projectAnchor;
    const siblingEntryFull = lastResolvedEntry(siblings, "full_capacity");
    if (siblingEntryFull) defaultStartFull = nextWorkingDayAfter(siblingEntryFull.end, holidaySet);
    const siblingEntryStandard = lastResolvedEntry(siblings, "standard");
    if (siblingEntryStandard) defaultStartStandard = nextWorkingDayAfter(siblingEntryStandard.end, holidaySet);
    const { error } = await supabase.from("tasks").insert({
      project_id: parent.project_id,
      parent_task_id: parent.id,
      name: "Untitled sub-task",
      status: "Not Started",
      start_date: defaultStartFull,
      start_date_full: defaultStartFull,
      start_date_standard: defaultStartStandard,
      start_full_auto: true,
      start_standard_auto: true,
      original_due_date: parent.current_due_date,
      current_due_date: parent.current_due_date,
      sort_order: Date.now(),
    });
    if (error) {
      await alert(`Couldn't add subtask: ${error.message}`);
      return;
    }
    loadAll();
  }

  // Sandra, 2026-07-24: "Allow deleting of tasks in WBS. Right now we can
  // add but no option to delete." Mirrors Projects.tsx's own bulk-delete
  // convention exactly -- same `delete_tasks_and_dependents` RPC (already
  // clears task_dependencies in both FK directions as of this same
  // round's migration, see [[project_capaciq_wbs_planning]]), same
  // "deleting a parent also deletes its own sub-tasks" bundling, same
  // hard-delete confirm copy (tasks are always hard-deleted on this page,
  // never soft-archived -- only Projects get the 30-day archive/restore
  // treatment).
  async function deleteTask(t: TaskRow & { depth: number }) {
    const childIds = t.depth === 0 ? tasks.filter((x) => x.parent_task_id === t.id).map((x) => x.id) : [];
    const allIds = [t.id, ...childIds];
    const ok = await confirm({
      title: "Delete task",
      message: `Delete "${t.name}"${childIds.length ? ` (and ${childIds.length} sub-task${childIds.length > 1 ? "s" : ""})` : ""}? This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    const { error } = await supabase.rpc("delete_tasks_and_dependents", { p_task_ids: allIds });
    if (error) {
      await alert(`Couldn't delete: ${error.message}`);
      return;
    }
    loadAll();
  }

  // Drag-reorder within siblings only -- see draggedTaskId comment above.
  // Purely reassigns sort_order (evenly spaced so future inserts/drags
  // have room); never touches any date field.
  function siblingsFor(t: TaskRow & { depth: number }): (TaskRow & { depth: number })[] {
    return t.depth === 0 ? orderedTasks.filter((x) => x.depth === 0) : orderedTasks.filter((x) => x.depth === 1 && x.parent_task_id === t.parent_task_id);
  }

  async function reorderTask(draggedId: string, targetId: string) {
    if (draggedId === targetId) return;
    const dragged = orderedTasks.find((x) => x.id === draggedId);
    const target = orderedTasks.find((x) => x.id === targetId);
    if (!dragged || !target) return;
    if (dragged.depth !== target.depth || dragged.parent_task_id !== target.parent_task_id) return; // different group -- ignore
    const group = siblingsFor(dragged);
    const withoutDragged = group.filter((x) => x.id !== draggedId);
    const targetIndex = withoutDragged.findIndex((x) => x.id === targetId);
    const reordered = [...withoutDragged.slice(0, targetIndex), dragged, ...withoutDragged.slice(targetIndex)];
    const updates = reordered.map((x, i) => ({ id: x.id, sort_order: (i + 1) * 1000 }));
    setTasks((prev) =>
      prev.map((x) => {
        const u = updates.find((uu) => uu.id === x.id);
        return u ? { ...x, sort_order: u.sort_order } : x;
      })
    );
    for (const u of updates) {
      await supabase.from("tasks").update({ sort_order: u.sort_order }).eq("id", u.id);
    }
  }

  // "Refresh dates" (Sandra, 2026-07-28): the grip-handle reorder above is
  // purely visual -- it doesn't recompute anyone's Start. This button
  // re-seeds Start for every task still on "auto pilot" (not manually
  // overridden) to a fresh, internally-consistent schedule: a task with a
  // "Depends on" link starts the day after that dependency's (freshly
  // recomputed) End; a task with no dependency chains after the previous
  // task in schedule order, same default-seeding math `addTopLevelTask`/
  // `addSubtask` already use for a brand-new task. Root tasks chain among
  // other root tasks; a parent's own sub-tasks chain only among their own
  // siblings (mirrors buildChain's own two-tier structure).
  async function refreshDates() {
    // Round 17 bugfix (Sandra): repeated clicks kept pushing tasks further
    // out. Round 17's first fix just froze any task that was itself a
    // dependency TARGET (e.g. "New Task Insert", depended on by "Task 3
    // Sub 1") -- stable, but frozen at whatever stale value it already
    // had, which is exactly why Task 3's whole branch kept showing
    // October dates that didn't trace back to anything on screen.
    //
    // Round 18 (this fix, Sandra: "check start and end dates... it's not
    // making sense anymore"): the real problem was re-chaining ROOT tasks
    // in raw LIST order while a "Depends on" link can point in a
    // different structural direction than that list order (a task can
    // depend on something listed AFTER it). Rather than freezing the
    // predecessor, schedule ROOT-level groups in an order that respects
    // BOTH constraints: whatever a group's members depend on (via an
    // explicit "Depends on" link crossing into another group) must be
    // computed first, before that group itself, regardless of row
    // position; ties break by the existing row order. Dependency-driven
    // tasks (a child or root with a real "Depends on" link) then get
    // their Start recomputed from that predecessor's freshly-computed End
    // in THIS SAME PASS -- not left frozen -- so Refresh always produces
    // one coherent, non-circular schedule instead of silently reusing
    // whatever value happened to be sitting in the DB before.
    const patches = new Map<string, Partial<TaskRow>>();
    function patchFor(id: string): Partial<TaskRow> {
      const existing = patches.get(id) ?? {};
      patches.set(id, existing);
      return existing;
    }
    // Any task id -> the id of its own top-level root ancestor (itself if
    // it already is one) -- used to compare a dependency's target against
    // which ROOT GROUP it structurally belongs to.
    function rootIdOf(taskId: string): string {
      const t = orderedTasks.find((x) => x.id === taskId);
      if (!t) return taskId;
      return t.depth === 0 ? t.id : t.parent_task_id ?? t.id;
    }
    const roots = orderedTasks.filter((x) => x.depth === 0);
    // Root-level dependency graph: rootId -> set of OTHER root ids it (or
    // any of its own sub-tasks) has a real "Depends on" link into.
    const rootDeps = new Map<string, Set<string>>();
    for (const root of roots) {
      const members = hasChildren(root.id)
        ? [root, ...orderedTasks.filter((c) => c.depth === 1 && c.parent_task_id === root.id)]
        : [root];
      const depSet = new Set<string>();
      for (const m of members) {
        for (const depId of dependsOnIdsFor(m.id)) {
          const depRoot = rootIdOf(depId);
          if (depRoot !== root.id) depSet.add(depRoot);
        }
      }
      rootDeps.set(root.id, depSet);
    }
    // Topological order over root groups (dependency targets first),
    // falling back to original row order whenever nothing is blocking (or
    // to break an unresolved cycle, so this can never hang).
    const scheduleOrder: typeof roots = [];
    const placed = new Set<string>();
    while (scheduleOrder.length < roots.length) {
      let pick = roots.find(
        (r) => !placed.has(r.id) && [...(rootDeps.get(r.id) ?? [])].every((d) => placed.has(d))
      );
      if (!pick) pick = roots.find((r) => !placed.has(r.id));
      if (!pick) break;
      scheduleOrder.push(pick);
      placed.add(pick.id);
    }
    for (const mode of MODES) {
      const startField = mode === "full_capacity" ? "start_date_full" : "start_date_standard";
      const autoField = mode === "full_capacity" ? "start_full_auto" : "start_standard_auto";
      const scenario = mode === "full_capacity" ? fullCapacityScenario : standardScenario;
      function entryWithOverride(t: TaskRow, overrideStart?: string): ChainEntry | null {
        if (!overrideStart) return computeEntry(t, mode);
        if (t.estimated_hours === null || t.estimated_hours === undefined) return null;
        const r = scenario(t.estimated_hours, overrideStart, holidaySet);
        return { start: overrideStart, end: r.dueDate, durationDays: r.wholeDays, rawDays: r.rawDays };
      }
      // Entries computed so far THIS pass, keyed by task id (root ids and
      // child ids alike) -- lets a dependency lookup see a predecessor's
      // brand-new End even when that predecessor is being recomputed in
      // this very same Refresh click.
      const entries = new Map<string, ChainEntry>();
      // Round 19 (Sandra: "Refresh dates does not reset the first task on
      // the list to follow the start date set in the project details"):
      // the very first task in the whole schedule had nothing to chain
      // from (`chainPrev` null), so it always fell back to whatever its
      // OWN stored Start field already was -- silently ignoring the
      // project's own Start date field entirely, even though
      // `addTopLevelTask`/`addSubtask` already treat that field as the
      // anchor for a brand-new first task. `anchorStart` now plays that
      // same role inside Refresh: only used the one time there's truly
      // nothing earlier (first root, or first child of the first root
      // group) to chain from.
      const projectAnchor = project?.start_date ? project.start_date.slice(0, 10) : fallbackStartDate;
      function scheduledEntry(t: TaskRow, chainPrev: ChainEntry | null, anchorStart?: string): ChainEntry | null {
        const depIds = dependsOnIdsFor(t.id);
        const isAuto = t[autoField] !== false;
        let overrideStart: string | undefined;
        if (depIds.length && isAuto) {
          let latest: string | null = null;
          for (const depId of depIds) {
            const depEntry = entries.get(depId);
            if (!depEntry) continue;
            const candidate = nextWorkingDayAfter(depEntry.end, holidaySet);
            if (!latest || candidate > latest) latest = candidate;
          }
          if (latest) overrideStart = latest;
        } else if (!depIds.length && isAuto) {
          if (chainPrev) overrideStart = nextWorkingDayAfter(chainPrev.end, holidaySet);
          else if (anchorStart) overrideStart = anchorStart;
        }
        const entry = entryWithOverride(t, overrideStart);
        if (overrideStart && entry) (patchFor(t.id) as Record<string, unknown>)[startField] = overrideStart;
        return entry;
      }
      let lastRootEntry: ChainEntry | null = null;
      for (const root of scheduleOrder) {
        const isFirstGroup = lastRootEntry === null;
        if (hasChildren(root.id)) {
          let lastSiblingEntry: ChainEntry | null = null;
          const children = orderedTasks.filter((c) => c.depth === 1 && c.parent_task_id === root.id);
          const childEntries: ChainEntry[] = [];
          for (const child of children) {
            const isFirstChild = lastSiblingEntry === null;
            const entry = scheduledEntry(child, lastSiblingEntry, isFirstGroup && isFirstChild ? projectAnchor : undefined);
            if (entry) {
              entries.set(child.id, entry);
              lastSiblingEntry = entry;
              childEntries.push(entry);
            }
          }
          if (childEntries.length) {
            const start = childEntries.reduce((min, e) => (e.start < min ? e.start : min), childEntries[0].start);
            const end = childEntries.reduce((max, e) => (e.end > max ? e.end : max), childEntries[0].end);
            const groupEntry = { start, end, durationDays: 0 };
            entries.set(root.id, groupEntry);
            lastRootEntry = groupEntry;
          }
        } else {
          const entry = scheduledEntry(root, lastRootEntry, isFirstGroup ? projectAnchor : undefined);
          if (entry) {
            entries.set(root.id, entry);
            lastRootEntry = entry;
          }
        }
      }
    }
    if (patches.size === 0) {
      await alert("Nothing to refresh -- every task's Start is either manually set or already tracking a dependency.");
      return;
    }
    for (const [id, patch] of patches) {
      await saveTaskField(id, patch);
    }
  }

  async function saveTaskField(taskId: string, patch: Partial<TaskRow>) {
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, ...patch } : t)));
    const { error } = await supabase.from("tasks").update(patch).eq("id", taskId);
    if (error) {
      await alert(`Couldn't save: ${error.message}`);
      loadAll();
    }
  }

  async function saveProjectField(patch: Partial<ProjectRow>) {
    if (!project) return;
    setProject((prev) => (prev ? { ...prev, ...patch } : prev));
    const { error } = await supabase.from("projects").update(patch).eq("id", project.id);
    if (error) {
      await alert(`Couldn't save: ${error.message}`);
      loadAll();
    }
  }

  // Soft completeness gate -- mirrors the Task name / Effort part of the
  // Projects table's own Lock policy. Round 11: conflict check now covers
  // BOTH modes always (not just whichever is toggled active), since the
  // scoping table itself shows both modes' Start/End side by side
  // regardless of the toggle now.
  function softIssues(): string[] {
    const issues: string[] = [];
    const noName = orderedTasks.filter((t) => !t.name || !t.name.trim() || t.name === "Untitled task" || t.name === "Untitled sub-task");
    const noEffort = orderedTasks.filter((t) => !t.effort && !(t.depth === 0 && hasChildren(t.id)));
    const conflicted = orderedTasks.filter((t) => dependencyConflict(t, "full_capacity") || dependencyConflict(t, "standard"));
    if (noName.length) issues.push(`${noName.length} task(s) still have a placeholder name.`);
    if (noEffort.length) issues.push(`${noEffort.length} task(s) still need an Effort level.`);
    if (conflicted.length)
      issues.push(`${conflicted.length} task(s) start on or before a dependency's own End under at least one mode -- double-check those Start dates.`);
    return issues;
  }

  // Total effort for the whole project -- summed from top-level tasks
  // only (a parent's own Est. hrs already mirrors the sum of its
  // sub-tasks via the rollup effect above).
  const totalEffortHours = Math.round(
    orderedTasks
      .filter((t) => t.depth === 0)
      .reduce((sum, t) => sum + (t.estimated_hours ?? 0), 0) * 100
  ) / 100;

  // Project-level projected span under a given mode: earliest Start /
  // latest End among every task's entry in that mode's chain.
  function chainOverallSummary(chain: Map<string, ChainEntry | null>): { start: string | null; end: string | null; durationDays: number; complete: boolean } {
    let start: string | null = null;
    let end: string | null = null;
    let complete = true;
    for (const t of orderedTasks) {
      const entry = chain.get(t.id);
      if (!entry) {
        complete = false;
        continue;
      }
      if (!start || entry.start < start) start = entry.start;
      if (!end || entry.end > end) end = entry.end;
    }
    const durationDays = start && end ? workingDaysBetween(parseLocalDate(start), parseLocalDate(end), holidaySet).length : 0;
    return { start, end, durationDays, complete };
  }

  async function saveDraft() {
    if (!project || !projectId) return;

    const chosenChain = chainByMode[activeMode];
    const unresolved = orderedTasks.filter((t) => !chosenChain.get(t.id));
    if (unresolved.length) {
      await alert(
        `Can't save ${MODE_LABEL[activeMode]} yet -- ${unresolved.length} task(s) don't have a schedule under it. Add a Start date and Estimated hours for every task first.`
      );
      return;
    }

    const issues = softIssues();
    if (issues.length && !isFullAccess) {
      await alert(`Can't save yet:\n\n${issues.join("\n")}`);
      return;
    }
    if (issues.length && isFullAccess) {
      if (!(await confirm(`${issues.join("\n")}\n\nFull Access override: save anyway?`))) return;
    }

    const verb = MODE_LABEL[activeMode];
    const applyingRevision = project.wbs_status === "revision_in_progress" && !!activeRevision;
    const confirmMsg = applyingRevision
      ? `Save this project's timelines using ${verb}?\n\nThis writes every task's computed End date, records both modes for reporting, AND applies this revision -- the project re-locks as the new Current Plan (status becomes Changed After Baseline).`
      : `Save this project's timelines using ${verb}?\n\nThis writes every task's computed End date (Start dates are already saved per-task) and records both modes for reporting. Nothing is locked yet -- lock a Baseline or start/apply a Revision from the actions above when you're ready.`;
    if (!(await confirm(confirmMsg))) return;

    setSaving(true);
    try {
      const batchId = crypto.randomUUID();
      for (const t of orderedTasks) {
        const chosen = chosenChain.get(t.id);
        if (!chosen) continue;

        const patch: Partial<TaskRow> = { start_date: chosen.start, current_due_date: chosen.end };
        await supabase.from("tasks").update(patch).eq("id", t.id);
        setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, ...patch } : x)));

        const snapshotRows = MODES.map((m) => ({ m, entry: chainByMode[m].get(t.id) }))
          .filter((x): x is { m: Mode; entry: ChainEntry } => !!x.entry)
          .map(({ m, entry }) => ({
            task_id: t.id,
            finalize_batch_id: batchId,
            mode: m,
            applied: m === activeMode,
            target_start_date: entry.start,
            person_id: null,
            raw_days: entry.rawDays ?? null,
            whole_days: entry.durationDays,
            computed_due_date: entry.end,
            computed_by: me?.id ?? null,
          }));
        if (snapshotRows.length) await supabase.from("task_planning_snapshots").insert(snapshotRows);
      }
      await supabase.from("projects").update({ scoping_effort_mode: activeMode }).eq("id", project.id);

      // Sandra, 2026-07-29: "Make Save also apply the revision" -- saving
      // mid-revision now also calls apply_wbs_revision so Save re-locks
      // the project in one step instead of needing a separate Apply click.
      if (applyingRevision && activeRevision) {
        const { error } = await supabase.rpc("apply_wbs_revision", {
          p_revision_id: activeRevision.id,
          p_tasks: buildTaskSnapshotPayload(),
        });
        if (error) {
          await alert(`Timelines were saved, but the revision couldn't be applied: ${error.message}`);
          await loadAll();
          return;
        }
        await loadAll();
        await alert(`Saved and applied using ${verb}. This revision is now locked in as the Current Plan.`);
        return;
      }

      await loadAll();
      await alert(`Saved using ${verb}. Nothing is locked yet -- lock a Baseline or start/apply a Revision from the actions above when ready.`);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>Loading…</div>;
  if (!project) return <div style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>Project not found.</div>;

  // Phase 2/3 authorization -- mirrors can_manage_wbs()/can_decide_closure()
  // on the DB side (flat tiering, Sandra 2026-07-28): Full Access or the
  // project's own owner can drive Lock/Revision/Closure-request; closure
  // DECISIONS additionally open up to anyone flagged can_approve_closures.
  const canManageWbs = isFullAccess || me?.id === project.owner_id;
  const canDecideClosure = isFullAccess || !!me?.can_approve_closures || me?.id === project.owner_id;
  // Sandra, 2026-07-29: locked/closed no longer means "show nothing" --
  // the whole content section below now always renders; this flag just
  // switches every InlineText/InlineSelect/InlineDate/InlineNumber in it
  // (plus add/delete/reorder/dependency controls) between editable and a
  // greyed, disabled read-only look. Only Draft and an in-progress
  // Revision allow edits -- Baseline Locked/Changed After Baseline/Closed
  // are all view-only.
  const canEditWbs = project.wbs_status === "draft" || project.wbs_status === "revision_in_progress";

  // Design spec item 7 (Sandra, 2026-07-29): group the latest applied
  // revision's changes by task_id for the task list's Changes/Notes
  // columns, and reduce them into aggregate counts for the Revision
  // Summary panel -- see loadLatestRevisionChanges() above for how this
  // is fetched. change_type values come straight from the
  // project_revision_changes CHECK constraint (phase1_migration.sql):
  // task_added/task_removed/hours_changed/date_changed/
  // dependency_changed/assignee_changed.
  const CHANGE_DOT_COLOR: Record<string, string> = {
    task_added: "#3f9d6e",
    hours_increased: "#3f9d6e",
    hours_decreased: "#c1443c",
    date_changed: "#b8860b",
    dependency_changed: "#7b4fb0",
    assignee_changed: "#2e75b6",
  };
  function taskChangeKind(c: RevisionChangeRow): keyof typeof CHANGE_DOT_COLOR | null {
    if (c.change_type === "task_added") return "task_added";
    if (c.change_type === "hours_changed") {
      const prev = Number(c.previous_value ?? 0);
      const next = Number(c.new_value ?? 0);
      return next > prev ? "hours_increased" : "hours_decreased";
    }
    if (c.change_type === "date_changed") return "date_changed";
    if (c.change_type === "dependency_changed") return "dependency_changed";
    if (c.change_type === "assignee_changed") return "assignee_changed";
    return null;
  }
  // Design spec item 4 (Sandra, 2026-07-29 follow-up): per-task diff
  // against the active Baseline V<n> snapshot -- this is what actually
  // drives the task list's Changes/Notes columns now (see her reference
  // mockup screenshot: "Changes vs Baseline V1" + a Notes column, NOT the
  // latest-revision log). Reuses the same CHANGE_DOT_COLOR palette/legend
  // as the revision-log-based Revision Summary panel below for visual
  // consistency, even though the two now read from different sources.
  function taskBaselineDiff(t: TaskRow & { depth: number }, isParent: boolean): { isNew: boolean; kinds: (keyof typeof CHANGE_DOT_COLOR)[]; notes: string[] } {
    const baseline = baselineTasksById[t.id];
    if (!baseline) {
      return { isNew: true, kinds: ["task_added"], notes: ["New task"] };
    }
    const kinds: (keyof typeof CHANGE_DOT_COLOR)[] = [];
    const notes: string[] = [];

    if (!isParent) {
      const currentHours = t.estimated_hours ?? 0;
      const baseHours = baseline.estimated_hours ?? 0;
      if (currentHours !== baseHours) {
        const delta = currentHours - baseHours;
        if (delta > 0) {
          kinds.push("hours_increased");
          notes.push(`+${delta}h`);
        } else {
          kinds.push("hours_decreased");
          notes.push(`${delta}h`);
        }
      }
    }

    const currentEnd = chainByMode.full_capacity.get(t.id)?.end;
    if (currentEnd && baseline.end_date_full && currentEnd !== baseline.end_date_full) {
      const deltaDays = Math.round((parseLocalDate(currentEnd).getTime() - parseLocalDate(baseline.end_date_full).getTime()) / 86400000);
      kinds.push("date_changed");
      notes.push(`${deltaDays > 0 ? "+" : ""}${deltaDays}d`);
    }

    const currentAssigneeName = people.find((p) => p.id === t.assignee_id)?.name ?? null;
    if ((currentAssigneeName ?? null) !== (baseline.assignee_name ?? null)) {
      kinds.push("assignee_changed");
      notes.push("Assignee changed");
    }

    const currentDeps = [...dependsOnIdsFor(t.id)].sort();
    const baseDeps = [...(baseline.depends_on ?? [])].sort();
    if (JSON.stringify(currentDeps) !== JSON.stringify(baseDeps)) {
      kinds.push("dependency_changed");
      notes.push("Dependency changed");
    }

    return { isNew: false, kinds, notes };
  }

  const revisionSummary = {
    tasksAdded: latestRevisionChanges.filter((c) => c.change_type === "task_added").length,
    tasksRemoved: latestRevisionChanges.filter((c) => c.change_type === "task_removed").length,
    hoursIncreased: latestRevisionChanges.filter((c) => taskChangeKind(c) === "hours_increased").length,
    hoursDecreased: latestRevisionChanges.filter((c) => taskChangeKind(c) === "hours_decreased").length,
    datesChanged: latestRevisionChanges.filter((c) => c.change_type === "date_changed").length,
    dependenciesChanged: latestRevisionChanges.filter((c) => c.change_type === "dependency_changed").length,
    assigneesChanged: latestRevisionChanges.filter((c) => c.change_type === "assignee_changed").length,
    totalAddedHours: latestRevisionChanges
      .filter((c) => c.change_type === "hours_changed")
      .reduce((sum, c) => sum + (Number(c.new_value ?? 0) - Number(c.previous_value ?? 0)), 0),
  };

  // Design spec item 3 (Sandra, 2026-07-29 follow-up): the task list's
  // Full Effort/Conservative Effort column tint now follows utilPreviewMode
  // (the toggle inside the Utilization snapshot section) instead of
  // activeMode (the Scoping Effort/Save selector) -- so the two stay
  // visually linked without duplicating the control itself, per the
  // original design spec item 3.
  function modeColStyle(m: Mode): CSSProperties {
    return m === utilPreviewMode ? { background: "#eaf1fb" } : {};
  }

  // A visible box around the header's editable fields (Project name,
  // Owner) -- Sandra: "make it evident that thos fields needs to be
  // filled." Plain `.inline-cell` inputs only show a border on
  // hover/focus, so an empty one (no Owner picked yet) looked
  // indistinguishable from static text. A permanent, subtle border makes
  // clear these are fillable fields even at rest; an unfilled field gets
  // a dashed border in the muted/warning tone as a nudge to fill it in.
  function fieldBoxStyle(isFilled: boolean, minWidth = 110, locked = false): CSSProperties {
    if (locked) {
      return {
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: "1px 4px",
        minWidth,
        background: "var(--surface-muted, #f3f4f6)",
        color: "var(--muted)",
      };
    }
    return {
      border: `1px ${isFilled ? "solid" : "dashed"} ${isFilled ? "var(--border)" : "var(--warning-text, #b45309)"}`,
      borderRadius: 6,
      padding: "1px 4px",
      minWidth,
      background: "var(--surface)",
    };
  }

  // Round 11: each mode now renders its OWN Start cell (editable, with its
  // own conflict warning) alongside End/Duration -- replaces the old
  // single shared Start column entirely. `field` picks which of the two
  // per-mode columns this cell reads/writes.
  function renderModeCells(t: TaskRow & { depth: number }, mode: Mode, isParent: boolean) {
    const field = mode === "full_capacity" ? "start_date_full" : "start_date_standard";
    const autoField = mode === "full_capacity" ? "start_full_auto" : "start_standard_auto";
    const entry = chainByMode[mode].get(t.id);
    const conflict = dependencyConflict(t, mode);
    const style = { fontSize: 12, ...modeColStyle(mode) };
    return (
      <>
        <td style={style}>
          <span
            title={
              isParent
                ? `Computed from this task's own sub-tasks (earliest Start under ${MODE_LABEL[mode]})`
                : conflict
                ? `Starts on or before "${conflict.name}" finishes (${formatDate(conflict.end)}) under ${MODE_LABEL[mode]} -- double-check this Start date.`
                : undefined
            }
            style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            <InlineDate
              value={t[field]}
              editable={canEditWbs && !isParent}
              onCommit={(v) =>
                // A manual edit here means this Start is no longer "on
                // auto-pilot" for this mode -- stop the sync effect above
                // from re-deriving it from the dependency chain from now
                // on. Re-adding/re-selecting the same dependency (or a new
                // one) turns auto-pilot back on, same as before (Round 10).
                saveTaskField(t.id, { [field]: v, [autoField]: false } as Partial<TaskRow>)
              }
            />
            {conflict && <AlertTriangle size={12} style={{ color: "var(--warning-text, #b45309)", flexShrink: 0 }} />}
          </span>
        </td>
        <td style={entry ? style : { ...style, color: "var(--muted)" }}>{entry ? formatDate(entry.end) : "—"}</td>
        <td style={entry ? style : { ...style, color: "var(--muted)" }}>{entry ? entry.durationDays : "—"}</td>
      </>
    );
  }

  const summaries: Record<Mode, ReturnType<typeof chainOverallSummary>> = {
    full_capacity: chainOverallSummary(fullChain),
    standard: chainOverallSummary(standardChain),
  };

  // Real-time utilization heat-map (Sandra, 2026-07-24): "when we
  // temporarily plot tasks to someone and select effort - the
  // utilization preview updates real time." Every OTHER project's tasks
  // count exactly as committed in the DB; THIS project's own tasks are
  // overridden with whatever the ACTIVE mode currently computes for
  // start/due (falling back to the task's real dates if it doesn't have
  // a computed entry yet, e.g. missing Est. hrs or Start date) -- so
  // editing a Start date, assignee, or effort level (all autosave
  // immediately into `tasks` state) or switching modes recomputes the
  // heat-map instantly, with no Save required.
  // NOTE (fixed 2026-07-24, found live on "Project 1" right after Round 7
  // shipped): the earlier version of this merged computed start/due dates
  // onto `allTasks`' own per-task object, which kept THAT snapshot's
  // assignee_id/effort/status -- fine for dates, but any Assignee/Effort
  // edited live (no full-page reload since) never made it into the
  // heat-map, since `allTasks` is fetched once at page load and never
  // refetched after a plain field save. Fixed by rebuilding this
  // project's own rows entirely fresh from live local state every
  // render, same fix already applied once before for a narrower version
  // of this same staleness bug -- only OTHER projects' tasks (not being
  // edited in this session) still come from the `allTasks` snapshot.
  const effectiveTasksForUtil: UtilTaskRow[] = [
    ...allTasks.filter((t) => t.project_id !== projectId),
    // Parent rows (tasks with their own sub-tasks) are excluded here on
    // purpose -- see parentAssigneeState/the Effort "N/A" cell above.
    // A parent's own span is just the union of its children's, so
    // counting it too would double the points/utilization contribution
    // for whoever it's (rolled-up-)assigned to.
    ...orderedTasks
      .filter((t) => !(t.depth === 0 && hasChildren(t.id)))
      .map((t) => {
        const entry = chainByMode[utilPreviewMode].get(t.id);
        return {
          id: t.id,
          project_id: t.project_id,
          assignee_id: t.assignee_id,
          status: t.status,
          start_date: entry?.start ?? t.start_date,
          current_due_date: entry?.end ?? t.current_due_date,
          effort: t.effort,
        };
      }),
  ];

  // Same live-draft idea for THIS project's own row in the PM-overhead
  // calculation (Sandra: "when project owner has been selected and start
  // date - fill out the heat map based on how we have set up PM
  // overheads... update the PM overhead utilization to fill as the dates
  // progress while building the WBS"). `allProjects` is a one-time
  // snapshot fetched at page load -- swap this project's row for a live
  // one built from the current draft Owner + derived Start/End span, so
  // picking an Owner or extending the schedule (adding/replanning tasks)
  // updates PM-overhead points immediately, same pattern as
  // effectiveTasksForUtil above.
  const effectiveProjectsForUtil: UtilProjectRow[] = [
    ...allProjects.filter((p) => p.id !== projectId),
    {
      id: projectId ?? "",
      owner_id: project.owner_id,
      start_date: project.start_date,
      end_date: summaries[utilPreviewMode].end,
    },
  ];

  const utilWindowStart = addDays(parseLocalDate(utilAnchorDate), utilWindowOffset * UTIL_WINDOW_DAYS);
  const utilDays: Date[] = Array.from({ length: UTIL_WINDOW_DAYS }, (_, i) => addDays(utilWindowStart, i));

  function utilAvailability(personId: string, dateStr: string): AvailabilityRow | undefined {
    return availability.find((a) => a.person_id === personId && a.date === dateStr);
  }

  const owner = people.find((p) => p.id === project.owner_id);

  // Gantt chart (Sandra, 2026-07-24): a visual timeline below the task
  // table, built LAST and deliberately after every scheduling-logic
  // change above so it renders the final, settled model. Shows whichever
  // mode is currently toggled active (same "Save using" control the rest
  // of the page already uses) -- one timeline at a time, not both modes
  // overlaid. Bars are colored by ASSIGNEE (not by mode) so a person with
  // several overlapping bars in the same window is an immediate visual
  // flag of over-allocation -- the actual motivation Sandra gave for
  // wanting per-person colors at all.
  // Round (2026-07-28): widened 28->34 (matches TimelineView's own day-cell
  // width elsewhere in the app) and switched from "one Gantt, whichever
  // mode is toggled" to "both Gantts, always" -- see ganttMetricsFor/
  // renderGantt below. Sandra flagged the single-mode Gantt read as
  // cramped/hard to follow, especially with dependency connector lines
  // layered on top -- the wider day column gives the elbow lines more
  // room to read clearly, on top of just being less crowded on its own.
  const GANTT_DAY_WIDTH = 34;
  const GANTT_NAME_COL_WIDTH = 220;
  const GANTT_HEADER_HEIGHT = 24; // matches the date-label row's own height
  const GANTT_ROW_HEIGHT = 26; // matches each task row's own height

  function ganttMetricsFor(mode: Mode) {
    const summary = summaries[mode];
    const startDate = summary.start ? addDays(parseLocalDate(summary.start), -1) : null;
    const endDate = summary.end ? addDays(parseLocalDate(summary.end), 1) : null;
    const days: Date[] =
      startDate && endDate
        ? (() => {
            const out: Date[] = [];
            for (let d = new Date(startDate); d <= endDate; d = addDays(d, 1)) out.push(new Date(d));
            return out;
          })()
        : [];
    const widthPx = days.length * GANTT_DAY_WIDTH;
    return { startDate, days, widthPx };
  }
  function ganttDayOffsetPx(startDate: Date | null, dateStr: string): number {
    if (!startDate) return 0;
    const diffDays = Math.round((parseLocalDate(dateStr).getTime() - startDate.getTime()) / 86400000);
    return diffDays * GANTT_DAY_WIDTH;
  }
  function ganttBarWidthPx(startStr: string, endStr: string): number {
    const diffDays = Math.round((parseLocalDate(endStr).getTime() - parseLocalDate(startStr).getTime()) / 86400000) + 1;
    return Math.max(diffDays, 1) * GANTT_DAY_WIDTH;
  }

  // Sandra, 2026-07-24: "is it ok if we show dependencies via a light broken
  // or thin line just to show relationship?" -- confirmed as a READ-ONLY
  // visual only (drawn from the existing "Depends on" data, using whichever
  // mode's chain is currently active, same as the bars themselves). This is
  // NOT the deferred "Gantt drag-linking" feature (creating/editing a
  // dependency by dragging between bars) -- that's a separate, bigger
  // interaction design still not started. An elbow (horizontal-vertical-
  // horizontal) path reads more like a real Gantt tool than a straight
  // diagonal and avoids visually cutting across unrelated bars in between.
  // Sandra confirmed she wants conflict-awareness: a normal edge is a
  // light dashed gray line ("light broken ... thin line"); an edge where
  // the successor starts on or before the predecessor's own End under the
  // active mode (the same test `dependencyConflict` already uses) turns
  // solid amber, matching the existing warning-triangle icon's color, so
  // the same conflict is visible on the Gantt without checking the table.
  function ganttConnectors(mode: Mode, startDate: Date | null) {
    const rowIndexOf = new Map(orderedTasks.map((t, i) => [t.id, i]));
    const elems: JSX.Element[] = [];
    for (const t of orderedTasks) {
      const depIds = dependsOnIdsFor(t.id);
      if (!depIds.length) continue;
      const succEntry = chainByMode[mode].get(t.id);
      const succRow = rowIndexOf.get(t.id);
      if (!succEntry || succRow === undefined) continue;
      for (const depId of depIds) {
        const predEntry = chainByMode[mode].get(depId);
        const predRow = rowIndexOf.get(depId);
        if (!predEntry || predRow === undefined) continue;
        const x1 = GANTT_NAME_COL_WIDTH + ganttDayOffsetPx(startDate, predEntry.end) + GANTT_DAY_WIDTH;
        const y1 = GANTT_HEADER_HEIGHT + predRow * GANTT_ROW_HEIGHT + GANTT_ROW_HEIGHT / 2;
        const x2 = GANTT_NAME_COL_WIDTH + ganttDayOffsetPx(startDate, succEntry.start);
        const y2 = GANTT_HEADER_HEIGHT + succRow * GANTT_ROW_HEIGHT + GANTT_ROW_HEIGHT / 2;
        // Sandra flagged this connector was rendering but essentially
        // invisible in practice: (1) `var(--border)` (#e3e7ec) is a
        // near-white hairline color meant for subtle table borders, far
        // too faint for a line drawn over a plain white Gantt background;
        // (2) a Finish-to-Start dependency's successor almost always
        // starts the very next working day after its predecessor ends --
        // there's rarely any real horizontal gap between the two bars, so
        // the old 6px-minimum elbow jog was too small to read as anything
        // more than a stray pixel. Fixed by switching the neutral color to
        // `var(--muted)` (a real medium gray already used elsewhere on
        // this page for secondary text -- still reads as "light/quiet"
        // next to the bold amber conflict color, just not literally
        // invisible) and widening the minimum jog to 14px.
        //
        // Round 16 (Sandra, after arrowheads shipped): the strict H-V-H
        // elbow above looked "crooked"/boxy whenever the predecessor and
        // successor sit several rows apart (e.g. routing past an
        // in-between parent row) while their bars are horizontally close
        // -- a long vertical run bookended by two short horizontal jogs
        // reads as an awkward rectangle rather than a connector. Sandra
        // confirmed she doesn't need the line to originate from the exact
        // pixel of the bar's own edge if that's what it takes to look
        // cleaner, so this switched to a smooth cubic-bezier S-curve
        // instead of a rigid right-angle path -- no jog-length tuning
        // needed, and it naturally looks fine regardless of how many rows
        // apart the two tasks are. Control points pull the curve
        // horizontally out from each endpoint by up to a third of the
        // total horizontal gap (min 14px, same floor as before) before
        // bending toward the other end.
        const conflict = succEntry.start <= predEntry.end;
        const dx = Math.max((x2 - x1) / 3, 14);
        const path = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
        elems.push(
          <path
            key={`${depId}->${t.id}`}
            d={path}
            fill="none"
            stroke={conflict ? "var(--warning-text, #b45309)" : "var(--muted, #8a94a6)"}
            strokeWidth={conflict ? 1.1 : 0.9}
            strokeDasharray={conflict ? undefined : "4,3"}
            markerEnd={`url(#${conflict ? `gantt-arrow-conflict-${mode}` : `gantt-arrow-neutral-${mode}`})`}
          />
        );
      }
    }
    return elems;
  }

  return (
    <div>
      {dialog}
      <Link to={`/projects/${projectId}`} className="back-link" style={{ display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 8, fontSize: 12.5 }}>
        <ArrowLeft size={13} /> Back to {project.name}
      </Link>
      <h1>WBS Planning — {project.name}</h1>

      {/* Phase 3 (2026-07-28): status banner for the Draft/Baseline/
          Revision/Final-Scope workflow -- see [[project_capaciq_wbs_planning]].
          Colors/labels mirror WBS_STATUS_META below. */}
      <div
        className="card"
        style={{
          padding: "8px 14px",
          marginBottom: 10,
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          background: WBS_STATUS_META[project.wbs_status]?.bg,
          borderColor: WBS_STATUS_META[project.wbs_status]?.border,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 700, color: WBS_STATUS_META[project.wbs_status]?.color }}>
          {WBS_STATUS_META[project.wbs_status]?.label ?? project.wbs_status}
        </span>
        <span style={{ fontSize: 11.5, color: "var(--muted)" }}>{WBS_STATUS_META[project.wbs_status]?.hint}</span>
        {activeBaseline && (
          <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
            Baseline V{activeBaseline.version_number} (locked {formatDate(activeBaseline.captured_at.slice(0, 10))})
          </span>
        )}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          {/* Round 2 of the WBS UI redesign (Sandra, 2026-07-29), reordered
              per her 2026-07-29 follow-up (Actions menu before the primary
              CTA, matching her reference mockup's left-to-right order):
              Actions dropdown first (Start Revision/Re-baseline while
              eligible), then the single primary CTA (Lock Baseline / Close
              Project / Apply Revision, whichever applies) rightmost.
              Discard/Apply Revision stay as direct buttons during an
              active revision -- short, focused 2-button decision, not
              worth burying in a menu. */}
          <ActionsMenu
            items={[
              ...(canManageWbs && (project.wbs_status === "baseline_locked" || project.wbs_status === "changed_after_baseline")
                ? [
                    { label: "Start Revision", onClick: handleStartRevision, disabled: workflowBusy },
                    { label: "Re-baseline", onClick: handleRebaseline, disabled: workflowBusy },
                  ]
                : []),
            ]}
          />
          {canManageWbs && project.wbs_status === "draft" && (
            <button className="btn-primary" disabled={workflowBusy} onClick={handleLockBaseline}>
              Lock Baseline
            </button>
          )}
          {project.wbs_status === "revision_in_progress" && canManageWbs && (
            <>
              <button className="btn-secondary" disabled={workflowBusy} onClick={handleDiscardRevision}>
                Discard Revision
              </button>
              <button className="btn-primary" disabled={workflowBusy} onClick={handleApplyRevision}>
                Apply Revision
              </button>
            </>
          )}
          {canManageWbs &&
            (project.wbs_status === "baseline_locked" || project.wbs_status === "changed_after_baseline") &&
            !pendingClosure && (
              // Renamed from "Request Closure" (Sandra, 2026-07-29, design
              // spec item 1: "remove 'Capture Final' wording -- primary
              // Close Project button"). Same handler (handleRequestClosure)
              // -- for a non-approver this still opens the approval-pending
              // state below; canDecideClosure users see Approve & Close
              // there. Only the label/prominence changed, not the workflow.
              <button className="btn-primary" disabled={workflowBusy} onClick={handleRequestClosure}>
                Close Project
              </button>
            )}
        </div>
      </div>

      {pendingClosure && (
        <div
          className="card"
          style={{ padding: "8px 14px", marginBottom: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", background: "var(--warning-bg, #fff7ed)" }}
        >
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--warning-text, #b45309)" }}>Closure requested</span>
          <span style={{ fontSize: 11.5, color: "var(--muted)" }}>Awaiting approval to lock in Final Scope.</span>
          {canDecideClosure && (
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button className="btn-secondary" disabled={workflowBusy} onClick={() => handleDecideClosure(false)}>
                Reject
              </button>
              <button className="btn-primary" disabled={workflowBusy} onClick={() => handleDecideClosure(true)}>
                Approve &amp; Close
              </button>
            </div>
          )}
        </div>
      )}

      {/* Sandra, 2026-07-29: previously this whole section (fields, effort
          summary, task table, Gantt, Utilization) only rendered when NOT
          locked -- a locked/closed project showed nothing but a one-line
          message instead of its actual plan. Now the message is a slim
          banner and the full content always renders underneath, with
          canEditWbs gating individual field/control editability instead
          of gating visibility of the whole page. */}
      {project.wbs_status === "revision_in_progress" && (
        <div className="card" style={{ padding: "8px 14px", marginBottom: 10, fontSize: 11.5, color: "var(--muted)" }}>
          Revision in progress -- editing is unlocked. Use Apply Revision above when done, or Discard Revision to undo everything back to before this revision started.
        </div>
      )}
      {/* Sandra, 2026-07-29: removed the separate locked/closed message
          card that used to sit here -- redundant with the top status
          banner's own colored bg + hint text right above it. */}
      {/* Design spec item 6 follow-up (Sandra, 2026-07-29): Revision
          Summary + Revision History now live in a genuine right rail
          alongside the main content (not a full-width toggle panel like
          before), matching her reference mockup. Main content is the
          flex:1 left column; the rail is a fixed-width sibling. */}
      <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="card" style={{ padding: 14, marginBottom: 12, display: "flex", alignItems: "center", gap: 16, flexWrap: "nowrap", overflowX: "auto" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy)" }}>Project:</span>
              <div className="wbs-field-box" style={fieldBoxStyle(!!project.name, 170, !canEditWbs)}>
                <InlineText value={project.name} editable={canEditWbs} onCommit={(v) => saveProjectField({ name: v })} />
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy)" }}>Owner:</span>
              <div className="wbs-field-box" style={fieldBoxStyle(true, 110, !canEditWbs)}>
                <InlineSelect
                  value={owner?.name ?? ""}
                  editable={canEditWbs}
                  allowEmpty
                  emptyLabel="No owner"
                  options={people.map((p) => p.name)}
                  onCommit={(name) => {
                    const p = people.find((pp) => pp.name === name);
                    saveProjectField({ owner_id: p?.id ?? null });
                  }}
                />
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy)" }}>Start date:</span>
              <div className="wbs-field-box" style={fieldBoxStyle(true, 110, !canEditWbs)}>
                <InlineDate value={project.start_date} editable={canEditWbs} onCommit={(v) => saveProjectField({ start_date: v })} />
              </div>
              <span
                title="Your own plotted anchor -- used as the default Start for the very first task in each mode when there's nothing earlier to chain from. No longer auto-pulled from tasks."
                style={{ display: "inline-flex", cursor: "help", flexShrink: 0 }}
              >
                <Info size={13} style={{ color: "var(--muted)" }} />
              </span>
            </div>
            {activeBaseline && (
              // Design spec item 2 (Sandra, 2026-07-29): Baseline version
              // shown in the Project Details strip, but READ-ONLY --
              // unlike Project/Owner/Start date/Scoping Effort, there's no
              // direct-edit path for this (it only changes via Lock
              // Baseline/Re-baseline in the Actions menu), so it renders
              // as plain text in a muted box rather than an InlineX field.
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy)" }}>Baseline:</span>
                <div className="wbs-field-box" style={fieldBoxStyle(true, 90, true)}>
                  <span style={{ fontSize: 12.5 }}>
                    V{activeBaseline.version_number} ({formatDate(activeBaseline.captured_at.slice(0, 10))})
                  </span>
                </div>
              </div>
            )}
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy)" }}>Scoping Effort:</span>
              <div className="wbs-field-box" style={fieldBoxStyle(true, 150, !canEditWbs)}>
                <InlineSelect
                  value={MODE_LABEL[activeMode]}
                  editable={canEditWbs}
                  options={MODES.map((m) => MODE_LABEL[m])}
                  onCommit={(label) => {
                    const m = MODES.find((mm) => MODE_LABEL[mm] === label);
                    if (m) setActiveMode(m);
                  }}
                />
              </div>
              <span
                title={
                  project.scoping_effort_mode
                    ? `Officially saved as ${MODE_LABEL[project.scoping_effort_mode as Mode] ?? project.scoping_effort_mode}. Pick a mode here, then Save to change what's officially recorded and written onto every task.`
                    : "Not saved yet -- pick a mode, then Save to record it as this project's official Scoping Effort and write its dates onto every task."
                }
                style={{ display: "inline-flex", cursor: "help", flexShrink: 0 }}
              >
                <Info size={13} style={{ color: "var(--muted)" }} />
              </span>
              {canEditWbs && (
                <button className="btn-primary" disabled={saving} onClick={saveDraft} style={{ flexShrink: 0 }}>
                  {saving ? "Saving…" : "Save"}
                </button>
              )}
            </div>
          </div>

          {/* Project-level summary: fixed total effort (left) + a
              duration comparison bar per mode (right) -- redesigned per
              Sandra's own mockup (2026-07-24): a big "Total Effort
              Needed" number that never changes between modes (a
              "Fixed total effort" pill makes that explicit), next to a
              horizontal bar per mode sized by its own working-day
              duration so the Full Effort vs Conservative Effort
              tradeoff reads visually, not just as two numbers. */}
          {/* Design spec item 5 (Sandra, 2026-07-29): second-row layout --
              this existing Total Effort/Effort Comparison card (Timeline
              Projection) on the LEFT, the new Overall Variance table
              (formerly the toggle-only Compare-with-Baseline panel) on
              the RIGHT, once there's a baseline to compare against. Draft
              projects (no baseline yet) keep the single full-width card
              as before -- there's nothing to show variance against. */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: project.wbs_status === "draft" ? "1fr" : "1fr 1fr",
              gap: 12,
              marginBottom: 12,
              alignItems: "start",
            }}
          >
          <div className="card" style={{ padding: 16, display: "flex", gap: 28, flexWrap: "wrap" }}>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                gap: 6,
                minWidth: 150,
                paddingRight: 28,
                borderRight: "1px solid var(--border)",
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.3 }}>
                Total Effort Needed
              </div>
              <div style={{ fontSize: 30, fontWeight: 700, color: "var(--navy)", lineHeight: 1.1 }}>
                {totalEffortHours}
                <span style={{ fontSize: 15, fontWeight: 600, marginLeft: 3 }}>h</span>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
                across {orderedTasks.filter((t) => t.depth === 0).length} task(s)
              </div>
            </div>

            <div style={{ flex: 1, minWidth: 340 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy)", marginBottom: 12 }}>Effort Comparison (by Duration)</div>
              {MODES.map((m, i) => {
                const s = summaries[m];
                const color = m === "full_capacity" ? "#3b82f6" : "#22c55e";
                const rate = m === "full_capacity" ? "7.5 h/day" : "4 h/day";
                const maxDuration = Math.max(summaries.full_capacity.durationDays, summaries.standard.durationDays, 1);
                const widthPct = s.durationDays ? Math.max(18, Math.round((s.durationDays / maxDuration) * 100)) : 0;
                // Sandra, 2026-07-29 follow-up: label moved ABOVE the bar
                // (was to its left) per her reference mockup -- same
                // colors, just the layout direction changed.
                return (
                  <div key={m} style={{ marginBottom: i === MODES.length - 1 ? 0 : 14 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color, marginBottom: 6 }}>
                      {MODE_LABEL[m]} ({rate})
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                      <div style={{ flex: 1, minWidth: 100 }}>
                        {s.durationDays ? (
                          <div
                            style={{
                              width: `${widthPct}%`,
                              minWidth: 90,
                              background: color,
                              color: "#fff",
                              fontSize: 11,
                              fontWeight: 600,
                              textAlign: "center",
                              padding: "6px 8px",
                              borderRadius: 4,
                              whiteSpace: "nowrap",
                            }}
                          >
                            {s.durationDays} working day{s.durationDays === 1 ? "" : "s"}
                          </div>
                        ) : (
                          <span style={{ fontSize: 11.5, color: "var(--muted)" }}>no schedule yet</span>
                        )}
                      </div>
                      <div style={{ width: 85, fontSize: 11.5, flexShrink: 0 }}>
                        <div style={{ fontWeight: 600, color: "var(--muted)", fontSize: 10 }}>Start</div>
                        <div>{formatDate(s.start)}</div>
                      </div>
                      <div style={{ width: 85, fontSize: 11.5, flexShrink: 0 }}>
                        <div style={{ fontWeight: 600, color: "var(--muted)", fontSize: 10 }}>End</div>
                        <div>{formatDate(s.end)}</div>
                      </div>
                      {!s.complete && s.end && (
                        <div style={{ fontSize: 11.5, color: "var(--muted)", flexShrink: 0 }}>incomplete</div>
                      )}
                    </div>
                  </div>
                );
              })}
              {/* Sandra, 2026-07-29 follow-up: removed the "Total Effort
                  reflects the current plan..." helper line entirely. */}
            </div>
          </div>
          {project.wbs_status !== "draft" && (
            <CompareWithBaselinePanel projectId={project.id} liveTasks={buildTaskSnapshotPayload()} />
          )}
          </div>

          {/* Live utilization heat-map -- same points/tier formula as the
              Utilization page, fed this project's DRAFT plan (including
              its own draft Owner/derived-span for PM overhead) */}
          <div className="card" style={{ padding: 14, marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
              <strong style={{ fontSize: 12.5, color: "var(--navy)" }}>Utilization snapshot</strong>
              <span
                title={`Live preview -- updates as you assign people, set effort, set Start dates, and pick an Owner, using ${MODE_LABEL[utilPreviewMode]}'s current schedule.`}
                style={{ display: "inline-flex", cursor: "help", color: "var(--muted)" }}
              >
                <Info size={13} />
              </span>
              <div className="timeline-segmented" title="Preview only -- doesn't affect Scoping Effort or Save.">
                {MODES.map((m) => (
                  <button key={m} className={`timeline-segmented-btn${utilPreviewMode === m ? " active" : ""}`} onClick={() => setUtilPreviewMode(m)}>
                    {MODE_LABEL[m]}
                  </button>
                ))}
              </div>
              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
                <button className="planner-nav-btn" title="Previous 4 weeks" onClick={() => setUtilWindowOffset((o) => o - 1)}>
                  <ChevronLeft size={14} />
                </button>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--navy)" }}>
                  {formatDate(toISO(utilDays[0]))} – {formatDate(toISO(utilDays[utilDays.length - 1]))}
                </span>
                <button className="planner-nav-btn" title="Next 4 weeks" onClick={() => setUtilWindowOffset((o) => o + 1)}>
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table className="data-table" style={{ borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th style={{ width: 130, position: "sticky", left: 0, background: "var(--surface)", zIndex: 1 }}>Person</th>
                    {utilDays.map((d) => {
                      const iso = toISO(d);
                      const weekend = d.getDay() === 0 || d.getDay() === 6;
                      const holiday = holidaySet.has(iso);
                      return (
                        <th
                          key={iso}
                          style={{ width: 40, minWidth: 40, fontSize: 10, textAlign: "center", color: weekend || holiday ? "var(--muted)" : undefined }}
                          title={iso}
                        >
                          {String(d.getMonth() + 1).padStart(2, "0")}/{String(d.getDate()).padStart(2, "0")}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {people.map((p) => (
                    <tr key={p.id}>
                      <td style={{ fontSize: 12, fontWeight: 600, position: "sticky", left: 0, background: "var(--surface)" }}>{p.name}</td>
                      {utilDays.map((d) => {
                        const iso = toISO(d);
                        if (!isWorkingDay(d, holidaySet)) {
                          return (
                            <td key={iso} style={{ textAlign: "center", fontSize: 10.5, color: "var(--muted)", background: "var(--hover-bg)" }}>
                              –
                            </td>
                          );
                        }
                        const av = utilAvailability(p.id, iso);
                        if (av?.status === "off") {
                          return (
                            <td key={iso} style={{ textAlign: "center", fontSize: 10, color: "var(--muted)", background: "#f1f2f4" }}>
                              Off
                            </td>
                          );
                        }
                        const points = dailyPointsFor(p.id, iso, effectiveTasksForUtil, effectiveProjectsForUtil);
                        const capacity = dailyCapacityFor(p as UtilPersonRow, av?.status === "half_day");
                        const pct = capacity > 0 ? (points / capacity) * 100 : points > 0 ? 999 : 0;
                        const tier = tierOf(pct);
                        return (
                          <td
                            key={iso}
                            style={{ textAlign: "center", fontSize: 10.5, background: tier.bg, color: tier.fg, fontWeight: 600 }}
                            title={`${p.name} · ${iso} · ${tier.label}${av?.status === "half_day" ? " (half day)" : ""}`}
                          >
                            {tier.key === "none" ? "–" : `${Math.round(pct)}%`}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  {people.length === 0 && (
                    <tr>
                      <td colSpan={UTIL_WINDOW_DAYS + 1} style={{ padding: 10, color: "var(--muted)", fontSize: 12 }}>
                        No active people to show.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
            <button
              onClick={refreshDates}
              title="Recompute Start dates for tasks that are still on auto-pilot (no dependency set, not manually overridden) based on the current row order -- useful after dragging a task into a new position."
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                padding: "5px 10px",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm, 6px)",
                background: "var(--surface)",
                color: "var(--text)",
                cursor: "pointer",
              }}
            >
              <RefreshCw size={13} /> Refresh dates
            </button>
          </div>
          {Object.keys(baselineTasksById).length > 0 && (
            // Design spec item 4/7 (Sandra, 2026-07-29): change-type
            // legend for the Changes column below -- vs Baseline V<n>.
            <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginBottom: 8, fontSize: 11, color: "var(--text-secondary)" }}>
              {([
                ["task_added", "New"],
                ["hours_increased", "Increased"],
                ["hours_decreased", "Decreased"],
                ["date_changed", "Date changed"],
                ["dependency_changed", "Dependency changed"],
                ["assignee_changed", "Assignee changed"],
              ] as const).map(([key, label]) => (
                <span key={key} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: CHANGE_DOT_COLOR[key], flexShrink: 0 }} />
                  {label}
                </span>
              ))}
            </div>
          )}
          <div className="card" style={{ padding: 0, overflowX: "auto", overflowY: "visible" }}>
            <table className="data-table" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th rowSpan={2} className="row-gutter-cell" style={{ width: 22, minWidth: 22 }} />
                  <th rowSpan={2} style={{ minWidth: 200 }}>
                    Task
                  </th>
                  <th rowSpan={2} style={{ width: 90 }}>
                    Est. hrs
                  </th>
                  <th rowSpan={2} style={{ width: 90 }}>
                    Effort
                  </th>
                  <th rowSpan={2} style={{ width: 150 }}>
                    Assignee
                  </th>
                  <th rowSpan={2} style={{ width: 150 }}>
                    Depends on
                  </th>
                  <th rowSpan={2} style={{ width: 110 }} title="vs the active Baseline">
                    Changes vs Baseline
                  </th>
                  <th rowSpan={2} style={{ width: 160 }}>
                    Notes
                  </th>
                  <th colSpan={3} style={{ textAlign: "center", ...modeColStyle("full_capacity") }}>
                    Full Effort
                  </th>
                  <th colSpan={3} style={{ textAlign: "center", ...modeColStyle("standard") }}>
                    Conservative Effort
                  </th>
                </tr>
                <tr>
                  <th style={{ width: 110, ...modeColStyle("full_capacity") }}>Start</th>
                  <th style={{ width: 100, ...modeColStyle("full_capacity") }}>End Date</th>
                  <th style={{ width: 90, ...modeColStyle("full_capacity") }}>Duration (days)</th>
                  <th style={{ width: 110, ...modeColStyle("standard") }}>Start</th>
                  <th style={{ width: 100, ...modeColStyle("standard") }}>End Date</th>
                  <th style={{ width: 90, ...modeColStyle("standard") }}>Duration (days)</th>
                </tr>
              </thead>
              <tbody>
                {orderedTasks.length === 0 && (
                  <tr>
                    <td colSpan={14} style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>
                      No tasks in this project yet.
                    </td>
                  </tr>
                )}
                {orderedTasks.map((t) => {
                  const isParent = t.depth === 0 && hasChildren(t.id);
                  const assignee = people.find((p) => p.id === t.assignee_id);
                  const dependsOnIds = dependsOnIdsFor(t.id);
                  const draggedTask = draggedTaskId ? orderedTasks.find((x) => x.id === draggedTaskId) : undefined;
                  const validDropTarget =
                    !!draggedTask && draggedTask.id !== t.id && draggedTask.depth === t.depth && draggedTask.parent_task_id === t.parent_task_id;
                  return (
                    <tr
                      key={t.id}
                      className={dragOverTaskId === t.id && validDropTarget ? "row-drop-target" : undefined}
                      onDragOver={(e) => {
                        e.preventDefault();
                        if (dragOverTaskId !== t.id) setDragOverTaskId(t.id);
                      }}
                      onDragLeave={() => setDragOverTaskId((prev) => (prev === t.id ? null : prev))}
                      onDrop={() => {
                        if (draggedTaskId && validDropTarget) reorderTask(draggedTaskId, t.id);
                        setDraggedTaskId(null);
                        setDragOverTaskId(null);
                      }}
                    >
                      {/* Round 18 (2026-07-28): removed the dragged row's
                          own opacity restyle -- DataTable.tsx's proven
                          row-drag (used on Projects & Tasks, where the
                          grip works) never restyles the SOURCE row mid-
                          drag, only the drop target; re-rendering the
                          dragged element's own style while its native
                          drag is in flight is a plausible reason a
                          structurally-identical gutter column still
                          didn't drag on this page. Also: the drop-target
                          highlight now only lights up on a row that's
                          actually a valid target (same depth + same
                          parent -- reorder is siblings-only), so hovering
                          over an invalid target (e.g. a different
                          task's sub-task) no longer looks like a normal
                          drop zone that silently does nothing. */}
                      <td className="row-gutter-cell" onClick={(e) => e.stopPropagation()}>
                        <div className="row-gutter-inner" style={{ opacity: 1, paddingLeft: 4 }}>
                          <span
                            className="row-grip-btn"
                            draggable={canEditWbs}
                            onDragStart={() => canEditWbs && setDraggedTaskId(t.id)}
                            onDragEnd={() => {
                              setDraggedTaskId(null);
                              setDragOverTaskId(null);
                            }}
                            title={canEditWbs ? "Drag to reorder (among its own siblings)" : undefined}
                            style={canEditWbs ? undefined : { opacity: 0.35, cursor: "default" }}
                          >
                            <GripVertical size={13} />
                          </span>
                        </div>
                      </td>
                      <td>
                        <div style={{ paddingLeft: t.depth * 16, fontWeight: t.depth === 0 ? 600 : 400, display: "flex", alignItems: "center", gap: 4 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <InlineText value={t.name} editable={canEditWbs} bold={t.depth === 0} onCommit={(v) => saveTaskField(t.id, { name: v })} />
                          </div>
                          {canEditWbs && t.depth === 0 && (
                            <button className="add-subtask-btn" onClick={() => addSubtask(t)} title="Add sub-task">
                              <Plus size={14} />
                            </button>
                          )}
                          {canEditWbs && (
                            <button className="add-subtask-btn" onClick={() => deleteTask(t)} title={isParent ? "Delete task (and its sub-tasks)" : "Delete task"}>
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      </td>
                      <td>
                        <span title={isParent ? "Computed from this task's own sub-tasks (sum of their Est. hrs)" : undefined}>
                          <InlineNumber
                            value={t.estimated_hours}
                            editable={canEditWbs && !isParent}
                            onCommit={(v) => saveTaskField(t.id, { estimated_hours: v })}
                          />
                        </span>
                      </td>
                      <td>
                        {isParent ? (
                          <span style={{ fontSize: 11.5, color: "var(--muted)" }} title="Not applicable -- a parent task's own effort is already represented by its sub-tasks' own Effort/points, so it doesn't carry a separate value.">
                            N/A
                          </span>
                        ) : (
                          <InlineSelect
                            value={t.effort ?? ""}
                            editable={canEditWbs}
                            allowEmpty
                            emptyLabel="Pick effort"
                            options={TASK_EFFORT_OPTIONS}
                            renderReadOnly={(v) => (v ? <span className={`status-pill ${TASK_EFFORT_DEFAULT_TONES[v] ?? "neutral"}`}>{v}</span> : "Pick effort")}
                            onCommit={(v) => saveTaskField(t.id, { effort: v || null })}
                          />
                        )}
                      </td>
                      <td>
                        {isParent ? (
                          (() => {
                            const { multiple } = parentAssigneeState(t.id);
                            if (multiple) {
                              return (
                                <span
                                  style={{ fontSize: 11.5, color: "var(--muted)", fontStyle: "italic" }}
                                  title="This task's own sub-tasks are assigned to more than one person -- pick a single Assignee on each sub-task instead."
                                >
                                  Multiple
                                </span>
                              );
                            }
                            return assignee ? (
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }} title="Mirrors its sub-tasks -- all currently assigned to the same person.">
                                <span style={{ width: 8, height: 8, borderRadius: "50%", background: colorForPerson(assignee), flexShrink: 0 }} />
                                {assignee.name}
                              </span>
                            ) : (
                              <span style={{ fontSize: 11.5, color: "var(--muted)" }}>Unassigned</span>
                            );
                          })()
                        ) : (
                          <InlineSelect
                            value={assignee?.name ?? ""}
                            editable={canEditWbs}
                            allowEmpty
                            emptyLabel="Unassigned"
                            options={people.map((p) => p.name)}
                            renderReadOnly={(v) =>
                              v ? (
                                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                  <span
                                    style={{
                                      width: 8,
                                      height: 8,
                                      borderRadius: "50%",
                                      background: colorForPerson(assignee),
                                      flexShrink: 0,
                                    }}
                                  />
                                  {v}
                                </span>
                              ) : (
                                "Unassigned"
                              )
                            }
                            onCommit={(name) => {
                              const p = people.find((pp) => pp.name === name);
                              saveTaskField(t.id, { assignee_id: p?.id ?? null });
                            }}
                          />
                        )}
                      </td>
                      <td style={{ position: "relative" }}>
                        <DependsOnPicker
                          task={t}
                          allTasks={orderedTasks}
                          dependsOnIds={dependsOnIds}
                          isOpen={depPickerOpenFor === t.id}
                          editable={canEditWbs}
                          onToggle={() => setDepPickerOpenFor((prev) => (prev === t.id ? null : t.id))}
                          onClose={() => setDepPickerOpenFor(null)}
                          onAdd={(depId) => addDependency(t.id, depId)}
                          onRemove={(depId) => removeDependency(t.id, depId)}
                        />
                      </td>
                      <td>
                        {(() => {
                          if (Object.keys(baselineTasksById).length === 0) return <span style={{ color: "var(--muted)" }}>—</span>;
                          const { kinds } = taskBaselineDiff(t, isParent);
                          if (kinds.length === 0) return <span style={{ color: "var(--muted)" }}>No change</span>;
                          return (
                            <span style={{ display: "inline-flex", gap: 3 }} title={kinds.map((k) => k.replace(/_/g, " ")).join(", ")}>
                              {kinds.map((k) => (
                                <span key={k} style={{ width: 7, height: 7, borderRadius: "50%", background: CHANGE_DOT_COLOR[k], flexShrink: 0 }} />
                              ))}
                            </span>
                          );
                        })()}
                      </td>
                      <td>
                        {(() => {
                          if (Object.keys(baselineTasksById).length === 0) return <span style={{ color: "var(--muted)" }}>—</span>;
                          const { isNew, notes } = taskBaselineDiff(t, isParent);
                          if (notes.length === 0) return <span style={{ color: "var(--muted)" }}>—</span>;
                          return (
                            <span style={{ fontSize: 11.5, color: isNew ? "#3f9d6e" : "var(--text-secondary)", fontWeight: isNew ? 600 : 400 }}>
                              {isNew ? "NEW" : notes.join(", ")}
                            </span>
                          );
                        })()}
                      </td>
                      {renderModeCells(t, "full_capacity", isParent)}
                      {renderModeCells(t, "standard", isParent)}
                    </tr>
                  );
                })}
                {canEditWbs && (
                  <tr>
                    <td colSpan={14} className="add-row-cell">
                      <div className="add-row-trigger" onClick={addTopLevelTask}>
                        <Plus size={12} />
                        New task
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Timeline (Gantt) -- always visible below the table, BOTH
              modes stacked (2026-07-28: previously just whichever mode was
              toggled active; Sandra asked for both side by side since the
              scoping table above already shows both regardless of
              toggle). renderGantt(mode) below is the same markup as
              before, just parameterized instead of reading `activeMode`
              directly, called once per MODE. */}
          {MODES.map((mode) => {
            const { startDate: ganttStartDate, days: ganttDays, widthPx: ganttWidthPx } = ganttMetricsFor(mode);
            return (
              <div key={mode} className="card" style={{ padding: 14, marginTop: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <strong style={{ fontSize: 12.5, color: "var(--navy)" }}>Timeline (Gantt) — {MODE_LABEL[mode]}</strong>
                </div>
                {ganttDays.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--muted)", padding: "6px 0" }}>
                    No schedule yet -- add a Start date and Estimated hours to at least one task to see the timeline.
                  </div>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    {/* Sandra, 2026-07-24: "is it ok if we show dependencies via
                        a light broken or thin line just to show relationship?"
                        -- a single SVG overlay (`ganttConnectors()` below)
                        spans the whole header+rows area so an elbow line can be
                        drawn from any predecessor row to any successor row
                        (they're rarely adjacent). This wrapping div is what
                        that overlay is absolutely positioned against; nothing
                        else changed about the header/row markup below, just
                        moved their shared `minWidth` up onto this one wrapper
                        instead of repeating it on every row. Read-only lines
                        only -- NOT the deferred drag-to-create-a-dependency
                        feature, which is a separate, bigger interaction and
                        still not started. */}
                    <div style={{ position: "relative", minWidth: GANTT_NAME_COL_WIDTH + ganttWidthPx }}>
                    <div style={{ display: "flex" }}>
                      <div style={{ width: GANTT_NAME_COL_WIDTH, flexShrink: 0, position: "sticky", left: 0, background: "var(--surface)", zIndex: 1 }} />
                      <div style={{ position: "relative", width: ganttWidthPx, height: 24, flexShrink: 0 }}>
                        {ganttDays.map((d, i) => {
                          const iso = toISO(d);
                          const offDay = !isWorkingDay(d, holidaySet);
                          const isFirstOfMonth = d.getDate() === 1 || i === 0;
                          return (
                            <div
                              key={iso}
                              title={iso}
                              style={{
                                position: "absolute",
                                left: i * GANTT_DAY_WIDTH,
                                top: 0,
                                width: GANTT_DAY_WIDTH,
                                height: "100%",
                                fontSize: 9.5,
                                textAlign: "center",
                                color: offDay ? "var(--muted)" : "var(--text)",
                                background: offDay ? "var(--hover-bg)" : undefined,
                                fontWeight: isFirstOfMonth ? 700 : 400,
                                borderLeft: isFirstOfMonth ? "1px solid var(--border)" : undefined,
                              }}
                            >
                              {String(d.getMonth() + 1).padStart(2, "0")}/{String(d.getDate()).padStart(2, "0")}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    {orderedTasks.map((t) => {
                      const entry = chainByMode[mode].get(t.id);
                      const isParent = t.depth === 0 && hasChildren(t.id);
                      const assignee = people.find((p) => p.id === t.assignee_id);
                      const barColor = assignee ? colorForPerson(assignee) : UNASSIGNED_BAR_COLOR;
                      return (
                        <div key={t.id} style={{ display: "flex" }}>
                          <div
                            style={{
                              width: GANTT_NAME_COL_WIDTH,
                              flexShrink: 0,
                              position: "sticky",
                              left: 0,
                              background: "var(--surface)",
                              zIndex: 1,
                              fontSize: 11.5,
                              fontWeight: t.depth === 0 ? 600 : 400,
                              paddingLeft: 8 + t.depth * 16,
                              paddingRight: 8,
                              height: 26,
                              display: "flex",
                              alignItems: "center",
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              borderBottom: "1px solid var(--hover-bg)",
                            }}
                            title={t.name}
                          >
                            {t.name}
                          </div>
                          <div style={{ position: "relative", width: ganttWidthPx, height: 26, flexShrink: 0, borderBottom: "1px solid var(--hover-bg)" }}>
                            {ganttDays.map((d) => {
                              const iso = toISO(d);
                              if (isWorkingDay(d, holidaySet)) return null;
                              return (
                                <div
                                  key={iso}
                                  style={{
                                    position: "absolute",
                                    left: ganttDayOffsetPx(ganttStartDate, iso),
                                    top: 0,
                                    bottom: 0,
                                    width: GANTT_DAY_WIDTH,
                                    background: "var(--hover-bg)",
                                  }}
                                />
                              );
                            })}
                            {entry ? (
                              <div
                                title={`${t.name} · ${assignee?.name ?? "Unassigned"} · ${formatDate(entry.start)} → ${formatDate(entry.end)}`}
                                style={{
                                  position: "absolute",
                                  left: ganttDayOffsetPx(ganttStartDate, entry.start),
                                  width: ganttBarWidthPx(entry.start, entry.end),
                                  top: isParent ? 9 : 4,
                                  height: isParent ? 8 : 18,
                                  background: barColor,
                                  opacity: isParent ? 0.55 : 1,
                                  borderRadius: 4,
                                  display: "flex",
                                  alignItems: "center",
                                  paddingLeft: 5,
                                  color: "#fff",
                                  fontSize: 9.5,
                                  fontWeight: 600,
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                }}
                              >
                                {!isParent && entry.durationDays}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                    <svg
                      width={GANTT_NAME_COL_WIDTH + ganttWidthPx}
                      height={GANTT_HEADER_HEIGHT + orderedTasks.length * GANTT_ROW_HEIGHT}
                      style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}
                    >
                      {/* Sandra, 2026-07-28: wants the dependency connectors
                          to read as arrows, not bare lines -- two markers
                          (neutral gray / conflict amber, matching each
                          path's own stroke) so the arrowhead color always
                          matches the line it's attached to. */}
                      <defs>
                        <marker id={`gantt-arrow-neutral-${mode}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                          <path d="M0,0 L8,4 L0,8 Z" fill="var(--muted, #8a94a6)" />
                        </marker>
                        <marker id={`gantt-arrow-conflict-${mode}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                          <path d="M0,0 L8,4 L0,8 Z" fill="var(--warning-text, #b45309)" />
                        </marker>
                      </defs>
                      {ganttConnectors(mode, ganttStartDate)}
                    </svg>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {project.wbs_status !== "draft" && (
          <div style={{ width: 300, flexShrink: 0 }}>
            <div className="card" style={{ padding: 14 }}>
              {/* Sandra, 2026-07-29 follow-up: plain icon+label+value rows,
                  no per-row card/box (per her reference mockup). */}
              {latestRevisionChanges.length > 0 && (
                <div style={{ marginBottom: 12, paddingBottom: 12, borderBottom: "1px solid var(--border)" }}>
                  <strong style={{ fontSize: 12.5, color: "var(--navy)" }}>Revision Summary</strong>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8, fontSize: 11.5 }}>
                    {[
                      { icon: <Clock size={13} />, label: "Total effort change", value: `${revisionSummary.totalAddedHours > 0 ? "+" : ""}${revisionSummary.totalAddedHours}h` },
                      { icon: <ListPlus size={13} />, label: "Total tasks added", value: revisionSummary.tasksAdded },
                      { icon: <Trash2 size={13} />, label: "Total tasks removed", value: revisionSummary.tasksRemoved },
                      { icon: <TrendingUp size={13} />, label: "Estimates increased", value: revisionSummary.hoursIncreased },
                      { icon: <TrendingDown size={13} />, label: "Estimates decreased", value: revisionSummary.hoursDecreased },
                      { icon: <Calendar size={13} />, label: "Dates changed", value: revisionSummary.datesChanged },
                      { icon: <Link2 size={13} />, label: "Dependencies changed", value: revisionSummary.dependenciesChanged },
                      { icon: <User size={13} />, label: "Assignees changed", value: revisionSummary.assigneesChanged },
                    ].map((row) => (
                      <div key={row.label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ color: "var(--muted)", flexShrink: 0, display: "inline-flex" }}>{row.icon}</span>
                        <span style={{ flex: 1, color: "var(--text-secondary)" }}>{row.label}</span>
                        <strong>{row.value}</strong>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <strong style={{ fontSize: 12.5, color: "var(--navy)" }}>Revision History</strong>
              {/* Sandra, 2026-07-29 follow-up: replaced the bordered-box-
                  per-revision look with a flat timeline (circle marker +
                  connecting line), Impact shown inline (no click-to-
                  expand needed), capped to the last 5 revisions, and a
                  clearer placeholder when nothing's been recorded yet. */}
              {revisionHistory.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6 }}>No changes made yet.</div>
              ) : (
                <div style={{ marginTop: 10, position: "relative", paddingLeft: 16 }}>
                  <div style={{ position: "absolute", left: 3, top: 4, bottom: 4, width: 2, background: "var(--border)" }} />
                  {revisionHistory.slice(0, 5).map((r, idx, arr) => {
                    const changes = revisionChangesById[r.id] ?? [];
                    const hoursDelta = changes
                      .filter((c) => c.change_type === "hours_changed")
                      .reduce((sum, c) => sum + (Number(c.new_value ?? 0) - Number(c.previous_value ?? 0)), 0);
                    const tasksAdded = changes.filter((c) => c.change_type === "task_added").length;
                    const tasksRemoved = changes.filter((c) => c.change_type === "task_removed").length;
                    const datesChanged = changes.filter((c) => c.change_type === "date_changed").length;
                    const impactParts = [
                      hoursDelta !== 0 ? `${hoursDelta > 0 ? "+" : ""}${hoursDelta}h` : null,
                      tasksAdded > 0 ? `+${tasksAdded} task${tasksAdded === 1 ? "" : "s"}` : null,
                      tasksRemoved > 0 ? `-${tasksRemoved} task${tasksRemoved === 1 ? "" : "s"}` : null,
                      datesChanged > 0 ? `${datesChanged} date${datesChanged === 1 ? "" : "s"} changed` : null,
                    ].filter(Boolean);
                    const statusTone =
                      r.status === "applied"
                        ? { bg: "var(--success-bg)", color: "var(--success-text)" }
                        : r.status === "discarded"
                        ? { bg: "var(--hover-bg)", color: "var(--muted)" }
                        : { bg: "var(--warning-bg)", color: "var(--warning-text)" };
                    return (
                      <div key={r.id} style={{ position: "relative", marginBottom: idx === arr.length - 1 ? 0 : 14 }}>
                        <span
                          style={{
                            position: "absolute",
                            left: -16,
                            top: 3,
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            background: statusTone.color,
                          }}
                        />
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          <strong style={{ fontSize: 12 }}>Revision {r.revision_number}</strong>
                          <span
                            style={{
                              fontSize: 10,
                              fontWeight: 600,
                              textTransform: "uppercase",
                              padding: "1px 6px",
                              borderRadius: "var(--radius-btn)",
                              background: statusTone.bg,
                              color: statusTone.color,
                            }}
                          >
                            {r.status}
                          </span>
                        </div>
                        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{formatDate(r.started_at.slice(0, 10))}</div>
                        <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
                          {impactParts.length > 0 ? `Impact: ${impactParts.join(", ")}` : "No changes recorded"}
                        </div>
                      </div>
                    );
                  })}
                  {activeBaseline && (
                    <div style={{ position: "relative", marginTop: 14 }}>
                      <span
                        style={{
                          position: "absolute",
                          left: -16,
                          top: 3,
                          width: 8,
                          height: 8,
                          borderRadius: "50%",
                          background: "var(--muted)",
                        }}
                      />
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <strong style={{ fontSize: 12 }}>Baseline V{activeBaseline.version_number}</strong>
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 600,
                            textTransform: "uppercase",
                            padding: "1px 6px",
                            borderRadius: "var(--radius-btn)",
                            background: "var(--hover-bg)",
                            color: "var(--muted)",
                          }}
                        >
                          Locked
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                        {formatDate(activeBaseline.captured_at.slice(0, 10))}
                      </div>
                    </div>
                  )}
                </div>
              )}
              <button
                className="btn-secondary"
                style={{ width: "100%", marginTop: 12 }}
                onClick={() => navigate(`/projects/${project.id}/audit-trail`)}
              >
                View Full Audit Trail
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Design spec item 8 (Sandra, 2026-07-29): bottom status bar --
          mirrors the top banner's status chip but adds forward-looking
          "what's next" copy and the workflow's next actions, so someone
          scrolled to the bottom of a long task list/Gantt doesn't have to
          scroll back up to see what to do next. Deliberately kept
          alongside the top banner rather than replacing it (decision #3
          in [[project_capaciq_wbs_ui_redesign_plan]]). */}
      <div
        className="card"
        style={{
          marginTop: 12,
          padding: "12px 14px",
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          background: WBS_STATUS_META[project.wbs_status]?.bg,
          borderColor: WBS_STATUS_META[project.wbs_status]?.border,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 700, color: WBS_STATUS_META[project.wbs_status]?.color }}>
          {WBS_STATUS_META[project.wbs_status]?.label ?? project.wbs_status}
        </span>
        <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
          {project.wbs_status === "draft" && "Lock the baseline once scoping is final to start tracking against it."}
          {project.wbs_status === "baseline_locked" && "Start a revision to make changes, or close the project once work is complete."}
          {project.wbs_status === "changed_after_baseline" &&
            "This plan differs from the original baseline. Start another revision, re-baseline to make this the new official plan, or close the project."}
          {project.wbs_status === "revision_in_progress" && "Apply or discard your revision using the buttons above to continue."}
          {project.wbs_status === "closed" && "Final Scope is locked. View the audit trail for a full history of every revision."}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          {canManageWbs && (project.wbs_status === "baseline_locked" || project.wbs_status === "changed_after_baseline") && (
            <button className="btn-secondary" disabled={workflowBusy} onClick={handleStartRevision}>
              Start New Revision
            </button>
          )}
          {project.wbs_status !== "draft" && (
            <button className="btn-secondary" onClick={() => navigate(`/projects/${project.id}/audit-trail`)}>
              View Audit Trail
            </button>
          )}
          {canManageWbs &&
            (project.wbs_status === "baseline_locked" || project.wbs_status === "changed_after_baseline") &&
            !pendingClosure && (
              <button className="btn-primary" disabled={workflowBusy} onClick={handleRequestClosure}>
                Close Project
              </button>
            )}
        </div>
      </div>
    </div>
  );
}

// "Depends on" picker -- a lightweight multi-select popover, built local to
// this file since no shared multi-select component exists yet elsewhere in
// the app (InlineSelect is single-value only). Round 1 of task dependencies
// (2026-07-24): Finish-to-Start only, same-project only, set via this
// dropdown -- drag-linking directly on the Gantt chart is a deferred
// follow-up, not built here. Selecting a predecessor does NOT lock or
// compute this task's own Start date; it only feeds the conflict-warning
// check back in the parent (dependencyConflict), since Sandra chose to
// keep Start freely editable rather than making it computed like a
// parent-task rollup.
//
// Round 12 fix (Sandra: "the dependency list is hidden. Unable to see the
// rest of the list. Scroll is not working either"): the popover used to be
// `position: absolute` inside this cell's own `<td>`, which sits inside the
// table's `overflowX: auto` wrapper card -- any ancestor with `overflow`
// set clips an absolutely-positioned descendant to its own box once the
// popover would otherwise extend past it (same class of bug already
// documented once before for a different table, see
// [[feedback_table_cell_popover_clipping]]). Fixed by portaling the
// popover straight to `document.body` with `position: fixed`, positioned
// from the trigger button's own `getBoundingClientRect()` at open time --
// nothing about it lives inside the table's DOM subtree anymore, so no
// ancestor's overflow/clipping rule can touch it. Also flips to render
// ABOVE the button instead of below when there isn't enough room left in
// the viewport underneath it.
// Phase 3 (2026-07-28): generalized "Compare with Baseline" -- unlike
// BaselineReport.tsx (which only ever compares against the FINAL close-out
// snapshot), this can be opened at any point once a baseline exists, and
// diffs the active Baseline (project_baselines, is_active = true) against
// whatever is live on screen right now (passed in as `liveTasks`, the same
// snapshot shape the lock/apply/decide RPCs persist -- see
// buildTaskSnapshotPayload above).
interface BaselineTaskSnapshot {
  task_id: string;
  name: string;
  estimated_hours: number | null;
}
interface LiveTaskSnapshot {
  task_id: string;
  name: string;
  estimated_hours: number | null;
  parent_task_id: string | null;
}
function CompareWithBaselinePanel({ projectId, liveTasks }: { projectId: string; liveTasks: LiveTaskSnapshot[] }) {
  const [baseline, setBaseline] = useState<{ version_number: number; total_est_hours: number; task_count: number; captured_at: string } | null>(null);
  const [baselineTasks, setBaselineTasks] = useState<BaselineTaskSnapshot[]>([]);
  // Sandra, 2026-07-29: "Overall Variance" was hardcoding the Current Plan
  // label as baseline.version_number + 1 -- always "V2" no matter how many
  // revisions had actually been applied since that baseline was locked
  // (she was on Revision 5 but the panel still said "Current Plan V2").
  // Fix: count APPLIED revisions whose applied_at is after this baseline's
  // captured_at, and add that count on top of the baseline version instead
  // of always assuming exactly one change.
  const [appliedSinceBaseline, setAppliedSinceBaseline] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      const { data: bl } = await supabase
        .from("project_baselines")
        .select("id,version_number,total_est_hours,task_count,captured_at")
        .eq("project_id", projectId)
        .eq("is_active", true)
        .maybeSingle();
      if (!active) return;
      if (bl) {
        const baselineRow = bl as { id: string; version_number: number; total_est_hours: number; task_count: number; captured_at: string };
        setBaseline(baselineRow);
        const [{ data: blt }, { data: appliedRevs }] = await Promise.all([
          supabase.from("project_baseline_tasks").select("task_id,name,estimated_hours").eq("baseline_id", baselineRow.id),
          supabase
            .from("project_revisions")
            .select("id")
            .eq("project_id", projectId)
            .eq("status", "applied")
            .gt("applied_at", baselineRow.captured_at),
        ]);
        if (active) {
          setBaselineTasks((blt as BaselineTaskSnapshot[]) ?? []);
          setAppliedSinceBaseline((appliedRevs ?? []).length);
        }
      } else {
        setBaseline(null);
        setBaselineTasks([]);
        setAppliedSinceBaseline(0);
      }
      if (active) setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [projectId]);

  const liveTotalHours = liveTasks.filter((t) => !t.parent_task_id).reduce((sum, t) => sum + (t.estimated_hours ?? 0), 0);
  const liveTaskCount = liveTasks.length;

  const baselineIds = new Set(baselineTasks.map((t) => t.task_id));
  const liveIds = new Set(liveTasks.map((t) => t.task_id));
  const added = liveTasks.filter((t) => !baselineIds.has(t.task_id));
  const removed = baselineTasks.filter((t) => !liveIds.has(t.task_id));
  const changed = liveTasks
    .filter((t) => baselineIds.has(t.task_id))
    .map((t) => ({ live: t, base: baselineTasks.find((b) => b.task_id === t.task_id)! }))
    .filter(({ live, base }) => (live.estimated_hours ?? 0) !== (base.estimated_hours ?? 0));

  const hoursVariance = baseline ? liveTotalHours - baseline.total_est_hours : 0;
  const taskVariance = baseline ? liveTaskCount - baseline.task_count : 0;
  const currentPlanLabel = baseline ? `Current Plan V${baseline.version_number + appliedSinceBaseline}` : "Current Plan";

  function varianceCell(delta: number, suffix: string) {
    if (delta === 0) return <span style={{ color: "var(--muted)" }}>No variance</span>;
    return (
      <span style={{ color: "var(--warning-text, #b45309)", fontWeight: 600 }}>
        {delta > 0 ? "+" : ""}
        {delta}
        {suffix}
      </span>
    );
  }

  return (
    // Design spec item 5 (Sandra, 2026-07-29): renamed from "Compare with
    // Baseline" to "Overall Variance", restyled from stat-pair blocks to
    // the reference's more literal Metric/Baseline/Current-Plan/Variance
    // table layout. Same underlying data/logic (Phase 3's baseline vs
    // live-tasks diff) -- this is a presentation change only, per decision
    // #2 in [[project_capaciq_wbs_ui_redesign_plan]] (full per-field diff
    // depth stays deferred; this is still the aggregate-only comparison).
    <div className="card" style={{ padding: 14 }}>
      <strong style={{ fontSize: 12.5, color: "var(--navy)" }}>Overall Variance</strong>
      {loading ? (
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6 }}>Loading…</div>
      ) : !baseline ? (
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6 }}>No baseline locked yet.</div>
      ) : (
        <>
          <table style={{ width: "100%", marginTop: 8, fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "4px 6px", color: "var(--muted)", fontSize: 11, fontWeight: 600 }}>Metric</th>
                <th style={{ textAlign: "left", padding: "4px 6px", color: "var(--muted)", fontSize: 11, fontWeight: 600 }}>Baseline V{baseline.version_number}</th>
                <th style={{ textAlign: "left", padding: "4px 6px", color: "var(--muted)", fontSize: 11, fontWeight: 600 }}>{currentPlanLabel}</th>
                <th style={{ textAlign: "left", padding: "4px 6px", color: "var(--muted)", fontSize: 11, fontWeight: 600 }}>Variance</th>
              </tr>
            </thead>
            <tbody>
              <tr style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "5px 6px" }}>Est. hours</td>
                <td style={{ padding: "5px 6px" }}>{baseline.total_est_hours}h</td>
                <td style={{ padding: "5px 6px" }}>{liveTotalHours}h</td>
                <td style={{ padding: "5px 6px" }}>{varianceCell(hoursVariance, "h")}</td>
              </tr>
              <tr style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "5px 6px" }}>Task count</td>
                <td style={{ padding: "5px 6px" }}>{baseline.task_count}</td>
                <td style={{ padding: "5px 6px" }}>{liveTaskCount}</td>
                <td style={{ padding: "5px 6px" }}>{varianceCell(taskVariance, "")}</td>
              </tr>
            </tbody>
          </table>
          {/* Sandra, 2026-07-29 follow-up: removed the per-task
              added/removed/changed detail list that used to sit below
              this table -- redundant now that the task list's own
              Changes vs Baseline + Notes columns show the same
              per-task detail directly. */}
        </>
      )}
    </div>
  );
}

// Round 2 of the WBS UI redesign (Sandra, 2026-07-29): consolidates the
// header's growing button row (Start Revision/Re-baseline/Revision
// History/Compare with Baseline) into one "Actions" dropdown, leaving
// just the single primary CTA (Lock Baseline / Close Project / Apply
// Revision, whichever applies to the current status) visible directly.
// Same portal-to-document.body pattern as DependsOnPicker below, since a
// locally `absolute` popover risks the same table/card clipping issue
// noted in [[feedback_table_cell_popover_clipping]].
function ActionsMenu({ items }: { items: { label: string; onClick: () => void; disabled?: boolean }[] }) {
  const [isOpen, setIsOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const MENU_WIDTH = 200;

  if (items.length === 0) return null;

  function handleToggle() {
    if (!isOpen && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const left = Math.max(4, Math.min(rect.right - MENU_WIDTH, document.documentElement.clientWidth - MENU_WIDTH - 4));
      setPos({ top: rect.bottom + 4, left });
    }
    setIsOpen((v) => !v);
  }

  return (
    <div style={{ position: "relative" }}>
      <button ref={btnRef} className="btn-secondary" onClick={handleToggle}>
        Actions <ChevronDown size={14} />
      </button>
      {isOpen &&
        pos &&
        createPortal(
          <>
            <div style={{ position: "fixed", inset: 0, zIndex: 1000 }} onClick={() => setIsOpen(false)} />
            <div
              className="card"
              style={{
                position: "fixed",
                top: pos.top,
                left: pos.left,
                width: MENU_WIDTH,
                padding: 4,
                zIndex: 1001,
                boxShadow: "0 4px 14px rgba(0,0,0,0.18)",
              }}
            >
              {items.map((it) => (
                <button
                  key={it.label}
                  disabled={it.disabled}
                  onClick={() => {
                    setIsOpen(false);
                    it.onClick();
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    padding: "7px 10px",
                    fontSize: 12,
                    borderRadius: 6,
                    cursor: it.disabled ? "default" : "pointer",
                    color: it.disabled ? "var(--muted)" : "var(--text)",
                  }}
                  onMouseEnter={(e) => {
                    if (!it.disabled) e.currentTarget.style.background = "var(--hover-bg)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                  }}
                >
                  {it.label}
                </button>
              ))}
            </div>
          </>,
          document.body
        )}
    </div>
  );
}

function DependsOnPicker({
  task,
  allTasks,
  dependsOnIds,
  isOpen,
  editable = true,
  onToggle,
  onClose,
  onAdd,
  onRemove,
}: {
  task: TaskRow & { depth: number };
  allTasks: (TaskRow & { depth: number })[];
  dependsOnIds: string[];
  isOpen: boolean;
  editable?: boolean;
  onToggle: () => void;
  onClose: () => void;
  onAdd: (depId: string) => void;
  onRemove: (depId: string) => void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; openUp: boolean } | null>(null);
  const candidates = allTasks.filter((t) => t.id !== task.id);
  const selectedNames = dependsOnIds
    .map((id) => allTasks.find((t) => t.id === id)?.name)
    .filter((n): n is string => !!n);

  const PANEL_WIDTH = 240;
  const PANEL_MAX_HEIGHT = 260;

  function handleToggle() {
    if (!isOpen && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const roomBelow = window.innerHeight - rect.bottom;
      const openUp = roomBelow < PANEL_MAX_HEIGHT && rect.top > roomBelow;
      setPos({
        top: openUp ? rect.top - 4 : rect.bottom + 4,
        left: Math.min(rect.left, window.innerWidth - PANEL_WIDTH - 8),
        openUp,
      });
    }
    onToggle();
  }

  return (
    <div style={{ position: "relative" }}>
      <button
        ref={btnRef}
        type="button"
        disabled={!editable}
        onClick={editable ? handleToggle : undefined}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          width: "100%",
          textAlign: "left",
          background: "transparent",
          border: "none",
          cursor: editable ? "pointer" : "default",
          padding: "3px 4px",
          borderRadius: 4,
          fontSize: 11.5,
          color: selectedNames.length ? "var(--text)" : "var(--muted)",
        }}
        title={editable ? (selectedNames.length ? selectedNames.join(", ") : "No dependencies -- click to add") : selectedNames.join(", ") || undefined}
      >
        <Link2 size={12} style={{ flexShrink: 0, color: "var(--muted)" }} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selectedNames.length ? selectedNames.join(", ") : "None"}
        </span>
      </button>

      {editable &&
        isOpen &&
        pos &&
        createPortal(
          <>
            {/* Transparent click-outside-to-close backdrop, same trick used
                elsewhere for lightweight popovers in this app rather than a
                document-level event listener. */}
            <div style={{ position: "fixed", inset: 0, zIndex: 1000 }} onClick={onClose} />
            <div
              className="card"
              style={{
                position: "fixed",
                top: pos.openUp ? undefined : pos.top,
                bottom: pos.openUp ? window.innerHeight - pos.top : undefined,
                left: pos.left,
                width: PANEL_WIDTH,
                maxHeight: PANEL_MAX_HEIGHT,
                overflowY: "auto",
                zIndex: 1001,
                padding: 6,
                boxShadow: "0 4px 14px rgba(0,0,0,0.18)",
              }}
            >
              {candidates.length === 0 && <div style={{ fontSize: 11.5, color: "var(--muted)", padding: 4 }}>No other tasks yet.</div>}
              {candidates.map((c) => {
                const checked = dependsOnIds.includes(c.id);
                return (
                  <label
                    key={c.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "4px 4px",
                      fontSize: 11.5,
                      cursor: "pointer",
                      borderRadius: 3,
                    }}
                  >
                    <input type="checkbox" checked={checked} onChange={() => (checked ? onRemove(c.id) : onAdd(c.id))} />
                    <span style={{ paddingLeft: c.depth * 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                  </label>
                );
              })}
            </div>
          </>,
          document.body
        )}
    </div>
  );
}
