import { useState, useEffect, useRef, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams, Link } from "react-router-dom";
import { ArrowLeft, Plus, ChevronLeft, ChevronRight, Info, AlertTriangle, Link2, Trash2 } from "lucide-react";
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

interface ProjectRow {
  id: string;
  name: string;
  owner_id: string | null;
  start_date: string | null;
  end_date: string | null;
  timelines_locked: boolean;
  phase: string | null;
  status: string | null;
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
  const [loading, setLoading] = useState(true);
  const [activeMode, setActiveMode] = useState<Mode>("full_capacity");
  const [saving, setSaving] = useState(false);
  const [utilWindowOffset, setUtilWindowOffset] = useState(0); // in units of UTIL_WINDOW_DAYS blocks

  async function loadAll() {
    if (!projectId) return;
    setLoading(true);
    const [{ data: proj }, { data: tks }, { data: ppl }, { data: avail }, { data: hols }, { data: allTks }, { data: allProjs }] = await Promise.all([
      supabase.from("projects").select("id,name,owner_id,start_date,end_date,timelines_locked,phase,status").eq("id", projectId).single(),
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
    setLoading(false);
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
  function computeOrderedTasks(): (TaskRow & { depth: number })[] {
    const roots = tasks.filter((t) => !t.parent_task_id);
    const out: (TaskRow & { depth: number })[] = [];
    for (const r of roots) {
      out.push({ ...r, depth: 0 });
      for (const c of tasks.filter((t) => t.parent_task_id === r.id)) out.push({ ...c, depth: 1 });
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
    const noEffort = orderedTasks.filter((t) => !t.effort);
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
    if (
      !(await confirm(
        `Save this project's timelines using ${verb}?\n\nThis writes every task's computed End date (Start dates are already saved per-task) and records both modes for reporting. Timelines stay unlocked -- lock from the Tasks page's Timelines column when you're ready to finalize.`
      ))
    )
      return;

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
      await loadAll();
      await alert(`Saved using ${verb}. Timelines are still unlocked -- finalize from the Tasks page when ready.`);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>Loading…</div>;
  if (!project) return <div style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>Project not found.</div>;

  function modeColStyle(m: Mode): CSSProperties {
    return m === activeMode ? { background: "#eaf1fb" } : {};
  }

  // A visible box around the header's editable fields (Project name,
  // Owner) -- Sandra: "make it evident that thos fields needs to be
  // filled." Plain `.inline-cell` inputs only show a border on
  // hover/focus, so an empty one (no Owner picked yet) looked
  // indistinguishable from static text. A permanent, subtle border makes
  // clear these are fillable fields even at rest; an unfilled field gets
  // a dashed border in the muted/warning tone as a nudge to fill it in.
  function fieldBoxStyle(isFilled: boolean, minWidth = 110): CSSProperties {
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
              editable={!isParent}
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
    ...orderedTasks.map((t) => {
      const entry = chainByMode[activeMode].get(t.id);
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
      end_date: summaries[activeMode].end,
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
  const GANTT_DAY_WIDTH = 28;
  const GANTT_NAME_COL_WIDTH = 220;
  const GANTT_HEADER_HEIGHT = 24; // matches the date-label row's own height
  const GANTT_ROW_HEIGHT = 26; // matches each task row's own height
  const activeSummary = summaries[activeMode];
  const ganttStartDate = activeSummary.start ? addDays(parseLocalDate(activeSummary.start), -1) : null;
  const ganttEndDate = activeSummary.end ? addDays(parseLocalDate(activeSummary.end), 1) : null;
  const ganttDays: Date[] =
    ganttStartDate && ganttEndDate
      ? (() => {
          const days: Date[] = [];
          for (let d = new Date(ganttStartDate); d <= ganttEndDate; d = addDays(d, 1)) days.push(new Date(d));
          return days;
        })()
      : [];
  const ganttWidthPx = ganttDays.length * GANTT_DAY_WIDTH;

  function ganttDayOffsetPx(dateStr: string): number {
    if (!ganttStartDate) return 0;
    const diffDays = Math.round((parseLocalDate(dateStr).getTime() - ganttStartDate.getTime()) / 86400000);
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
  function ganttConnectors() {
    const rowIndexOf = new Map(orderedTasks.map((t, i) => [t.id, i]));
    const elems: JSX.Element[] = [];
    for (const t of orderedTasks) {
      const depIds = dependsOnIdsFor(t.id);
      if (!depIds.length) continue;
      const succEntry = chainByMode[activeMode].get(t.id);
      const succRow = rowIndexOf.get(t.id);
      if (!succEntry || succRow === undefined) continue;
      for (const depId of depIds) {
        const predEntry = chainByMode[activeMode].get(depId);
        const predRow = rowIndexOf.get(depId);
        if (!predEntry || predRow === undefined) continue;
        const x1 = GANTT_NAME_COL_WIDTH + ganttDayOffsetPx(predEntry.end) + GANTT_DAY_WIDTH;
        const y1 = GANTT_HEADER_HEIGHT + predRow * GANTT_ROW_HEIGHT + GANTT_ROW_HEIGHT / 2;
        const x2 = GANTT_NAME_COL_WIDTH + ganttDayOffsetPx(succEntry.start);
        const y2 = GANTT_HEADER_HEIGHT + succRow * GANTT_ROW_HEIGHT + GANTT_ROW_HEIGHT / 2;
        const midX = x1 + Math.max((x2 - x1) / 2, 6);
        const conflict = succEntry.start <= predEntry.end;
        const path = `M ${x1} ${y1} H ${midX} V ${y2} H ${x2}`;
        elems.push(
          <path
            key={`${depId}->${t.id}`}
            d={path}
            fill="none"
            stroke={conflict ? "var(--warning-text, #b45309)" : "var(--border)"}
            strokeWidth={conflict ? 1.5 : 1}
            strokeDasharray={conflict ? undefined : "3,3"}
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
      <p className="subtitle">
        Plot the project's own Start date above -- it anchors the first task in each mode when there's nothing earlier to chain from. Full Effort and
        Conservative Effort each get their own independent Start/End/Duration below (7.5h/day vs 4h/day), since the same task can genuinely start on a
        different day under each mode. Set "Depends on" to flag a task that should follow another -- doing so moves that dependency's Start (under
        each mode, independently) to right after its predecessor's own End under that same mode, but it stays yours to edit afterward; a task starting
        on or before its dependency's own End gets a warning icon. The "Save using" toggle only affects the Gantt, the utilization preview, and which
        mode's numbers Save actually commits -- it no longer changes what the scoping table itself shows.
      </p>

      {project.timelines_locked ? (
        <div className="card" style={{ padding: 14, fontSize: 12.5, color: "var(--muted)" }}>
          Timelines for this project are already locked. Unlock from the Projects table first if you need to re-plan.
        </div>
      ) : (
        <>
          <div className="card" style={{ padding: 14, marginBottom: 12, display: "flex", alignItems: "center", gap: 16, flexWrap: "nowrap", overflowX: "auto" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy)" }}>Project:</span>
              <div className="wbs-field-box" style={fieldBoxStyle(!!project.name, 170)}>
                <InlineText value={project.name} editable onCommit={(v) => saveProjectField({ name: v })} />
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy)" }}>Owner:</span>
              <div className="wbs-field-box" style={fieldBoxStyle(true)}>
                <InlineSelect
                  value={owner?.name ?? ""}
                  editable
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
              <div className="wbs-field-box" style={fieldBoxStyle(true)}>
                <InlineDate value={project.start_date} editable onCommit={(v) => saveProjectField({ start_date: v })} />
              </div>
              <span
                title="Your own plotted anchor -- used as the default Start for the very first task in each mode when there's nothing earlier to chain from. No longer auto-pulled from tasks."
                style={{ display: "inline-flex", cursor: "help", flexShrink: 0 }}
              >
                <Info size={13} style={{ color: "var(--muted)" }} />
              </span>
            </div>
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--navy)" }}>Save using:</span>
              <div className="timeline-segmented">
                {MODES.map((m) => (
                  <button key={m} className={`timeline-segmented-btn${activeMode === m ? " active" : ""}`} onClick={() => setActiveMode(m)}>
                    {MODE_LABEL[m]}
                  </button>
                ))}
              </div>
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
          <div className="card" style={{ padding: 16, marginBottom: 12, display: "flex", gap: 28, flexWrap: "wrap" }}>
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
              <span
                className="status-pill neutral"
                style={{ marginTop: 2, display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11 }}
                title="The total hours don't change between modes -- only how many days they take to fit."
              >
                🔒 Fixed total effort
              </span>
            </div>

            <div style={{ flex: 1, minWidth: 340 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy)", marginBottom: 12 }}>Effort Comparison (by Duration)</div>
              {MODES.map((m, i) => {
                const s = summaries[m];
                const color = m === "full_capacity" ? "#3b82f6" : "#22c55e";
                const rate = m === "full_capacity" ? "7.5 h/day" : "4 h/day";
                const maxDuration = Math.max(summaries.full_capacity.durationDays, summaries.standard.durationDays, 1);
                const widthPct = s.durationDays ? Math.max(18, Math.round((s.durationDays / maxDuration) * 100)) : 0;
                return (
                  <div
                    key={m}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 16,
                      marginBottom: i === MODES.length - 1 ? 0 : 14,
                    }}
                  >
                    <div style={{ width: 165, flexShrink: 0, fontSize: 12, fontWeight: 600, color }}>
                      {MODE_LABEL[m]} ({rate})
                    </div>
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
                    <div style={{ width: 100, fontSize: 11.5, flexShrink: 0 }}>
                      <div style={{ fontWeight: 600, color: "var(--muted)", fontSize: 10 }}>Duration</div>
                      <div>
                        {s.durationDays ? `${s.durationDays} working day${s.durationDays === 1 ? "" : "s"}` : "—"}
                        {!s.complete && s.end ? " · incomplete" : ""}
                      </div>
                    </div>
                  </div>
                );
              })}
              <div
                style={{
                  borderTop: "1px solid var(--border)",
                  marginTop: 12,
                  paddingTop: 8,
                  fontSize: 11,
                  color: "var(--muted)",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <Info size={12} style={{ flexShrink: 0 }} />
                Effort hours stay fixed at {totalEffortHours}h. Timeline changes based on daily capacity: Full Effort = 7.5h/day, Conservative Effort =
                4h/day.
              </div>
            </div>
          </div>

          {/* Live utilization heat-map -- same points/tier formula as the
              Utilization page, fed this project's DRAFT plan (including
              its own draft Owner/derived-span for PM overhead) */}
          <div className="card" style={{ padding: 14, marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <strong style={{ fontSize: 12.5, color: "var(--navy)" }}>Utilization snapshot</strong>
              <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
                Live preview -- updates as you assign people, set effort, set Start dates, and pick an Owner, using {MODE_LABEL[activeMode]}'s current
                schedule.
              </span>
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

          <div className="card" style={{ padding: 0, overflowX: "auto" }}>
            <table className="data-table" style={{ width: "100%" }}>
              <thead>
                <tr>
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
                    <td colSpan={11} style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>
                      No tasks in this project yet.
                    </td>
                  </tr>
                )}
                {orderedTasks.map((t) => {
                  const isParent = t.depth === 0 && hasChildren(t.id);
                  const assignee = people.find((p) => p.id === t.assignee_id);
                  const dependsOnIds = dependsOnIdsFor(t.id);
                  return (
                    <tr key={t.id}>
                      <td>
                        <div style={{ paddingLeft: t.depth * 16, fontWeight: t.depth === 0 ? 600 : 400, display: "flex", alignItems: "center", gap: 4 }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <InlineText value={t.name} editable bold={t.depth === 0} onCommit={(v) => saveTaskField(t.id, { name: v })} />
                          </div>
                          {t.depth === 0 && (
                            <button className="add-subtask-btn" onClick={() => addSubtask(t)} title="Add sub-task">
                              <Plus size={14} />
                            </button>
                          )}
                          <button className="add-subtask-btn" onClick={() => deleteTask(t)} title={isParent ? "Delete task (and its sub-tasks)" : "Delete task"}>
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                      <td>
                        <span title={isParent ? "Computed from this task's own sub-tasks (sum of their Est. hrs)" : undefined}>
                          <InlineNumber
                            value={t.estimated_hours}
                            editable={!isParent}
                            onCommit={(v) => saveTaskField(t.id, { estimated_hours: v })}
                          />
                        </span>
                      </td>
                      <td>
                        <InlineSelect
                          value={t.effort ?? ""}
                          editable
                          allowEmpty
                          emptyLabel="Pick effort"
                          options={TASK_EFFORT_OPTIONS}
                          renderReadOnly={(v) => (v ? <span className={`status-pill ${TASK_EFFORT_DEFAULT_TONES[v] ?? "neutral"}`}>{v}</span> : "Pick effort")}
                          onCommit={(v) => saveTaskField(t.id, { effort: v || null })}
                        />
                      </td>
                      <td>
                        <InlineSelect
                          value={assignee?.name ?? ""}
                          editable
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
                      </td>
                      <td style={{ position: "relative" }}>
                        <DependsOnPicker
                          task={t}
                          allTasks={orderedTasks}
                          dependsOnIds={dependsOnIds}
                          isOpen={depPickerOpenFor === t.id}
                          onToggle={() => setDepPickerOpenFor((prev) => (prev === t.id ? null : t.id))}
                          onClose={() => setDepPickerOpenFor(null)}
                          onAdd={(depId) => addDependency(t.id, depId)}
                          onRemove={(depId) => removeDependency(t.id, depId)}
                        />
                      </td>
                      {renderModeCells(t, "full_capacity", isParent)}
                      {renderModeCells(t, "standard", isParent)}
                    </tr>
                  );
                })}
                <tr>
                  <td colSpan={11} className="add-row-cell">
                    <div className="add-row-trigger" onClick={addTopLevelTask}>
                      <Plus size={12} />
                      New task
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Timeline (Gantt) -- always visible below the table, showing
              whichever mode is active. Built as absolutely-positioned bars
              over a plain day grid rather than a table, so a bar can span
              multiple days without colSpan gymnastics. */}
          <div className="card" style={{ padding: 14, marginTop: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <strong style={{ fontSize: 12.5, color: "var(--navy)" }}>Timeline (Gantt)</strong>
              <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
                Showing {MODE_LABEL[activeMode]}'s current schedule. Bars are colored by Assignee -- set colors in User management.
              </span>
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
                  const entry = chainByMode[activeMode].get(t.id);
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
                                left: ganttDayOffsetPx(iso),
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
                              left: ganttDayOffsetPx(entry.start),
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
                  {ganttConnectors()}
                </svg>
                </div>
              </div>
            )}
          </div>

          <div className="card" style={{ padding: 14, marginTop: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <button className="btn-primary" disabled={saving} onClick={saveDraft}>
              {saving ? "Saving…" : `Save using ${MODE_LABEL[activeMode]}`}
            </button>
            <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
              Writes {MODE_LABEL[activeMode]}'s End dates onto every task. Nothing is locked -- finalize later from the Tasks page.
            </span>
          </div>
        </>
      )}
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
function DependsOnPicker({
  task,
  allTasks,
  dependsOnIds,
  isOpen,
  onToggle,
  onClose,
  onAdd,
  onRemove,
}: {
  task: TaskRow & { depth: number };
  allTasks: (TaskRow & { depth: number })[];
  dependsOnIds: string[];
  isOpen: boolean;
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
        onClick={handleToggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          width: "100%",
          textAlign: "left",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          padding: "3px 4px",
          borderRadius: 4,
          fontSize: 11.5,
          color: selectedNames.length ? "var(--text)" : "var(--muted)",
        }}
        title={selectedNames.length ? selectedNames.join(", ") : "No dependencies -- click to add"}
      >
        <Link2 size={12} style={{ flexShrink: 0, color: "var(--muted)" }} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selectedNames.length ? selectedNames.join(", ") : "None"}
        </span>
      </button>

      {isOpen &&
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
