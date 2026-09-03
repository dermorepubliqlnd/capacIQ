import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, XCircle, Clock, ShieldCheck, ChevronRight, ChevronDown, Plus, Pencil } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useSession } from "../lib/useSession";
import { useConfirm } from "../lib/useConfirm";
import { formatDate } from "../lib/formatDate";
import { formatDuration, submitManualTimeEntry, decideTimeEntry, correctTimeEntry } from "../lib/timeTracking";

interface PersonLite {
  id: string;
  name: string;
  reports_to: string | null;
}

// Time Logging Reasons (Phase 37, 2026-09-03) -- admin-configurable via
// Site Settings (was a fixed TIME_ENTRY_REASON_OPTIONS array in
// timeTracking.ts). Only manual entries need a reason -- the Start/Stop
// timer never asks for one.
interface TimeEntryReasonRow {
  id: string;
  name: string;
  is_active: boolean;
}

interface TaskLite {
  id: string;
  name: string;
  assignee_id: string | null;
  project_id: string;
  current_due_date: string | null;
  status: string | null;
  project: { id: string; name: string; owner_id: string | null; timelines_locked: boolean; wbs_status: string } | null;
}

interface EntryRow {
  id: string;
  task_id: string;
  person_id: string;
  started_at: string;
  ended_at: string | null;
  duration_minutes: number | null;
  source: "timer" | "manual" | "legacy";
  status: "running" | "pending_confirm" | "confirmed" | "pending_approval" | "approved" | "rejected";
  requested_by: string | null;
  reason_category: string | null;
  reason_notes: string | null;
  auto_stopped: boolean;
  decided_by: string | null;
  decided_at: string | null;
  decision_notes: string | null;
  corrected_by: string | null;
  corrected_at: string | null;
  original_duration_minutes: number | null;
  correction_notes: string | null;
  created_at: string;
  task: TaskLite | null;
  person: { id: string; name: string } | null;
}

const STATUS_LABEL: Record<string, string> = {
  running: "Running",
  pending_confirm: "Awaiting confirmation",
  confirmed: "Confirmed",
  pending_approval: "Pending approval",
  approved: "Approved",
  rejected: "Rejected",
};

const STATUS_TONE: Record<string, string> = {
  running: "accent",
  pending_confirm: "warning",
  confirmed: "success",
  pending_approval: "warning",
  approved: "success",
  rejected: "danger",
};

const SOURCE_LABEL: Record<string, string> = { timer: "Timer", manual: "Manual", legacy: "Legacy" };

// Small searchable combobox (Sandra, 2026-08-26: "allow project selection
// in the time tracker then next will be task... allow search too for both
// options") -- a plain <select> got unwieldy once Project became its own
// step ahead of Task. Filters options client-side as you type; click a row
// or the input's current match to select. Local to this file since Task
// Tracking is the only place a project-then-task cascade like this exists
// so far.
function SearchSelect({
  options,
  value,
  onChange,
  placeholder,
  disabled,
}: {
  options: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.id === value);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const filtered = options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <input
        disabled={disabled}
        value={open ? query : selected?.label ?? ""}
        placeholder={placeholder}
        onFocus={() => {
          setOpen(true);
          setQuery("");
        }}
        onChange={(e) => setQuery(e.target.value)}
        style={{
          width: "100%",
          fontSize: 12,
          padding: "6px 8px",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          boxSizing: "border-box",
          background: disabled ? "var(--bg)" : "var(--surface)",
        }}
      />
      {open && !disabled && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 2px)",
            left: 0,
            right: 0,
            maxHeight: 180,
            overflowY: "auto",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            boxShadow: "0 4px 16px rgba(15,41,66,0.14)",
            zIndex: 50,
          }}
        >
          {filtered.length === 0 && <div style={{ padding: "6px 8px", fontSize: 11.5, color: "var(--muted)" }}>No matches</div>}
          {filtered.map((o) => (
            <button
              key={o.id}
              onClick={() => {
                onChange(o.id);
                setOpen(false);
                setQuery("");
              }}
              style={{ display: "block", width: "100%", textAlign: "left", fontSize: 12, padding: "6px 8px", background: "none", border: "none", cursor: "pointer" }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Separate date + time fields rather than <input type="datetime-local">:
// that control's displayed time format is rendered per the OS locale,
// which on some systems shows a period instead of a colon between hours
// and minutes. Plain <input type="time"> is consistently colon-separated.
function toDateInputValue(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function toTimeInputValue(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function TimeTracking() {
  const { person: me } = useSession();
  const { confirm, alert, dialog: confirmDialog } = useConfirm();
  const [entries, setEntries] = useState<EntryRow[]>([]);
  const [people, setPeople] = useState<PersonLite[]>([]);
  const [myTasks, setMyTasks] = useState<TaskLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState<Record<string, string>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [correctingId, setCorrectingId] = useState<string | null>(null);
  const [correctDraft, setCorrectDraft] = useState<{ hours: string; notes: string; reasonCategory: string }>({ hours: "", notes: "", reasonCategory: "" });

  const [showLogForm, setShowLogForm] = useState(false);
  const [logProjectId, setLogProjectId] = useState("");
  const [logTaskId, setLogTaskId] = useState("");
  const [logStartDate, setLogStartDate] = useState(toDateInputValue());
  const [logStartTime, setLogStartTime] = useState(toTimeInputValue());
  const [logEndTime, setLogEndTime] = useState(toTimeInputValue());
  const [reasonOptions, setReasonOptions] = useState<TimeEntryReasonRow[]>([]);
  const [logReasonCategory, setLogReasonCategory] = useState("");
  const [logNotes, setLogNotes] = useState("");
  const [logError, setLogError] = useState<string | null>(null);
  const [logSaving, setLogSaving] = useState(false);

  async function loadAll() {
    setLoading(true);
    const [{ data: entryData }, { data: peopleData }, { data: taskData }, { data: reasonData }] = await Promise.all([
      supabase
        .from("time_entries")
        .select(
          `id, task_id, person_id, started_at, ended_at, duration_minutes, source, status, requested_by, reason_category, reason_notes, auto_stopped,
           decided_by, decided_at, decision_notes, corrected_by, corrected_at, original_duration_minutes, correction_notes, created_at,
           task:tasks ( id, name, assignee_id, project_id, project:projects ( id, name, owner_id ) ),
           person:people!time_entries_person_id_fkey ( id, name )`
        )
        .order("started_at", { ascending: false }),
      supabase.from("people").select("id,name,reports_to").eq("is_active", true),
      supabase.from("tasks").select("id,name,assignee_id,project_id,current_due_date,status,project:projects(id,name,owner_id,timelines_locked,wbs_status)").eq("is_archived", false),
      supabase.from("time_entry_reasons").select("id,name,is_active").order("sort_order"),
    ]);
    setEntries(((entryData as unknown as EntryRow[]) ?? []));
    setPeople((peopleData as PersonLite[]) ?? []);
    setMyTasks((((taskData as unknown as TaskLite[]) ?? [])).filter((t) => t.assignee_id === me?.id));
    const reasons = (reasonData as TimeEntryReasonRow[]) ?? [];
    setReasonOptions(reasons);
    // Default the manual-entry form to the first active reason -- only set
    // once (on first successful load, or if the field's still blank), so
    // it doesn't stomp on a choice already made mid-edit.
    setLogReasonCategory((current) => current || reasons.find((r) => r.is_active)?.name || "");
    setLoading(false);
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id]);

  // Mirrors can_decide_time_entry() in Postgres: the project owner decides
  // a manual entry unless the owner logged it themself, in which case it
  // escalates to the owner's manager. Full Access always can. See
  // [[project_capaciq_extension_requests]] for the identical rule used by
  // task-level due-date extensions.
  function canDecide(row: EntryRow): boolean {
    if (!me) return false;
    if (me.access_level === "full") return true;
    const ownerId = row.task?.project?.owner_id;
    if (!ownerId) return false;
    const requesterId = row.requested_by;
    if (ownerId === me.id && requesterId !== ownerId) return true;
    if (requesterId === ownerId) {
      const owner = people.find((p) => p.id === ownerId);
      return owner?.reports_to === me.id;
    }
    return false;
  }

  async function decide(row: EntryRow, status: "approved" | "rejected") {
    if (status === "rejected") {
      const ok = await confirm({ message: `Reject this manual time entry for "${row.task?.name}"?`, confirmLabel: "Reject", danger: true });
      if (!ok) return;
    }
    setDecidingId(row.id);
    const res = await decideTimeEntry(row.id, status, notesDraft[row.id]?.trim() || null);
    setDecidingId(null);
    if (res.error) {
      await alert(`Couldn't ${status === "approved" ? "approve" : "reject"} this entry: ${res.error}`);
      return;
    }
    loadAll();
  }

  async function submitCorrection(row: EntryRow) {
    const hours = parseFloat(correctDraft.hours);
    if (!hours || hours <= 0) {
      await alert("Enter a corrected duration greater than zero.");
      return;
    }
    const ok = await confirm({
      message: `Correct this entry to ${hours}h? The original value (${formatDuration(row.duration_minutes)}) stays on record.`,
      confirmLabel: "Correct",
    });
    if (!ok) return;
    const res = await correctTimeEntry(
      row.id,
      Math.round(hours * 60),
      correctDraft.notes.trim() || "Corrected by Full Access",
      correctDraft.reasonCategory || undefined
    );
    if (res.error) {
      await alert(`Couldn't correct this entry: ${res.error}`);
      return;
    }
    setCorrectingId(null);
    loadAll();
  }

  async function handleSubmitManual() {
    setLogError(null);
    if (!logTaskId) {
      setLogError("Choose a task.");
      return;
    }
    if (!logReasonCategory) {
      setLogError("Choose a reason.");
      return;
    }
    if (logReasonCategory === "Other" && !logNotes.trim()) {
      setLogError('Please specify a reason when "Other" is selected.');
      return;
    }
    const start = new Date(`${logStartDate}T${logStartTime}`);
    let end = new Date(`${logStartDate}T${logEndTime}`);
    // Manual entries are assumed same-day (Sandra, 2026-08-26: "the
    // assumption is that it's been worked in the same day, just date and
    // start and end time") -- there's no separate End date field anymore.
    // If the end time reads as before/equal to the start time, that means
    // the session ran past midnight; per Sandra's confirmed choice
    // ("Clamp/split at midnight"), clamp the logged entry to end of the
    // start day rather than reject the entry outright or silently wrap
    // it to the next day.
    let clampedAtMidnight = false;
    if (end <= start) {
      end = new Date(`${logStartDate}T23:59:59`);
      clampedAtMidnight = true;
    }
    setLogSaving(true);
    const res = await submitManualTimeEntry(logTaskId, start.toISOString(), end.toISOString(), logReasonCategory, logNotes.trim() || logReasonCategory);
    setLogSaving(false);
    if (res.error) {
      setLogError(res.error);
      return;
    }
    setShowLogForm(false);
    setLogProjectId("");
    setLogTaskId("");
    setLogNotes("");
    setLogReasonCategory(reasonOptions.find((r) => r.is_active)?.name || "");
    await alert(
      clampedAtMidnight
        ? "Time entry submitted -- your end time was before the start time, so it was clamped to 11:59 PM the same day. It goes to your project owner (or their manager, if you own the project) for approval."
        : "Time entry submitted -- it goes to your project owner (or their manager, if you own the project) for approval."
    );
    loadAll();
  }

  // Sandra, 2026-08-26: a Done task shouldn't accept more logged time --
  // it's already gated the other direction too (marking Done requires
  // logged hours, see [[project_capaciq_wbs_batch_2026_08_26_part2]]), so
  // once it's Done, time tracking against it is finished.
  // Phase 26 (2026-08-28): ...and neither should a task whose project has
  // already been closed -- its Final Scope snapshot is frozen, so hours
  // logged after close-out would never show up anywhere. Mirrors
  // enforce_time_entry_baseline_lock's new closed-project branch.
  const loggableTasks = myTasks.filter((t) => t.project?.timelines_locked && t.project?.wbs_status !== "closed" && t.status !== "Done");
  const loggableProjectOptions = (() => {
    const seen = new Map<string, string>();
    for (const t of loggableTasks) {
      if (t.project && !seen.has(t.project.id)) seen.set(t.project.id, t.project.name);
    }
    return Array.from(seen, ([id, label]) => ({ id, label }));
  })();
  const loggableTasksForProject = loggableTasks.filter((t) => t.project_id === logProjectId).map((t) => ({ id: t.id, label: t.name }));

  const personName = (id: string | null) => people.find((p) => p.id === id)?.name ?? "—";

  const pendingForMe = entries.filter((e) => e.status === "pending_approval" && canDecide(e));
  const mine = entries.filter((e) => e.person_id === me?.id && !pendingForMe.includes(e));
  const rest = entries.filter((e) => !pendingForMe.includes(e) && e.person_id !== me?.id);

  function EntriesTable({ rows, showDecideActions }: { rows: EntryRow[]; showDecideActions: boolean }) {
    if (rows.length === 0) return null;
    return (
      <table className="data-table" style={{ width: "100%", marginBottom: 8 }}>
        <thead>
          <tr>
            <th style={{ width: 22 }}></th>
            <th>Task</th>
            <th>Team Member</th>
            <th>Project</th>
            <th>Source</th>
            <th>Reason</th>
            <th>Start</th>
            <th>Duration</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const expanded = expandedId === row.id;
            const isFullAccess = me?.access_level === "full";
            const canCorrect = isFullAccess && (row.status === "confirmed" || row.status === "approved");
            return (
              <Fragment key={row.id}>
                <tr onClick={() => setExpandedId(expanded ? null : row.id)} style={{ cursor: "pointer" }}>
                  <td style={{ color: "var(--muted)" }}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</td>
                  <td style={{ fontWeight: 600, color: "var(--navy)" }}>{row.task?.name ?? "Untitled task"}</td>
                  <td>{row.person?.name ?? personName(row.person_id)}</td>
                  <td>{row.task?.project?.name ?? "—"}</td>
                  <td>
                    <span className="status-pill neutral" style={{ fontSize: 10 }}>
                      {SOURCE_LABEL[row.source]}
                    </span>
                  </td>
                  <td>
                    {row.reason_category ? (
                      <span className="status-pill neutral" style={{ fontSize: 10 }}>
                        {row.reason_category}
                      </span>
                    ) : (
                      <span style={{ color: "var(--muted)" }}>—</span>
                    )}
                  </td>
                  <td>{formatDate(row.started_at)}</td>
                  <td style={{ fontWeight: 600 }}>
                    {formatDuration(row.duration_minutes)}
                    {row.corrected_at && row.original_duration_minutes !== row.duration_minutes && (
                      <span title={`Originally ${formatDuration(row.original_duration_minutes)}`} style={{ marginLeft: 5, fontSize: 9.5, color: "var(--muted)" }}>
                        (corrected)
                      </span>
                    )}
                  </td>
                  <td>
                    <span className={`status-pill ${STATUS_TONE[row.status]}`}>{STATUS_LABEL[row.status]}</span>
                  </td>
                </tr>
                {expanded && (
                  <tr>
                    <td></td>
                    {/* colSpan bumped 7->8 for the new Reason column (2026-09-03) --
                        the Reason pill itself is no longer repeated here since it
                        already has its own column in the row above; only its
                        free-text notes (not shown elsewhere) still belong here. */}
                    <td colSpan={8} style={{ background: "var(--bg)", padding: "10px 14px" }}>
                      {row.reason_notes && (
                        <div style={{ fontSize: 11.5, marginBottom: 6 }}>
                          <span style={{ color: "var(--muted)" }}>Notes:</span> {row.reason_notes}
                        </div>
                      )}
                      <div style={{ fontSize: 10.5, color: "var(--muted)" }}>
                        {formatDate(row.started_at)} -- {row.ended_at ? formatDate(row.ended_at) : "in progress"}
                        {row.auto_stopped && " (auto-stopped after being idle)"}
                      </div>
                      {row.status !== "pending_approval" && row.status !== "running" && row.status !== "pending_confirm" && row.decided_by && (
                        <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 4 }}>
                          {STATUS_LABEL[row.status]} by {personName(row.decided_by)} on {formatDate(row.decided_at)}
                          {row.decision_notes && <> — "{row.decision_notes}"</>}
                        </div>
                      )}
                      {row.corrected_at && (
                        <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 4 }}>
                          {row.original_duration_minutes !== row.duration_minutes
                            ? <>Corrected from {formatDuration(row.original_duration_minutes)} to {formatDuration(row.duration_minutes)} by{" "}</>
                            : <>Reason corrected by{" "}</>}
                          {personName(row.corrected_by)} on {formatDate(row.corrected_at)}
                          {row.correction_notes && <> — "{row.correction_notes}"</>}
                        </div>
                      )}

                      {showDecideActions && (
                        <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 10 }} onClick={(e) => e.stopPropagation()}>
                          <input
                            type="text"
                            placeholder="Optional decision note"
                            value={notesDraft[row.id] ?? ""}
                            onChange={(e) => setNotesDraft((prev) => ({ ...prev, [row.id]: e.target.value }))}
                            style={{ width: "100%", fontSize: 11.5, padding: "5px 7px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", marginBottom: 8, boxSizing: "border-box" }}
                          />
                          <div style={{ display: "flex", gap: 8 }}>
                            <button
                              onClick={() => decide(row, "approved")}
                              disabled={decidingId === row.id}
                              style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 600, color: "#fff", background: "var(--success-text)", border: "none", borderRadius: "var(--radius-sm)", padding: "5px 10px", cursor: "pointer" }}
                            >
                              <CheckCircle2 size={13} />
                              Approve
                            </button>
                            <button
                              onClick={() => decide(row, "rejected")}
                              disabled={decidingId === row.id}
                              style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 600, color: "var(--danger-text)", background: "none", border: "1px solid var(--danger-text)", borderRadius: "var(--radius-sm)", padding: "5px 10px", cursor: "pointer" }}
                            >
                              <XCircle size={13} />
                              Reject
                            </button>
                          </div>
                        </div>
                      )}

                      {canCorrect && (
                        <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 10 }} onClick={(e) => e.stopPropagation()}>
                          {correctingId === row.id ? (
                            <>
                              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                                <input
                                  type="number"
                                  step="0.25"
                                  placeholder="Corrected hours"
                                  value={correctDraft.hours}
                                  onChange={(e) => setCorrectDraft((d) => ({ ...d, hours: e.target.value }))}
                                  style={{ width: 110, fontSize: 11.5, padding: "5px 7px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}
                                />
                                {/* Sandra, 2026-09-03 ("allow correction on reason... for
                                    full access only"): same reasonOptions list the manual-
                                    log form uses, defaulted to the entry's current reason
                                    when the form opens. Includes the entry's own current
                                    value even if it's since been deactivated, same pattern
                                    as the manual-log form's own reason <select>. */}
                                <select
                                  value={correctDraft.reasonCategory}
                                  onChange={(e) => setCorrectDraft((d) => ({ ...d, reasonCategory: e.target.value }))}
                                  style={{ width: 150, fontSize: 11.5, padding: "5px 7px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}
                                >
                                  <option value="">No reason</option>
                                  {reasonOptions
                                    .filter((r) => r.is_active || r.name === correctDraft.reasonCategory)
                                    .map((r) => (
                                      <option key={r.id} value={r.name}>
                                        {r.name}
                                      </option>
                                    ))}
                                </select>
                                <input
                                  type="text"
                                  placeholder="Correction notes"
                                  value={correctDraft.notes}
                                  onChange={(e) => setCorrectDraft((d) => ({ ...d, notes: e.target.value }))}
                                  style={{ flex: 1, fontSize: 11.5, padding: "5px 7px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}
                                />
                              </div>
                              <div style={{ display: "flex", gap: 8 }}>
                                <button
                                  onClick={() => submitCorrection(row)}
                                  style={{ fontSize: 11.5, fontWeight: 600, color: "#fff", background: "var(--accent)", border: "none", borderRadius: "var(--radius-sm)", padding: "5px 10px", cursor: "pointer" }}
                                >
                                  Save correction
                                </button>
                                <button
                                  onClick={() => setCorrectingId(null)}
                                  style={{ fontSize: 11.5, color: "var(--muted)", background: "none", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "5px 10px", cursor: "pointer" }}
                                >
                                  Cancel
                                </button>
                              </div>
                            </>
                          ) : (
                            <button
                              onClick={() => {
                                setCorrectingId(row.id);
                                setCorrectDraft({
                                  hours: String(Math.round(((row.duration_minutes ?? 0) / 60) * 100) / 100),
                                  notes: "",
                                  reasonCategory: row.reason_category ?? "",
                                });
                              }}
                              style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 600, color: "var(--accent)", background: "none", border: "1px solid var(--accent)", borderRadius: "var(--radius-sm)", padding: "5px 10px", cursor: "pointer" }}
                            >
                              <Pencil size={12} />
                              Correct (Full Access)
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    );
  }

  return (
    <div>
      {confirmDialog}
      <h1>Time Tracking</h1>

      <div style={{ marginTop: 14, marginBottom: 18 }}>
        {!showLogForm ? (
          <button
            onClick={() => setShowLogForm(true)}
            style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 600, color: "#fff", background: "var(--accent)", border: "none", borderRadius: "var(--radius-sm)", padding: "7px 12px", cursor: "pointer" }}
          >
            <Plus size={13} />
            Log time manually
          </button>
        ) : (
          <div className="card" style={{ padding: 14, maxWidth: 480 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 10, color: "var(--navy)" }}>Log time manually</div>
            {/* Sandra, 2026-08-26: "allow project selection in the time
                tracker then next will be task" -- Project first narrows
                down which tasks show, then Task, both searchable. */}
            <label style={{ display: "block", marginBottom: 8 }}>
              <span style={{ display: "block", fontSize: 11, color: "var(--muted)", marginBottom: 3 }}>Project</span>
              <SearchSelect
                placeholder="Choose a project…"
                value={logProjectId}
                onChange={(id) => {
                  setLogProjectId(id);
                  setLogTaskId("");
                }}
                options={loggableProjectOptions}
              />
            </label>
            <label style={{ display: "block", marginBottom: 8 }}>
              <span style={{ display: "block", fontSize: 11, color: "var(--muted)", marginBottom: 3 }}>Task (assigned to you)</span>
              <SearchSelect
                placeholder={logProjectId ? "Choose a task…" : "Choose a project first"}
                value={logTaskId}
                onChange={setLogTaskId}
                disabled={!logProjectId}
                options={loggableTasksForProject}
              />
              {loggableProjectOptions.length === 0 && (
                <span style={{ display: "block", fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                  None of your tasks are loggable right now -- either their project's baseline hasn't been locked in WBS Planning, or they're already marked Done.
                </span>
              )}
            </label>
            {/* Sandra, 2026-08-26: "add in the time tracker a view for the
                user to see logged hours for the task selected, and due
                date" -- context while filling out the form, so someone
                logging time can see at a glance how much is already on
                the task and when it's due, without leaving this page.
                Logged hours only counts Confirmed/Approved entries (same
                rule Spent Hrs uses elsewhere -- see ownHoursFor). */}
            {logTaskId &&
              (() => {
                const selectedTask = myTasks.find((t) => t.id === logTaskId);
                const loggedMinutes = entries
                  .filter((e) => e.task_id === logTaskId && (e.status === "confirmed" || e.status === "approved"))
                  .reduce((sum, e) => sum + (e.duration_minutes ?? 0), 0);
                const loggedHours = Math.round((loggedMinutes / 60) * 100) / 100;
                return (
                  <div
                    style={{
                      display: "flex",
                      gap: 16,
                      fontSize: 11.5,
                      color: "var(--navy)",
                      background: "var(--surface-2, #f5f6f8)",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius-sm)",
                      padding: "7px 10px",
                      marginBottom: 10,
                    }}
                  >
                    <span>
                      <strong>Logged so far:</strong> {loggedHours}h
                    </span>
                    <span>
                      <strong>Due:</strong> {selectedTask?.current_due_date ? formatDate(selectedTask.current_due_date) : "—"}
                    </span>
                  </div>
                );
              })()}
            {/* Sandra, 2026-08-26: "Start date" read as if it defaulted
                to today rather than the day the work actually happened --
                relabeled to "Log date" (the date being logged for) and
                collapsed Date/Start time/End time into one row so it
                reads as one work session rather than a start-day/end-day
                pair. */}
            <div style={{ display: "flex", gap: 8 }}>
              <label style={{ display: "block", marginBottom: 4, flex: 1.3 }}>
                <span style={{ display: "block", fontSize: 11, color: "var(--muted)", marginBottom: 3 }}>Log date</span>
                <input
                  type="date"
                  value={logStartDate}
                  onChange={(e) => setLogStartDate(e.target.value)}
                  style={{ width: "100%", fontSize: 12, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", boxSizing: "border-box" }}
                />
              </label>
              <label style={{ display: "block", marginBottom: 4, flex: 1 }}>
                <span style={{ display: "block", fontSize: 11, color: "var(--muted)", marginBottom: 3 }}>Start time</span>
                <input
                  type="time"
                  value={logStartTime}
                  onChange={(e) => setLogStartTime(e.target.value)}
                  style={{ width: "100%", fontSize: 12, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", boxSizing: "border-box" }}
                />
              </label>
              <label style={{ display: "block", marginBottom: 4, flex: 1 }}>
                <span style={{ display: "block", fontSize: 11, color: "var(--muted)", marginBottom: 3 }}>End time</span>
                <input
                  type="time"
                  value={logEndTime}
                  onChange={(e) => setLogEndTime(e.target.value)}
                  style={{ width: "100%", fontSize: 12, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", boxSizing: "border-box" }}
                />
              </label>
            </div>
            <div style={{ fontSize: 10.5, color: "var(--muted)", marginBottom: 8 }}>Ends past midnight? It'll be clamped to 11:59 PM the same day.</div>
            <label style={{ display: "block", marginBottom: 8 }}>
              <span style={{ display: "block", fontSize: 11, color: "var(--muted)", marginBottom: 3 }}>Reason</span>
              <select
                value={logReasonCategory}
                onChange={(e) => setLogReasonCategory(e.target.value)}
                style={{ width: "100%", fontSize: 12, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}
              >
                {reasonOptions
                  .filter((r) => r.is_active || r.name === logReasonCategory)
                  .map((r) => (
                    <option key={r.id} value={r.name}>
                      {r.name}
                    </option>
                  ))}
              </select>
            </label>
            {logReasonCategory === "Other" && (
              <label style={{ display: "block", marginBottom: 10 }}>
                <span style={{ display: "block", fontSize: 11, color: "var(--muted)", marginBottom: 3 }}>Specify</span>
                <input
                  type="text"
                  value={logNotes}
                  onChange={(e) => setLogNotes(e.target.value)}
                  placeholder="What happened?"
                  style={{ width: "100%", fontSize: 12, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", boxSizing: "border-box" }}
                />
              </label>
            )}
            {logReasonCategory !== "Other" && (
              <label style={{ display: "block", marginBottom: 10 }}>
                <span style={{ display: "block", fontSize: 11, color: "var(--muted)", marginBottom: 3 }}>Additional details (optional)</span>
                <input
                  type="text"
                  value={logNotes}
                  onChange={(e) => setLogNotes(e.target.value)}
                  style={{ width: "100%", fontSize: 12, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", boxSizing: "border-box" }}
                />
              </label>
            )}
            {logError && <div style={{ color: "var(--danger-text)", fontSize: 11.5, marginBottom: 8 }}>{logError}</div>}
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={handleSubmitManual}
                disabled={logSaving}
                style={{ fontSize: 12, fontWeight: 600, color: "#fff", background: "var(--accent)", border: "none", borderRadius: "var(--radius-sm)", padding: "7px 12px", cursor: "pointer" }}
              >
                {logSaving ? "Submitting…" : "Submit for approval"}
              </button>
              <button
                onClick={() => {
                  setShowLogForm(false);
                  setLogProjectId("");
                  setLogTaskId("");
                }}
                style={{ fontSize: 12, color: "var(--muted)", background: "none", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "7px 12px", cursor: "pointer" }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {loading ? (
        <div style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>Loading…</div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10, marginBottom: 8 }}>
            <Clock size={14} color="var(--warning-text)" />
            <h2 style={{ margin: 0, fontSize: 13 }}>Needs your decision ({pendingForMe.length})</h2>
          </div>
          {pendingForMe.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--muted)" }}>Nothing waiting on you right now.</p>
          ) : (
            <EntriesTable rows={pendingForMe} showDecideActions />
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 24, marginBottom: 8 }}>
            <ShieldCheck size={14} color="var(--accent)" />
            <h2 style={{ margin: 0, fontSize: 13 }}>My entries ({mine.length})</h2>
          </div>
          {mine.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--muted)" }}>No time logged yet.</p>
          ) : (
            <EntriesTable rows={mine} showDecideActions={false} />
          )}

          {rest.length > 0 && (
            <>
              <div style={{ marginTop: 24, marginBottom: 8 }}>
                <h2 style={{ margin: 0, fontSize: 13 }}>Other visible entries ({rest.length})</h2>
              </div>
              <EntriesTable rows={rest} showDecideActions={false} />
            </>
          )}
        </>
      )}
    </div>
  );
}
