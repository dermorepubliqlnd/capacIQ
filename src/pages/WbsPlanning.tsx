import { useState, useEffect } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { ArrowLeft, Plus } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useSession } from "../lib/useSession";
import { useConfirm } from "../lib/useConfirm";
import { InlineText, InlineNumber, InlineSelect } from "../components/InlineCell";
import { addDays, buildHolidaySet, isWorkingDay, parseLocalDate, toISO, workingDaysBetween, type HolidaySet } from "../lib/workingDays";
import { fullCapacityScenario, standardScenario, capacityBasedScenario } from "../lib/taskScheduling";
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

interface ChainEntry {
  start: string;
  end: string;
  durationDays: number;
  rawDays?: number;
}

// WBS planning page (Sandra, 2026-07-23, two design rounds):
// - Per task: Estimated hours and Task name are directly editable (both
//   autosave immediately, same convention as the rest of the app).
// - Start/End dates are NOT typed per task -- they're computed by chaining:
//   the Target start date anchors the very first task in the list, and
//   every following task's Start is the moment the one before it finishes.
//   Sub-tasks chain within their own parent's block (first sub-task starts
//   when the parent's slot begins, the parent's own span is simply the
//   first sub-task's start through the last sub-task's end); the top-level
//   chain then resumes right after that whole block. This runs completely
//   independently per mode (Full Effort / Conservative Effort /
//   Capacity-Based), since each mode's task durations differ, so the same
//   task can land on different real dates in each column.
//
// "Finalize" picks ONE mode for the whole project: writes that mode's
// computed Start/Due date onto every task, snapshots all three modes'
// numbers per task into task_planning_snapshots for later reporting (never
// overwritten -- a new batch each time this is run), then locks timelines
// through the same underlying RPC/phase-cascade the Projects table's own
// Lock button and the Design-phase guardrail use (duplicated here
// deliberately rather than imported from Projects.tsx, to avoid touching
// that already-shipped, live-verified code path in the same pass).
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
  const [targetStartDate, setTargetStartDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [taskPersonDrafts, setTaskPersonDrafts] = useState<Record<string, string>>({});
  const [finalizing, setFinalizing] = useState(false);

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
    if (proj?.start_date) setTargetStartDate(proj.start_date.slice(0, 10));
    setLoading(false);
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const holidaySet = buildHolidaySet(holidays.map((h) => h.date));

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
    if (mode === "full_capacity") {
      const r = fullCapacityScenario(hours, start, holidaySet);
      return { start, end: r.dueDate, durationDays: r.wholeDays, rawDays: r.rawDays };
    }
    if (mode === "standard") {
      const r = standardScenario(hours, start, holidaySet);
      return { start, end: r.dueDate, durationDays: r.wholeDays, rawDays: r.rawDays };
    }
    const person = personFor(t);
    if (!person) return null;
    const r = capacityBasedScenario(hours, start, holidaySet, (d) => remainingHoursOnDate(person, d));
    return { start, end: r.dueDate, durationDays: r.wholeDays };
  }

  // Builds this mode's full chained schedule in one pass: the Target start
  // date anchors the first top-level task, each following top-level task
  // starts the working day after the one before it ends, and any task's
  // own sub-tasks chain the same way within that task's slot (the parent's
  // span is simply its first sub-task's start through its last sub-task's
  // end). A task with no Estimated hours yet (or, for Capacity-Based, no
  // person picked yet) can't be scheduled -- its entry is null, and the
  // chain can't confidently continue past it, so everything after also
  // comes back null until it's resolved.
  function buildChain(mode: Mode): Map<string, ChainEntry | null> {
    const result = new Map<string, ChainEntry | null>();
    let cursor = targetStartDate;
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

  const fullChain = buildChain("full_capacity");
  const standardChain = buildChain("standard");
  const capacityChain = buildChain("capacity_based");
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

  async function finalize(mode: Mode) {
    if (!project || !projectId) return;

    const chosenChain = chainByMode[mode];
    const unresolved = orderedTasks.filter((t) => !chosenChain.get(t.id));
    if (unresolved.length) {
      alert(
        `Can't finalize with ${MODE_LABEL[mode]} yet -- ${unresolved.length} task(s) don't have a schedule under it. Add Estimated hours${
          mode === "capacity_based" ? ", and pick a person," : ""
        } for every task first.`
      );
      return;
    }

    const issues = softIssues();
    if (issues.length && !isFullAccess) {
      alert(`Can't finalize yet:\n\n${issues.join("\n")}`);
      return;
    }
    if (issues.length && isFullAccess) {
      if (!(await confirm(`${issues.join("\n")}\n\nFull Access override: finalize anyway?`))) return;
    }

    const verb = MODE_LABEL[mode];
    if (
      !(await confirm(
        `Finalize this project's timelines using ${verb}?\n\nThis writes every task's computed Start/Due date, records all three modes for reporting, and locks timelines -- same as the Timelines column's own Lock action.`
      ))
    )
      return;

    setFinalizing(true);
    try {
      const batchId = crypto.randomUUID();
      for (const t of orderedTasks) {
        const chosen = chosenChain.get(t.id);
        if (!chosen) continue;

        await supabase.from("tasks").update({ start_date: chosen.start, current_due_date: chosen.end }).eq("id", t.id);
        setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, start_date: chosen.start, current_due_date: chosen.end } : x)));

        const snapshotRows = (["full_capacity", "standard", "capacity_based"] as Mode[])
          .map((m) => ({ m, entry: chainByMode[m].get(t.id) }))
          .filter((x): x is { m: Mode; entry: ChainEntry } => !!x.entry)
          .map(({ m, entry }) => ({
            task_id: t.id,
            finalize_batch_id: batchId,
            mode: m,
            applied: m === mode,
            target_start_date: entry.start,
            person_id: m === "capacity_based" ? personFor(t)?.id ?? null : null,
            raw_days: entry.rawDays ?? null,
            whole_days: entry.durationDays,
            computed_due_date: entry.end,
            computed_by: me?.id ?? null,
          }));
        if (snapshotRows.length) await supabase.from("task_planning_snapshots").insert(snapshotRows);
      }

      // Same lock policy as performTimelinesLock in Projects.tsx.
      const { error: lockError } = await supabase.rpc("set_project_timelines_locked", { p_project_id: project.id, p_locked: true });
      if (lockError) {
        alert(`Dates and snapshots saved, but locking failed: ${lockError.message}`);
      } else if (project.phase === "Scoping" && project.status !== "Paused" && project.status !== "Cancelled") {
        await supabase.from("projects").update({ phase: "Design" }).eq("id", project.id);
      }
      navigate(`/projects/${projectId}`);
    } finally {
      setFinalizing(false);
    }
  }

  if (loading) return <div style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>Loading…</div>;
  if (!project) return <div style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>Project not found.</div>;

  function renderScenarioCells(t: TaskRow, mode: Mode) {
    const entry = chainByMode[mode].get(t.id);
    if (!entry) {
      return (
        <>
          <td style={{ fontSize: 12, color: "var(--muted)" }}>—</td>
          <td style={{ fontSize: 12, color: "var(--muted)" }}>—</td>
          <td style={{ fontSize: 12, color: "var(--muted)" }}>—</td>
        </>
      );
    }
    return (
      <>
        <td style={{ fontSize: 12 }}>{entry.start}</td>
        <td style={{ fontSize: 12 }}>{entry.end}</td>
        <td style={{ fontSize: 12 }}>{entry.durationDays}</td>
      </>
    );
  }

  return (
    <div>
      {dialog}
      <Link to={`/projects/${projectId}`} className="back-link" style={{ display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 8, fontSize: 12.5 }}>
        <ArrowLeft size={13} /> Back to {project.name}
      </Link>
      <h1>WBS Planning — {project.name}</h1>
      <p className="subtitle">
        Set each task's Estimated hours below (saves immediately). The Target start date anchors the very first task; every task after it starts right
        after the one before it finishes -- computed independently for Full Effort, Conservative Effort, and Capacity-Based. Finalize applies one mode's
        dates to the whole project and locks timelines; all three modes' numbers stay on record for reporting either way.
      </p>

      {project.timelines_locked ? (
        <div className="card" style={{ padding: 14, fontSize: 12.5, color: "var(--muted)" }}>
          Timelines for this project are already locked. Unlock from the Projects table first if you need to re-plan.
        </div>
      ) : (
        <>
          <div className="card" style={{ padding: 14, marginBottom: 12, display: "flex", alignItems: "center", gap: 10 }}>
            <label style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy)" }}>Target start date</label>
            <input
              type="date"
              className="inline-cell"
              value={targetStartDate}
              onChange={(e) => setTargetStartDate(e.target.value)}
              style={{ width: 150 }}
            />
            <span style={{ fontSize: 11.5, color: "var(--muted)" }}>Start date for the first task -- every task after it chains from there.</span>
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
                  <th colSpan={3} style={{ textAlign: "center" }}>
                    Full Effort
                  </th>
                  <th colSpan={3} style={{ textAlign: "center" }}>
                    Conservative Effort
                  </th>
                  <th colSpan={4} style={{ textAlign: "center" }}>
                    Capacity-Based
                  </th>
                </tr>
                <tr>
                  <th style={{ width: 100 }}>Start Date</th>
                  <th style={{ width: 100 }}>End Date</th>
                  <th style={{ width: 90 }}>Duration (days)</th>
                  <th style={{ width: 100 }}>Start Date</th>
                  <th style={{ width: 100 }}>End Date</th>
                  <th style={{ width: 90 }}>Duration (days)</th>
                  <th style={{ width: 150 }}>Person</th>
                  <th style={{ width: 100 }}>Start Date</th>
                  <th style={{ width: 100 }}>End Date</th>
                  <th style={{ width: 90 }}>Duration (days)</th>
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
                      <td style={{ fontSize: 12 }}>
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
            <strong style={{ fontSize: 12.5, color: "var(--navy)" }}>Finalize &amp; lock using:</strong>
            {(["full_capacity", "standard", "capacity_based"] as Mode[]).map((m) => (
              <button key={m} className="btn-secondary" disabled={finalizing} onClick={() => finalize(m)}>
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
