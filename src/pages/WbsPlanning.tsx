import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useSession } from "../lib/useSession";
import { useConfirm } from "../lib/useConfirm";
import { InlineDate, InlineNumber, InlineSelect } from "../components/InlineCell";
import { buildHolidaySet, toISO } from "../lib/workingDays";
import { fullCapacityScenario, standardScenario, capacityBasedScenario, type ScenarioResult } from "../lib/taskScheduling";

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
const MODE_LABEL: Record<Mode, string> = {
  full_capacity: "Full Capacity",
  standard: "Standard",
  capacity_based: "Capacity-Based",
};

// WBS planning page (Sandra, 2026-07-23): per task, she sets its own Start
// date and Estimated hours (both persisted immediately, same autosave
// convention as everywhere else in the app), and this page computes what
// the Due date would be under three modes -- Full Capacity (7.5h/day),
// Standard (4h/day), Capacity-Based (a specific person's real remaining
// daily hours). No parallel/sequential inference from the task hierarchy
// -- two tasks sharing a Start date are simply running in parallel, one
// started after another's Due date is sequential, entirely the planner's
// own call.
//
// "Finalize" picks ONE mode for the whole project: writes that mode's Due
// date onto every task, snapshots all three modes' numbers per task into
// task_planning_snapshots for later reporting (never overwritten -- a new
// batch each time this is run), then locks timelines through the same
// underlying gate/RPC/phase-cascade the Projects table's own Lock button
// and the Design-phase guardrail use (duplicated here deliberately rather
// than importing from Projects.tsx, to avoid touching that already-shipped,
// live-verified code path in the same pass).
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

  const holidaySet = useMemo(() => buildHolidaySet(holidays.map((h) => h.date)), [holidays]);

  // Sort parent tasks first, each followed immediately by its own
  // sub-tasks -- same 2-level nesting the Projects table uses elsewhere.
  const orderedTasks = useMemo(() => {
    const roots = tasks.filter((t) => !t.parent_task_id);
    const out: (TaskRow & { depth: number })[] = [];
    for (const r of roots) {
      out.push({ ...r, depth: 0 });
      for (const c of tasks.filter((t) => t.parent_task_id === r.id)) out.push({ ...c, depth: 1 });
    }
    return out;
  }, [tasks]);

  function startFor(t: TaskRow): string {
    return (t.start_date ?? targetStartDate).slice(0, 10);
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

  function scenariosFor(t: TaskRow): { full: ScenarioResult; standard: ScenarioResult; capacity: ScenarioResult | null; person: PersonRow | null } {
    const hours = t.estimated_hours ?? 0;
    const start = startFor(t);
    const full = fullCapacityScenario(hours, start, holidaySet);
    const standard = standardScenario(hours, start, holidaySet);
    const personId = taskPersonDrafts[t.id] ?? t.assignee_id ?? "";
    const person = people.find((p) => p.id === personId) ?? null;
    const capacity = person ? capacityBasedScenario(hours, start, holidaySet, (d) => remainingHoursOnDate(person, d)) : null;
    return { full, standard, capacity, person };
  }

  async function saveTaskField(taskId: string, patch: Partial<TaskRow>) {
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, ...patch } : t)));
    const { error } = await supabase.from("tasks").update(patch).eq("id", taskId);
    if (error) {
      alert(`Couldn't save: ${error.message}`);
      loadAll();
    }
  }

  // Same completeness gate the Projects table's Lock button and Design-
  // phase guardrail use (see performTimelinesLock in Projects.tsx) --
  // duplicated rather than imported to avoid touching that already-live
  // code path. A task with no Estimated hours can't be scheduled at all,
  // so it's called out separately from the rest of the missing-field list.
  function readinessIssues(): string[] {
    const issues: string[] = [];
    const noHours = orderedTasks.filter((t) => t.estimated_hours === null || t.estimated_hours === undefined);
    if (noHours.length) issues.push(`${noHours.length} task(s) still need Estimated hours before they can be scheduled.`);
    return issues;
  }

  async function finalize(mode: Mode) {
    if (!project || !projectId) return;
    if (mode === "capacity_based") {
      const missingPerson = orderedTasks.filter((t) => !(taskPersonDrafts[t.id] ?? t.assignee_id));
      if (missingPerson.length) {
        alert(`Pick a person for every task first -- ${missingPerson.length} task(s) don't have one yet.`);
        return;
      }
    }
    const issues = readinessIssues();
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
        `Finalize this project's timelines using ${verb}?\n\nThis writes every task's computed Start/Due date, records all three scenarios for reporting, and locks timelines -- same as the Timelines column's own Lock action.`
      ))
    )
      return;

    setFinalizing(true);
    try {
      const batchId = crypto.randomUUID();
      for (const t of orderedTasks) {
        const { full, standard, capacity, person } = scenariosFor(t);
        const start = startFor(t);
        const chosen = mode === "full_capacity" ? full : mode === "standard" ? standard : capacity;
        if (!chosen) continue;

        await supabase.from("tasks").update({ start_date: start, current_due_date: chosen.dueDate }).eq("id", t.id);
        setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, start_date: start, current_due_date: chosen.dueDate } : x)));

        const rows = [
          { scenarioMode: "full_capacity" as Mode, r: full, personId: null as string | null },
          { scenarioMode: "standard" as Mode, r: standard, personId: null as string | null },
          ...(capacity ? [{ scenarioMode: "capacity_based" as Mode, r: capacity, personId: person?.id ?? null }] : []),
        ];
        await supabase.from("task_planning_snapshots").insert(
          rows.map(({ scenarioMode, r, personId }) => ({
            task_id: t.id,
            finalize_batch_id: batchId,
            mode: scenarioMode,
            applied: scenarioMode === mode,
            target_start_date: start,
            person_id: personId,
            raw_days: r.rawDays,
            whole_days: r.wholeDays,
            computed_due_date: r.dueDate,
            computed_by: me?.id ?? null,
          }))
        );
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

  return (
    <div>
      {dialog}
      <Link to={`/projects/${projectId}`} className="back-link" style={{ display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 8, fontSize: 12.5 }}>
        <ArrowLeft size={13} /> Back to {project.name}
      </Link>
      <h1>WBS Planning — {project.name}</h1>
      <p className="subtitle">
        Set each task's own Start date and Estimated hours below (both save immediately). See what the Due date would be under Full Capacity, Standard, and
        Capacity-Based, then Finalize to apply one mode's dates to the whole project and lock timelines. All three modes' numbers stay on record for
        reporting either way.
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
            <span style={{ fontSize: 11.5, color: "var(--muted)" }}>Default Start date for any task that doesn't have its own yet.</span>
          </div>

          <div className="card" style={{ padding: 0, overflowX: "auto" }}>
            <table className="data-table" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th style={{ minWidth: 200 }}>Task</th>
                  <th style={{ width: 120 }}>Start date</th>
                  <th style={{ width: 90 }}>Est. hrs</th>
                  <th style={{ width: 140 }}>Full Capacity</th>
                  <th style={{ width: 140 }}>Standard</th>
                  <th style={{ width: 190 }}>Capacity-Based</th>
                </tr>
              </thead>
              <tbody>
                {orderedTasks.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>
                      No tasks in this project yet.
                    </td>
                  </tr>
                )}
                {orderedTasks.map((t) => {
                  const { full, standard, capacity, person } = scenariosFor(t);
                  return (
                    <tr key={t.id}>
                      <td>
                        <div style={{ paddingLeft: t.depth * 16, fontWeight: t.depth === 0 ? 600 : 400 }}>{t.name || "Untitled task"}</div>
                      </td>
                      <td>
                        <InlineDate value={startFor(t)} editable onCommit={(v) => v && saveTaskField(t.id, { start_date: v })} />
                      </td>
                      <td>
                        <InlineNumber value={t.estimated_hours} editable onCommit={(v) => saveTaskField(t.id, { estimated_hours: v })} />
                      </td>
                      <td style={{ fontSize: 12 }}>
                        {t.estimated_hours ? (
                          <>
                            {full.rawDays}d <span style={{ color: "var(--muted)" }}>→ {full.dueDate}</span>
                          </>
                        ) : (
                          <span style={{ color: "var(--muted)" }}>—</span>
                        )}
                      </td>
                      <td style={{ fontSize: 12 }}>
                        {t.estimated_hours ? (
                          <>
                            {standard.rawDays}d <span style={{ color: "var(--muted)" }}>→ {standard.dueDate}</span>
                          </>
                        ) : (
                          <span style={{ color: "var(--muted)" }}>—</span>
                        )}
                      </td>
                      <td style={{ fontSize: 12 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
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
                          {capacity && t.estimated_hours ? (
                            <span>
                              {capacity.wholeDays}d <span style={{ color: "var(--muted)" }}>→ {capacity.dueDate}</span>
                            </span>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
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
