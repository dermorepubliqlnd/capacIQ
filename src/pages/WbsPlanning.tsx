import { useState, useEffect, type CSSProperties } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { ArrowLeft, Plus, ChevronLeft, ChevronRight } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useSession } from "../lib/useSession";
import { useConfirm } from "../lib/useConfirm";
import { InlineText, InlineNumber, InlineSelect, InlineDate } from "../components/InlineCell";
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
}
interface AvailabilityRow {
  person_id: string;
  date: string;
  status: "off" | "half_day";
}
interface HolidayRow {
  date: string;
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
        .select("id,project_id,parent_task_id,name,assignee_id,status,start_date,current_due_date,estimated_hours,effort,is_archived,sort_order")
        .eq("project_id", projectId)
        .eq("is_archived", false)
        .order("sort_order"),
      supabase.from("people").select("id,name,daily_capacity_hours,is_active").eq("is_active", true).order("name"),
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
    setLoading(false);
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
  // isn't a stored field until Save).
  function subtaskStartMin(parentId: string): string | null {
    const children = tasks.filter((t) => t.parent_task_id === parentId);
    const withStart = children.filter((t) => !!t.start_date);
    if (withStart.length === 0) return null;
    return withStart.reduce((min, t) => ((t.start_date as string).slice(0, 10) < min ? (t.start_date as string).slice(0, 10) : min), (withStart[0].start_date as string).slice(0, 10));
  }

  useEffect(() => {
    for (const t of tasks) {
      if (t.parent_task_id) continue;
      if (!hasChildren(t.id)) continue;
      const sum = subtaskHoursSum(t.id);
      const minStart = subtaskStartMin(t.id);
      const patch: Partial<TaskRow> = {};
      if (sum !== t.estimated_hours) patch.estimated_hours = sum;
      if (minStart !== (t.start_date ? t.start_date.slice(0, 10) : null)) patch.start_date = minStart;
      if (Object.keys(patch).length > 0) saveTaskField(t.id, patch);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

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
    const start = t.start_date ? t.start_date.slice(0, 10) : null;
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

  // The project's own Start date is now DERIVED -- the earliest top-level
  // task's own Start date -- rather than driving the chain. `null` until
  // at least one top-level task has a Start date set.
  const topLevelStarts = orderedTasks.filter((t) => t.depth === 0 && t.start_date).map((t) => (t.start_date as string).slice(0, 10));
  const derivedProjectStart: string | null = topLevelStarts.length ? topLevelStarts.reduce((min, d) => (d < min ? d : min)) : null;
  const utilAnchorDate = derivedProjectStart ?? fallbackStartDate;

  async function addTopLevelTask() {
    if (!project) return;
    const today = new Date().toISOString().slice(0, 10);
    const roots = orderedTasks.filter((t) => t.depth === 0);
    let defaultStart = derivedProjectStart ?? fallbackStartDate;
    if (roots.length) {
      const last = roots[roots.length - 1];
      const entry = fullChain.get(last.id) ?? standardChain.get(last.id);
      if (entry) defaultStart = nextWorkingDayAfter(entry.end, holidaySet);
    }
    const defaultDue = project.end_date ?? today;
    const { error } = await supabase.from("tasks").insert({
      project_id: project.id,
      name: "Untitled task",
      status: "Not Started",
      start_date: defaultStart,
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
    let defaultStart = parent.start_date ? parent.start_date.slice(0, 10) : derivedProjectStart ?? fallbackStartDate;
    if (siblings.length) {
      const last = siblings[siblings.length - 1];
      const entry = fullChain.get(last.id) ?? standardChain.get(last.id);
      if (entry) defaultStart = nextWorkingDayAfter(entry.end, holidaySet);
    }
    const { error } = await supabase.from("tasks").insert({
      project_id: parent.project_id,
      parent_task_id: parent.id,
      name: "Untitled sub-task",
      status: "Not Started",
      start_date: defaultStart,
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

  // Keeps `projects.start_date` in sync with the derived value, so the
  // rest of the app (Projects table's own Start column, etc.) reflects
  // the same "earliest task Start date" the WBS page now shows -- per
  // Sandra: "I think this can be auto pulled from the earliest task start
  // date." Only fires once tasks actually have Start dates; doesn't
  // clobber a real existing project.start_date with null just because the
  // page hasn't finished loading tasks yet.
  useEffect(() => {
    if (!project) return;
    if (derivedProjectStart && derivedProjectStart !== (project.start_date ? project.start_date.slice(0, 10) : null)) {
      saveProjectField({ start_date: derivedProjectStart });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derivedProjectStart]);

  // Soft completeness gate -- mirrors the Task name / Effort part of the
  // Projects table's own Lock policy.
  function softIssues(): string[] {
    const issues: string[] = [];
    const noName = orderedTasks.filter((t) => !t.name || !t.name.trim() || t.name === "Untitled task" || t.name === "Untitled sub-task");
    const noEffort = orderedTasks.filter((t) => !t.effort);
    if (noName.length) issues.push(`${noName.length} task(s) still have a placeholder name.`);
    if (noEffort.length) issues.push(`${noEffort.length} task(s) still need an Effort level.`);
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

  function renderScenarioCells(t: TaskRow, mode: Mode) {
    const entry = chainByMode[mode].get(t.id);
    const style = { fontSize: 12, ...modeColStyle(mode) };
    if (!entry) {
      return (
        <>
          <td style={{ ...style, color: "var(--muted)" }}>—</td>
          <td style={{ ...style, color: "var(--muted)" }}>—</td>
        </>
      );
    }
    return (
      <>
        <td style={style}>{entry.end}</td>
        <td style={style}>{entry.durationDays}</td>
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
      start_date: derivedProjectStart,
      end_date: summaries[activeMode].end,
    },
  ];

  const utilWindowStart = addDays(parseLocalDate(utilAnchorDate), utilWindowOffset * UTIL_WINDOW_DAYS);
  const utilDays: Date[] = Array.from({ length: UTIL_WINDOW_DAYS }, (_, i) => addDays(utilWindowStart, i));

  function utilAvailability(personId: string, dateStr: string): AvailabilityRow | undefined {
    return availability.find((a) => a.person_id === personId && a.date === dateStr);
  }

  const owner = people.find((p) => p.id === project.owner_id);

  return (
    <div>
      {dialog}
      <Link to={`/projects/${projectId}`} className="back-link" style={{ display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 8, fontSize: 12.5 }}>
        <ArrowLeft size={13} /> Back to {project.name}
      </Link>
      <h1>WBS Planning — {project.name}</h1>
      <p className="subtitle">
        Set each task's own Start date, Estimated hours, Effort, and Assignee below (all save immediately). End date is auto-computed from that Start
        under each mode's own flat daily rate -- Full Effort at 7.5h/day, Conservative Effort at 4h/day -- independently per task, so tasks can freely
        overlap or run in parallel. The project's own Start date above is auto-pulled from the earliest task's Start date. Save applies the active
        mode's End dates to every task without locking. The utilization panel below (including the Owner's PM-overhead load) updates live as you plan.
      </p>

      {project.timelines_locked ? (
        <div className="card" style={{ padding: 14, fontSize: 12.5, color: "var(--muted)" }}>
          Timelines for this project are already locked. Unlock from the Projects table first if you need to re-plan.
        </div>
      ) : (
        <>
          <div className="card" style={{ padding: 14, marginBottom: 12, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy)" }}>Project:</span>
            <InlineText value={project.name} editable onCommit={(v) => saveProjectField({ name: v })} />
            <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy)" }}>Owner:</span>
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
            <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy)" }}>Start date:</span>
            <span style={{ fontSize: 12.5 }}>{derivedProjectStart ?? "Not set yet"}</span>
            <span style={{ fontSize: 11.5, color: "var(--muted)" }}>Auto-pulled from the earliest task's own Start date below.</span>
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
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

          {/* Project-level summary: total effort + timeline comparison across modes */}
          <div className="card" style={{ padding: 14, marginBottom: 12 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy)", marginBottom: 10 }}>
              Total effort needed: {totalEffortHours}h across {orderedTasks.filter((t) => t.depth === 0).length} task(s)
            </div>
            <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
              {MODES.map((m) => {
                const s = summaries[m];
                return (
                  <div key={m} style={{ minWidth: 180 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.3 }}>
                      {MODE_LABEL[m]}
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 600, marginTop: 2 }}>{s.end ?? "—"}</div>
                    <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
                      {s.end ? `${s.durationDays} working day(s)` : "no schedule yet"}
                      {!s.complete && s.end ? " · incomplete" : ""}
                    </div>
                  </div>
                );
              })}
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
                  {toISO(utilDays[0])} – {toISO(utilDays[utilDays.length - 1])}
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
                  <th rowSpan={2} style={{ width: 110 }}>
                    Start
                  </th>
                  <th colSpan={2} style={{ textAlign: "center", ...modeColStyle("full_capacity") }}>
                    Full Effort
                  </th>
                  <th colSpan={2} style={{ textAlign: "center", ...modeColStyle("standard") }}>
                    Conservative Effort
                  </th>
                </tr>
                <tr>
                  <th style={{ width: 100, ...modeColStyle("full_capacity") }}>End Date</th>
                  <th style={{ width: 90, ...modeColStyle("full_capacity") }}>Duration (days)</th>
                  <th style={{ width: 100, ...modeColStyle("standard") }}>End Date</th>
                  <th style={{ width: 90, ...modeColStyle("standard") }}>Duration (days)</th>
                </tr>
              </thead>
              <tbody>
                {orderedTasks.length === 0 && (
                  <tr>
                    <td colSpan={9} style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>
                      No tasks in this project yet.
                    </td>
                  </tr>
                )}
                {orderedTasks.map((t) => {
                  const isParent = t.depth === 0 && hasChildren(t.id);
                  const assignee = people.find((p) => p.id === t.assignee_id);
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
                          onCommit={(name) => {
                            const p = people.find((pp) => pp.name === name);
                            saveTaskField(t.id, { assignee_id: p?.id ?? null });
                          }}
                        />
                      </td>
                      <td>
                        <span title={isParent ? "Computed from this task's own sub-tasks (earliest Start date)" : undefined}>
                          <InlineDate value={t.start_date} editable={!isParent} onCommit={(v) => saveTaskField(t.id, { start_date: v })} />
                        </span>
                      </td>
                      {renderScenarioCells(t, "full_capacity")}
                      {renderScenarioCells(t, "standard")}
                    </tr>
                  );
                })}
                <tr>
                  <td colSpan={9} className="add-row-cell">
                    <div className="add-row-trigger" onClick={addTopLevelTask}>
                      <Plus size={12} />
                      New task
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
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
