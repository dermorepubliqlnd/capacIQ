import { useState, useEffect, type CSSProperties } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { ArrowLeft, Plus, ChevronLeft, ChevronRight } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useSession } from "../lib/useSession";
import { useConfirm } from "../lib/useConfirm";
import { InlineText, InlineNumber, InlineSelect } from "../components/InlineCell";
import { addDays, buildHolidaySet, isWorkingDay, parseLocalDate, toISO, workingDaysBetween, type HolidaySet } from "../lib/workingDays";
import { fullCapacityScenario, standardScenario, capacityBasedScenario, FULL_CAPACITY_DAILY_HOURS } from "../lib/taskScheduling";
import { TASK_EFFORT_OPTIONS, TASK_EFFORT_DEFAULT_TONES } from "../lib/notionOptions";

interface ProjectRow {
  id: string;
  name: string;
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
  start_date: string | null;
  current_due_date: string;
  estimated_hours: number | null;
  effort: string | null;
  is_archived: boolean;
}
interface PersonRow {
  id: string;
  name: string;
  daily_capacity_hours: number;
  is_active: boolean;
}
interface AllocationRow {
  person_id: string;
  date: string;
  hours: number;
}
interface AvailabilityRow {
  person_id: string;
  date: string;
  status: "off" | "half_day";
}
interface HolidayRow {
  date: string;
}

type Mode = "full_capacity" | "standard" | "capacity_based";
// Sandra, 2026-07-23: "Full Capacity / Standard / Capacity-Based" all leaned
// on the word "capacity" and read as confusing/redundant. Renamed the
// DISPLAY labels only -- the underlying `mode` values stored in
// task_planning_snapshots stay as full_capacity/standard/capacity_based so
// existing rows and code aren't affected, just what's shown on screen.
const MODE_LABEL: Record<Mode, string> = {
  full_capacity: "Full Effort",
  standard: "Conservative Effort",
  capacity_based: "Capacity-Based",
};
const MODES: Mode[] = ["full_capacity", "standard", "capacity_based"];

interface ChainEntry {
  start: string;
  end: string;
  durationDays: number;
  rawDays?: number;
}

const UTIL_WINDOW_DAYS = 28; // 4 weeks, daily view

// WBS planning page (Sandra, 2026-07-23 through 2026-07-24, several design
// rounds -- see project_capaciq_wbs_planning memory for the earlier history):
// - Per task: Estimated hours, Task name, and Effort are directly editable
//   (all autosave immediately, same convention as the rest of the app).
// - Start/End dates are NOT typed per task -- they're computed by chaining
//   from the PROJECT's own Start date (Sandra, 2026-07-24: "The start date
//   on the WBS page will be the project start date"), independently per
//   mode:
//   - Full Effort: PACKED scheduling -- multiple short tasks can share a
//     day's leftover 7.5h capacity instead of each task eating a whole day
//     regardless of size (see buildPackedFullEffortChain below).
//   - Conservative Effort / Capacity-Based: unchanged, one task at a time,
//     jumps to the next working day once a task finishes.
// - "Save" (Sandra, 2026-07-24: replaces the old three-button Finalize)
//   writes ONE active mode's computed dates onto every task (still fully
//   editable afterward on the Tasks page -- nothing is locked here
//   anymore) and snapshots all three modes' numbers per task into
//   task_planning_snapshots for reporting either way. Locking timelines is
//   now ONLY done from the Tasks page's own Lock button (Timelines
//   property) -- this page never locks anything itself.
export default function WbsPlanning() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { person: me } = useSession();
  const { confirm, dialog } = useConfirm();
  const isFullAccess = me?.access_level === "full";

  const [project, setProject] = useState<ProjectRow | null>(null);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [allocations, setAllocations] = useState<AllocationRow[]>([]);
  const [availability, setAvailability] = useState<AvailabilityRow[]>([]);
  const [holidays, setHolidays] = useState<HolidayRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [taskPersonDrafts, setTaskPersonDrafts] = useState<Record<string, string>>({});
  const [activeMode, setActiveMode] = useState<Mode>("full_capacity");
  const [saving, setSaving] = useState(false);
  const [utilWindowOffset, setUtilWindowOffset] = useState(0); // in units of UTIL_WINDOW_DAYS blocks

  async function loadAll() {
    if (!projectId) return;
    setLoading(true);
    const [{ data: proj }, { data: tks }, { data: ppl }, { data: allocs }, { data: avail }, { data: hols }] = await Promise.all([
      supabase.from("projects").select("id,name,start_date,end_date,timelines_locked,phase,status").eq("id", projectId).single(),
      supabase.from("tasks").select("id,project_id,parent_task_id,name,assignee_id,start_date,current_due_date,estimated_hours,effort,is_archived").eq("project_id", projectId).eq("is_archived", false),
      supabase.from("people").select("id,name,daily_capacity_hours,is_active").eq("is_active", true).order("name"),
      supabase.from("time_allocations").select("person_id,date,hours"),
      supabase.from("person_availability").select("person_id,date,status"),
      supabase.from("holidays").select("date"),
    ]);
    setProject((proj as ProjectRow) ?? null);
    setTasks((tks as TaskRow[]) ?? []);
    setPeople((ppl as PersonRow[]) ?? []);
    setAllocations((allocs as AllocationRow[]) ?? []);
    setAvailability((avail as AvailabilityRow[]) ?? []);
    setHolidays((hols as HolidayRow[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const holidaySet = buildHolidaySet(holidays.map((h) => h.date));
  // Anchors the whole chain -- Sandra, 2026-07-24: always the project's own
  // Start date now, no separate editable field on this page. Falls back to
  // today only if the project itself has no Start date set yet.
  const projectStartDate = project?.start_date ? project.start_date.slice(0, 10) : new Date().toISOString().slice(0, 10);

  // Parent tasks first, each followed immediately by its own sub-tasks --
  // same 2-level nesting the Projects table uses elsewhere, and the order
  // the chain below walks in.
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

  // Same rollup rule as the Projects & Tasks page (Sandra, 2026-07-23:
  // "the parent hours can be edited. This should work the same way as
  // when in task DB when handling parent sub task relationships") -- a
  // parent task's own Est. hrs is locked and always mirrors the sum of
  // its direct sub-tasks' Est. hrs, never typed directly. Duplicated here
  // (rather than imported from Projects.tsx) since this page has its own
  // separate `tasks` state/query -- Projects.tsx's own sync effect only
  // runs while that page is mounted, so without this, editing hours here
  // wouldn't keep a parent's total correct.
  function subtaskHoursSum(parentId: string): number | null {
    const children = tasks.filter((t) => t.parent_task_id === parentId);
    const withEstimate = children.filter((t) => t.estimated_hours !== null && t.estimated_hours !== undefined);
    if (withEstimate.length === 0) return null;
    return Math.round(withEstimate.reduce((sum, t) => sum + (t.estimated_hours ?? 0), 0) * 100) / 100;
  }

  useEffect(() => {
    for (const t of tasks) {
      if (t.parent_task_id) continue;
      if (!hasChildren(t.id)) continue;
      const sum = subtaskHoursSum(t.id);
      if (sum !== t.estimated_hours) {
        saveTaskField(t.id, { estimated_hours: sum });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  async function addTopLevelTask() {
    if (!project) return;
    const today = new Date().toISOString().slice(0, 10);
    const defaultDue = project.end_date ?? today;
    const { error } = await supabase.from("tasks").insert({
      project_id: project.id,
      name: "Untitled task",
      status: "Not Started",
      original_due_date: defaultDue,
      current_due_date: defaultDue,
      sort_order: Date.now(),
    });
    if (error) {
      alert(`Couldn't create task: ${error.message}`);
      return;
    }
    loadAll();
  }

  async function addSubtask(parent: TaskRow & { depth: number }) {
    if (parent.depth > 0) return; // only 2 layers total: parent + 1 sub-task level
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

  function personCapacityOn(p: PersonRow, dateStr: string): number {
    const av = availability.find((a) => a.person_id === p.id && a.date === dateStr);
    if (av?.status === "off") return 0;
    if (av?.status === "half_day") return p.daily_capacity_hours / 2;
    return p.daily_capacity_hours;
  }
  function personCommittedOn(personId: string, dateStr: string): number {
    return allocations.filter((a) => a.person_id === personId && a.date === dateStr).reduce((sum, a) => sum + Number(a.hours), 0);
  }
  function remainingHoursOnDate(p: PersonRow, dateStr: string): number {
    return Math.max(0, personCapacityOn(p, dateStr) - personCommittedOn(p.id, dateStr));
  }

  function nextWorkingDayAfter(dateStr: string, holidays: HolidaySet): string {
    let d = addDays(parseLocalDate(dateStr), 1);
    while (!isWorkingDay(d, holidays)) d = addDays(d, 1);
    return toISO(d);
  }

  function personFor(t: TaskRow): PersonRow | null {
    const personId = taskPersonDrafts[t.id] ?? t.assignee_id ?? "";
    return people.find((p) => p.id === personId) ?? null;
  }

  function computeEntry(t: TaskRow, start: string, mode: Mode): ChainEntry | null {
    const hours = t.estimated_hours;
    if (hours === null || hours === undefined) return null;
    if (mode === "standard") {
      const r = standardScenario(hours, start, holidaySet);
      return { start, end: r.dueDate, durationDays: r.wholeDays, rawDays: r.rawDays };
    }
    const person = personFor(t);
    if (!person) return null;
    const r = capacityBasedScenario(hours, start, holidaySet, (d) => remainingHoursOnDate(person, d));
    return { start, end: r.dueDate, durationDays: r.wholeDays };
  }

  // Sequential chain -- used for Conservative Effort and Capacity-Based,
  // unchanged from the original design: the project's Start date anchors
  // the first top-level task, each following top-level task starts the
  // working day after the one before it ends, and a task's own sub-tasks
  // chain the same way within that task's slot (the parent's span is its
  // first sub-task's start through its last sub-task's end). A task with
  // no Estimated hours (or, for Capacity-Based, no person picked) can't be
  // scheduled -- its entry is null, and nothing after it in THAT PARENT's
  // remaining children can be placed either, since we no longer know when
  // to start them.
  function buildSequentialChain(mode: Mode): Map<string, ChainEntry | null> {
    const result = new Map<string, ChainEntry | null>();
    let cursor = projectStartDate;
    const roots = orderedTasks.filter((t) => t.depth === 0);
    for (const root of roots) {
      const children = orderedTasks.filter((t) => t.depth === 1 && t.parent_task_id === root.id);
      if (children.length > 0) {
        let childCursor: string | null = cursor;
        let firstStart: string | null = null;
        let lastEnd: string | null = null;
        for (const child of children) {
          const entry = childCursor ? computeEntry(child, childCursor, mode) : null;
          result.set(child.id, entry);
          if (entry) {
            if (!firstStart) firstStart = entry.start;
            lastEnd = entry.end;
            childCursor = nextWorkingDayAfter(entry.end, holidaySet);
          } else {
            childCursor = null; // can't confidently place anything after a gap
          }
        }
        if (firstStart && lastEnd) {
          const durationDays = workingDaysBetween(parseLocalDate(firstStart), parseLocalDate(lastEnd), holidaySet).length;
          result.set(root.id, { start: firstStart, end: lastEnd, durationDays });
          cursor = nextWorkingDayAfter(lastEnd, holidaySet);
        } else {
          result.set(root.id, null);
        }
      } else {
        const entry = computeEntry(root, cursor, mode);
        result.set(root.id, entry);
        if (entry) cursor = nextWorkingDayAfter(entry.end, holidaySet);
      }
    }
    return result;
  }

  // Packed Full Effort chain (Sandra, 2026-07-24 -- design agreed
  // 2026-07-23, see project_capaciq_wbs_planning memory). Instead of every
  // task eating a whole day of the flat 7.5h/day pool regardless of size
  // (so a 3h task would push the next task to tomorrow even though 4.5h
  // was left over), this keeps a single running "usage" ledger of hours
  // already spoken for on each calendar day, shared across the ENTIRE
  // chain (both root tasks and their sub-tasks draw from the same
  // continuous pool, walked in the same order buildSequentialChain uses).
  // A task starts on the first working day that still has spare capacity,
  // consumes from that day (and however many more it needs) until its
  // hours are used up, and the cursor is left sitting on the LAST day
  // touched -- not the day after -- so the next task's search naturally
  // tries to fill that same day's leftover capacity first.
  function buildPackedFullEffortChain(): Map<string, ChainEntry | null> {
    const result = new Map<string, ChainEntry | null>();
    const usage = new Map<string, number>(); // dateStr -> hours already used, capped at 7.5
    let cursorDate = projectStartDate;

    function isDayFull(dateStr: string): boolean {
      return (usage.get(dateStr) ?? 0) >= FULL_CAPACITY_DAILY_HOURS - 1e-9;
    }
    function firstOpenDay(fromStr: string): string {
      let d = parseLocalDate(fromStr);
      while (!isWorkingDay(d, holidaySet) || isDayFull(toISO(d))) d = addDays(d, 1);
      return toISO(d);
    }
    function consume(hours: number): ChainEntry {
      const start = firstOpenDay(cursorDate);
      let remaining = hours;
      let d = parseLocalDate(start);
      let lastDay = start;
      let guard = 0;
      while (remaining > 1e-9 && guard < 2000) {
        guard++;
        const dISO = toISO(d);
        if (isWorkingDay(d, holidaySet)) {
          const used = usage.get(dISO) ?? 0;
          const free = FULL_CAPACITY_DAILY_HOURS - used;
          if (free > 1e-9) {
            const take = Math.min(remaining, free);
            usage.set(dISO, used + take);
            remaining -= take;
            lastDay = dISO;
          }
        }
        if (remaining > 1e-9) d = addDays(d, 1);
      }
      cursorDate = lastDay; // stay put -- next task tries this same day's leftover capacity first
      const durationDays = workingDaysBetween(parseLocalDate(start), parseLocalDate(lastDay), holidaySet).length;
      const rawDays = hours > 0 ? Math.round((hours / FULL_CAPACITY_DAILY_HOURS) * 100) / 100 : 0;
      return { start, end: lastDay, durationDays, rawDays };
    }

    const roots = orderedTasks.filter((t) => t.depth === 0);
    for (const root of roots) {
      const children = orderedTasks.filter((t) => t.depth === 1 && t.parent_task_id === root.id);
      if (children.length > 0) {
        let firstStart: string | null = null;
        let lastEnd: string | null = null;
        for (const child of children) {
          const hours = child.estimated_hours;
          if (hours === null || hours === undefined) {
            result.set(child.id, null);
            continue; // skip -- shared pool/cursor untouched, next child still tries to schedule
          }
          const entry = consume(hours);
          result.set(child.id, entry);
          if (!firstStart) firstStart = entry.start;
          lastEnd = entry.end;
        }
        if (firstStart && lastEnd) {
          const durationDays = workingDaysBetween(parseLocalDate(firstStart), parseLocalDate(lastEnd), holidaySet).length;
          result.set(root.id, { start: firstStart, end: lastEnd, durationDays });
        } else {
          result.set(root.id, null);
        }
      } else {
        const hours = root.estimated_hours;
        if (hours === null || hours === undefined) {
          result.set(root.id, null);
        } else {
          result.set(root.id, consume(hours));
        }
      }
    }
    return result;
  }

  const fullChain = buildPackedFullEffortChain();
  const standardChain = buildSequentialChain("standard");
  const capacityChain = buildSequentialChain("capacity_based");
  const chainByMode: Record<Mode, Map<string, ChainEntry | null>> = {
    full_capacity: fullChain,
    standard: standardChain,
    capacity_based: capacityChain,
  };

  async function saveTaskField(taskId: string, patch: Partial<TaskRow>) {
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, ...patch } : t)));
    const { error } = await supabase.from("tasks").update(patch).eq("id", taskId);
    if (error) {
      alert(`Couldn't save: ${error.message}`);
      loadAll();
    }
  }

  // Soft completeness gate -- mirrors the Task name / Effort part of the
  // Projects table's own Lock policy (incompleteTasksFor in Projects.tsx).
  // Estimated hours (and, for Capacity-Based, a picked person) are NOT
  // included here -- those are hard blockers checked separately below,
  // since without them there's literally no schedule to compute at all.
  function softIssues(): string[] {
    const issues: string[] = [];
    const noName = orderedTasks.filter((t) => !t.name || !t.name.trim() || t.name === "Untitled task" || t.name === "Untitled sub-task");
    const noEffort = orderedTasks.filter((t) => !t.effort);
    if (noName.length) issues.push(`${noName.length} task(s) still have a placeholder name.`);
    if (noEffort.length) issues.push(`${noEffort.length} task(s) still need an Effort level.`);
    return issues;
  }

  // Total effort for the whole project -- summed from top-level tasks only
  // (a parent's own Est. hrs already mirrors the sum of its sub-tasks via
  // the rollup effect above, so summing children too would double-count).
  const totalEffortHours = Math.round(
    orderedTasks
      .filter((t) => t.depth === 0)
      .reduce((sum, t) => sum + (t.estimated_hours ?? 0), 0) * 100
  ) / 100;

  // Project-level projected completion under a given mode: the latest End
  // date among every task's entry in that mode's chain (not just the last
  // task in list order -- Capacity-Based in particular can, in principle,
  // resolve out of strict order if a person's schedule is uneven).
  function chainOverallSummary(chain: Map<string, ChainEntry | null>): { end: string | null; durationDays: number; complete: boolean } {
    let end: string | null = null;
    let complete = true;
    for (const t of orderedTasks) {
      const entry = chain.get(t.id);
      if (!entry) {
        complete = false;
        continue;
      }
      if (!end || entry.end > end) end = entry.end;
    }
    const durationDays = end ? workingDaysBetween(parseLocalDate(projectStartDate), parseLocalDate(end), holidaySet).length : 0;
    return { end, durationDays, complete };
  }

  async function saveDraft() {
    if (!project || !projectId) return;

    const chosenChain = chainByMode[activeMode];
    const unresolved = orderedTasks.filter((t) => !chosenChain.get(t.id));
    if (unresolved.length) {
      alert(
        `Can't save ${MODE_LABEL[activeMode]} yet -- ${unresolved.length} task(s) don't have a schedule under it. Add Estimated hours${
          activeMode === "capacity_based" ? ", and pick a person," : ""
        } for every task first.`
      );
      return;
    }

    const issues = softIssues();
    if (issues.length && !isFullAccess) {
      alert(`Can't save yet:\n\n${issues.join("\n")}`);
      return;
    }
    if (issues.length && isFullAccess) {
      if (!(await confirm(`${issues.join("\n")}\n\nFull Access override: save anyway?`))) return;
    }

    const verb = MODE_LABEL[activeMode];
    if (
      !(await confirm(
        `Save this project's timelines using ${verb}?\n\nThis writes every task's computed Start/Due date (still fully editable afterward) and records all three modes for reporting. Timelines stay unlocked -- lock from the Tasks page's Timelines column when you're ready to finalize.`
      ))
    )
      return;

    setSaving(true);
    try {
      const batchId = crypto.randomUUID();
      for (const t of orderedTasks) {
        const chosen = chosenChain.get(t.id);
        if (!chosen) continue;

        await supabase.from("tasks").update({ start_date: chosen.start, current_due_date: chosen.end }).eq("id", t.id);
        setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, start_date: chosen.start, current_due_date: chosen.end } : x)));

        const snapshotRows = MODES.map((m) => ({ m, entry: chainByMode[m].get(t.id) }))
          .filter((x): x is { m: Mode; entry: ChainEntry } => !!x.entry)
          .map(({ m, entry }) => ({
            task_id: t.id,
            finalize_batch_id: batchId,
            mode: m,
            applied: m === activeMode,
            target_start_date: entry.start,
            person_id: m === "capacity_based" ? personFor(t)?.id ?? null : null,
            raw_days: entry.rawDays ?? null,
            whole_days: entry.durationDays,
            computed_due_date: entry.end,
            computed_by: me?.id ?? null,
          }));
        if (snapshotRows.length) await supabase.from("task_planning_snapshots").insert(snapshotRows);
      }
      await loadAll();
      alert(`Saved using ${verb}. Timelines are still unlocked -- finalize from the Tasks page when ready.`);
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
          <td style={{ ...style, color: "var(--muted)" }}>—</td>
        </>
      );
    }
    return (
      <>
        <td style={style}>{entry.start}</td>
        <td style={style}>{entry.end}</td>
        <td style={style}>{entry.durationDays}</td>
      </>
    );
  }

  const summaries: Record<Mode, ReturnType<typeof chainOverallSummary>> = {
    full_capacity: chainOverallSummary(fullChain),
    standard: chainOverallSummary(standardChain),
    capacity_based: chainOverallSummary(capacityChain),
  };

  // Utilization snapshot -- Sandra, 2026-07-24: "when a user selects a
  // start date, show a snapshot of their utilization for the next 4 weeks
  // ... to see someone's bandwidth so we know who to assign." One global
  // panel (not per-task), daily granularity, a 4-week window anchored on
  // the project's own Start date with a forward/back toggle to page
  // further out. Reuses the same capacity/committed-hours math already
  // used for Capacity-Based scheduling above (personCapacityOn /
  // personCommittedOn), just rendered as a grid instead of consumed by a
  // scenario calculator.
  const utilWindowStart = addDays(parseLocalDate(projectStartDate), utilWindowOffset * UTIL_WINDOW_DAYS);
  const utilDays: Date[] = Array.from({ length: UTIL_WINDOW_DAYS }, (_, i) => addDays(utilWindowStart, i));
  function utilTier(freeHours: number, capacity: number): { bg: string; fg: string } {
    if (capacity <= 0) return { bg: "transparent", fg: "var(--muted)" };
    const usedPct = Math.round(((capacity - freeHours) / capacity) * 100);
    if (usedPct <= 0) return { bg: "var(--available-bg, #eef6ff)", fg: "var(--available-text, #2b6cb0)" };
    if (usedPct <= 80) return { bg: "var(--success-bg, #e6f7ee)", fg: "var(--success-text, #1e7a4c)" };
    if (usedPct <= 100) return { bg: "var(--warning-bg, #fff6e0)", fg: "var(--warning-text, #97650f)" };
    return { bg: "var(--danger-bg, #fdeaea)", fg: "var(--danger-text, #b23a3a)" };
  }

  return (
    <div>
      {dialog}
      <Link to={`/projects/${projectId}`} className="back-link" style={{ display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 8, fontSize: 12.5 }}>
        <ArrowLeft size={13} /> Back to {project.name}
      </Link>
      <h1>WBS Planning — {project.name}</h1>
      <p className="subtitle">
        Set each task's Estimated hours below (saves immediately). The project's own Start date anchors the very first task; every task after it starts
        right after the one before it finishes -- computed independently for Full Effort (packed to use leftover same-day capacity), Conservative Effort,
        and Capacity-Based. Save applies the selected mode's dates to every task without locking anything; all three modes' numbers stay on record for
        reporting either way. Lock timelines from the Tasks page when you're ready to finalize.
      </p>

      {project.timelines_locked ? (
        <div className="card" style={{ padding: 14, fontSize: 12.5, color: "var(--muted)" }}>
          Timelines for this project are already locked. Unlock from the Projects table first if you need to re-plan.
        </div>
      ) : (
        <>
          <div className="card" style={{ padding: 14, marginBottom: 12, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy)" }}>Start date: {projectStartDate}</span>
            <span style={{ fontSize: 11.5, color: "var(--muted)" }}>From the project's own Start date -- every task chains from here.</span>
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

          {/* Global utilization snapshot -- bandwidth check before assigning */}
          <div className="card" style={{ padding: 14, marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <strong style={{ fontSize: 12.5, color: "var(--navy)" }}>Utilization snapshot</strong>
              <span style={{ fontSize: 11.5, color: "var(--muted)" }}>Daily free hours per person, so you know who has bandwidth to assign.</span>
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
                            <td key={iso} style={{ textAlign: "center", fontSize: 10.5, color: "var(--muted)" }}>
                              –
                            </td>
                          );
                        }
                        const capacity = personCapacityOn(p, iso);
                        const free = remainingHoursOnDate(p, iso);
                        const tier = utilTier(free, capacity);
                        return (
                          <td key={iso} style={{ textAlign: "center", fontSize: 10.5, background: tier.bg, color: tier.fg, fontWeight: 600 }} title={`${p.name} · ${iso} · ${free}h free of ${capacity}h`}>
                            {capacity > 0 ? free : "–"}
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
                  <th colSpan={3} style={{ textAlign: "center", ...modeColStyle("full_capacity") }}>
                    Full Effort
                  </th>
                  <th colSpan={3} style={{ textAlign: "center", ...modeColStyle("standard") }}>
                    Conservative Effort
                  </th>
                  <th colSpan={4} style={{ textAlign: "center", ...modeColStyle("capacity_based") }}>
                    Capacity-Based
                  </th>
                </tr>
                <tr>
                  <th style={{ width: 100, ...modeColStyle("full_capacity") }}>Start Date</th>
                  <th style={{ width: 100, ...modeColStyle("full_capacity") }}>End Date</th>
                  <th style={{ width: 90, ...modeColStyle("full_capacity") }}>Duration (days)</th>
                  <th style={{ width: 100, ...modeColStyle("standard") }}>Start Date</th>
                  <th style={{ width: 100, ...modeColStyle("standard") }}>End Date</th>
                  <th style={{ width: 90, ...modeColStyle("standard") }}>Duration (days)</th>
                  <th style={{ width: 150, ...modeColStyle("capacity_based") }}>Person</th>
                  <th style={{ width: 100, ...modeColStyle("capacity_based") }}>Start Date</th>
                  <th style={{ width: 100, ...modeColStyle("capacity_based") }}>End Date</th>
                  <th style={{ width: 90, ...modeColStyle("capacity_based") }}>Duration (days)</th>
                </tr>
              </thead>
              <tbody>
                {orderedTasks.length === 0 && (
                  <tr>
                    <td colSpan={13} style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>
                      No tasks in this project yet.
                    </td>
                  </tr>
                )}
                {orderedTasks.map((t) => {
                  const isParent = t.depth === 0 && hasChildren(t.id);
                  const person = personFor(t);
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
                      {renderScenarioCells(t, "full_capacity")}
                      {renderScenarioCells(t, "standard")}
                      <td style={{ fontSize: 12, ...modeColStyle("capacity_based") }}>
                        <InlineSelect
                          value={person?.name ?? ""}
                          editable
                          allowEmpty
                          emptyLabel="Pick a person"
                          options={people.map((p) => p.name)}
                          onCommit={(name) => {
                            const p = people.find((pp) => pp.name === name);
                            setTaskPersonDrafts((prev) => ({ ...prev, [t.id]: p?.id ?? "" }));
                          }}
                        />
                      </td>
                      {renderScenarioCells(t, "capacity_based")}
                    </tr>
                  );
                })}
                <tr>
                  <td colSpan={13} className="add-row-cell">
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
              Writes {MODE_LABEL[activeMode]}'s dates onto every task. Nothing is locked -- finalize later from the Tasks page.
            </span>
          </div>
        </>
      )}
    </div>
  );
}
