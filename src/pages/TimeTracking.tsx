import { Fragment, useEffect, useMemo, useState } from "react";
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

interface TaskLite {
  id: string;
  name: string;
  assignee_id: string | null;
  project_id: string;
  project: { id: string; name: string; owner_id: string | null } | null;
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

function toLocalInputValue(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
  const [correctDraft, setCorrectDraft] = useState<{ hours: string; notes: string }>({ hours: "", notes: "" });

  const [showLogForm, setShowLogForm] = useState(false);
  const [logTaskId, setLogTaskId] = useState("");
  const [logStart, setLogStart] = useState(toLocalInputValue());
  const [logEnd, setLogEnd] = useState(toLocalInputValue());
  const [logNotes, setLogNotes] = useState("");
  const [logError, setLogError] = useState<string | null>(null);
  const [logSaving, setLogSaving] = useState(false);

  async function loadAll() {
    setLoading(true);
    const [{ data: entryData }, { data: peopleData }, { data: taskData }] = await Promise.all([
      supabase
        .from("time_entries")
        .select(
          `id, task_id, person_id, started_at, ended_at, duration_minutes, source, status, requested_by, reason_notes, auto_stopped,
           decided_by, decided_at, decision_notes, corrected_by, corrected_at, original_duration_minutes, correction_notes, created_at,
           task:tasks ( id, name, assignee_id, project_id, project:projects ( id, name, owner_id ) ),
           person:people!time_entries_person_id_fkey ( id, name )`
        )
        .order("started_at", { ascending: false }),
      supabase.from("people").select("id,name,reports_to").eq("is_active", true),
      supabase.from("tasks").select("id,name,assignee_id,project_id,project:projects(id,name,owner_id)").eq("is_archived", false),
    ]);
    setEntries(((entryData as unknown as EntryRow[]) ?? []));
    setPeople((peopleData as PersonLite[]) ?? []);
    setMyTasks((((taskData as unknown as TaskLite[]) ?? [])).filter((t) => t.assignee_id === me?.id));
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
    const res = await correctTimeEntry(row.id, Math.round(hours * 60), correctDraft.notes.trim() || "Corrected by Full Access");
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
    const start = new Date(logStart);
    const end = new Date(logEnd);
    if (end <= start) {
      setLogError("End time must be after start time.");
      return;
    }
    setLogSaving(true);
    const res = await submitManualTimeEntry(logTaskId, start.toISOString(), end.toISOString(), logNotes.trim() || "Manually logged");
    setLogSaving(false);
    if (res.error) {
      setLogError(res.error);
      return;
    }
    setShowLogForm(false);
    setLogTaskId("");
    setLogNotes("");
    await alert("Time entry submitted -- it goes to your project owner (or their manager, if you own the project) for approval.");
    loadAll();
  }

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
            <th>Person</th>
            <th>Project</th>
            <th>Source</th>
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
                  <td>{formatDate(row.started_at)}</td>
                  <td style={{ fontWeight: 600 }}>
                    {formatDuration(row.duration_minutes)}
                    {row.corrected_at && (
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
                    <td colSpan={7} style={{ background: "var(--bg)", padding: "10px 14px" }}>
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
                          Corrected from {formatDuration(row.original_duration_minutes)} to {formatDuration(row.duration_minutes)} by{" "}
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
                                <input
                                  type="text"
                                  placeholder="Reason for correction"
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
                                setCorrectDraft({ hours: String(Math.round(((row.duration_minutes ?? 0) / 60) * 100) / 100), notes: "" });
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
      <p className="subtitle">
        Every timer start/stop and manually logged entry lands here. Timer entries lock in once confirmed; manual entries always need approval from
        your project owner (or their manager, if you own the project) before they count toward Spent Hrs. Full Access can correct an already-locked
        entry -- the original value stays visible, never silently overwritten.
      </p>

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
            <label style={{ display: "block", marginBottom: 8 }}>
              <span style={{ display: "block", fontSize: 11, color: "var(--muted)", marginBottom: 3 }}>Task (assigned to you)</span>
              <select
                value={logTaskId}
                onChange={(e) => setLogTaskId(e.target.value)}
                style={{ width: "100%", fontSize: 12, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}
              >
                <option value="">Choose a task…</option>
                {myTasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.project?.name ? `${t.project.name} -- ` : ""}
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <label style={{ display: "block", marginBottom: 8, flex: 1 }}>
                <span style={{ display: "block", fontSize: 11, color: "var(--muted)", marginBottom: 3 }}>Start</span>
                <input
                  type="datetime-local"
                  value={logStart}
                  onChange={(e) => setLogStart(e.target.value)}
                  style={{ width: "100%", fontSize: 12, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", boxSizing: "border-box" }}
                />
              </label>
              <label style={{ display: "block", marginBottom: 8, flex: 1 }}>
                <span style={{ display: "block", fontSize: 11, color: "var(--muted)", marginBottom: 3 }}>End</span>
                <input
                  type="datetime-local"
                  value={logEnd}
                  onChange={(e) => setLogEnd(e.target.value)}
                  style={{ width: "100%", fontSize: 12, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", boxSizing: "border-box" }}
                />
              </label>
            </div>
            <label style={{ display: "block", marginBottom: 10 }}>
              <span style={{ display: "block", fontSize: 11, color: "var(--muted)", marginBottom: 3 }}>Why you're logging this after the fact</span>
              <input
                type="text"
                value={logNotes}
                onChange={(e) => setLogNotes(e.target.value)}
                placeholder="e.g. forgot to start the timer"
                style={{ width: "100%", fontSize: 12, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", boxSizing: "border-box" }}
              />
            </label>
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
                onClick={() => setShowLogForm(false)}
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
