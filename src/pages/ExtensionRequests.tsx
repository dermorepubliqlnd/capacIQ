import { Fragment, useEffect, useState } from "react";
import { CheckCircle2, XCircle, Clock, ShieldCheck, ChevronRight, ChevronDown } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useSession } from "../lib/useSession";
import { useConfirm } from "../lib/useConfirm";
import { REASON_CATEGORY_OPTIONS } from "../components/RequestExtensionModal";

interface PersonLite {
  id: string;
  name: string;
  reports_to: string | null;
}

interface ExtensionRequestRow {
  id: string;
  requested_new_due_date: string;
  reason_category: string;
  reason_notes: string;
  status: "Pending" | "Approved" | "Rejected";
  decided_at: string | null;
  decision_notes: string | null;
  is_manager_initiated: boolean;
  created_at: string;
  task: {
    id: string;
    name: string;
    current_due_date: string;
    project_id: string;
    project: { id: string; name: string; owner_id: string | null } | null;
  } | null;
  requester: { id: string; name: string } | null;
  decider: { id: string; name: string } | null;
}

const STATUS_TONE: Record<string, string> = {
  Pending: "warning",
  Approved: "success",
  Rejected: "danger",
};

export default function ExtensionRequests() {
  const { person: me } = useSession();
  const { confirm, alert, dialog: confirmDialog } = useConfirm();
  const [requests, setRequests] = useState<ExtensionRequestRow[]>([]);
  const [people, setPeople] = useState<PersonLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState<Record<string, string>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);

  async function loadAll() {
    setLoading(true);
    const [{ data: reqData }, { data: peopleData }] = await Promise.all([
      supabase
        .from("extension_requests")
        .select(
          `id, requested_new_due_date, reason_category, reason_notes, status, decided_at, decision_notes, is_manager_initiated, created_at,
           task:tasks!extension_requests_task_id_fkey ( id, name, current_due_date, project_id, project:projects ( id, name, owner_id ) ),
           requester:people!extension_requests_requested_by_fkey ( id, name ),
           decider:people!extension_requests_decided_by_fkey ( id, name )`
        )
        .order("created_at", { ascending: false }),
      supabase.from("people").select("id,name,reports_to").eq("is_active", true),
    ]);
    setRequests(((reqData as unknown as ExtensionRequestRow[]) ?? []));
    setPeople((peopleData as PersonLite[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    loadAll();
  }, []);

  // Mirrors can_decide_extension() in Postgres -- the DB is the real
  // authority (this only controls whether the Approve/Reject buttons show
  // up; the RPC re-checks and would reject an unauthorized call anyway).
  function canDecide(row: ExtensionRequestRow): boolean {
    if (!me) return false;
    if (me.access_level === "full") return true;
    const ownerId = row.task?.project?.owner_id;
    if (!ownerId) return false;
    const requesterId = row.requester?.id;
    if (ownerId === me.id && requesterId !== ownerId) return true;
    if (requesterId === ownerId) {
      const owner = people.find((p) => p.id === ownerId);
      return owner?.reports_to === me.id;
    }
    return false;
  }

  async function decide(row: ExtensionRequestRow, status: "Approved" | "Rejected") {
    if (status === "Rejected") {
      const ok = await confirm({ message: `Reject the extension request for "${row.task?.name}"?`, confirmLabel: "Reject", danger: true });
      if (!ok) return;
    }
    setDecidingId(row.id);
    const { error } = await supabase.rpc("decide_extension_request", {
      p_request_id: row.id,
      p_status: status,
      p_decision_notes: notesDraft[row.id]?.trim() || null,
    });
    setDecidingId(null);
    if (error) {
      await alert(`Couldn't ${status === "Approved" ? "approve" : "reject"} this request: ${error.message}`);
      return;
    }
    loadAll();
  }

  const pendingForMe = requests.filter((r) => r.status === "Pending" && canDecide(r));
  const mine = requests.filter((r) => r.requester?.id === me?.id);
  const rest = requests.filter((r) => !pendingForMe.includes(r) && r.requester?.id !== me?.id);

  // Table format, click a row to expand full reason/decision detail --
  // replaces the earlier stacked-card layout per Sandra's request
  // (2026-07-17). Each section (Needs your decision / My requests / Other
  // visible) is its own compact table so the grouping from the card
  // version is preserved.
  function RequestsTable({ rows, showDecideActions }: { rows: ExtensionRequestRow[]; showDecideActions: boolean }) {
    if (rows.length === 0) return null;
    return (
      <table className="data-table" style={{ width: "100%", marginBottom: 8 }}>
        <thead>
          <tr>
            <th style={{ width: 22 }}></th>
            <th>Task</th>
            <th>Project</th>
            <th>Requested by</th>
            <th>Current due</th>
            <th>Requested</th>
            <th>Reason</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const expanded = expandedId === row.id;
            return (
              <Fragment key={row.id}>
                <tr
                  key={row.id}
                  onClick={() => setExpandedId(expanded ? null : row.id)}
                  style={{ cursor: "pointer" }}
                >
                  <td style={{ color: "var(--muted)" }}>{expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</td>
                  <td style={{ fontWeight: 600, color: "var(--navy)" }}>
                    {row.task?.name ?? "Untitled task"}
                    {row.is_manager_initiated && (
                      <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 600, color: "var(--muted)" }}>(manager-initiated)</span>
                    )}
                  </td>
                  <td>{row.task?.project?.name ?? "—"}</td>
                  <td>{row.requester?.name ?? "—"}</td>
                  <td>{row.task?.current_due_date ?? "—"}</td>
                  <td style={{ fontWeight: 600 }}>{row.requested_new_due_date}</td>
                  <td>
                    <span className="status-pill neutral" style={{ fontSize: 10 }}>
                      {row.reason_category}
                    </span>
                  </td>
                  <td>
                    <span className={`status-pill ${STATUS_TONE[row.status]}`}>{row.status}</span>
                  </td>
                </tr>
                {expanded && (
                  <tr key={`${row.id}-detail`}>
                    <td></td>
                    <td colSpan={7} style={{ background: "var(--bg)", padding: "10px 14px" }}>
                      <div style={{ fontSize: 11.5, marginBottom: 6 }}>
                        <span style={{ color: "var(--muted)" }}>Reason notes:</span> {row.reason_notes}
                      </div>
                      <div style={{ fontSize: 10.5, color: "var(--muted)" }}>
                        Requested on {row.created_at.slice(0, 10)}
                      </div>
                      {row.status !== "Pending" && (
                        <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 4 }}>
                          {row.status} by {row.decider?.name ?? "—"} on {row.decided_at?.slice(0, 10)}
                          {row.decision_notes && <> — "{row.decision_notes}"</>}
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
                              onClick={() => decide(row, "Approved")}
                              disabled={decidingId === row.id}
                              style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 600, color: "#fff", background: "var(--success-text)", border: "none", borderRadius: "var(--radius-sm)", padding: "5px 10px", cursor: "pointer" }}
                            >
                              <CheckCircle2 size={13} />
                              Approve
                            </button>
                            <button
                              onClick={() => decide(row, "Rejected")}
                              disabled={decidingId === row.id}
                              style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 600, color: "var(--danger-text)", background: "none", border: "1px solid var(--danger-text)", borderRadius: "var(--radius-sm)", padding: "5px 10px", cursor: "pointer" }}
                            >
                              <XCircle size={13} />
                              Reject
                            </button>
                          </div>
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
      <h1>Extension Requests</h1>
      <p className="subtitle">
        Every due-date change goes through here -- current_due_date is locked at the database level (once a project's timelines are locked) and can
        only move once a request below is approved. See {REASON_CATEGORY_OPTIONS.length} reason categories available when requesting from a task's
        Due date cell. Click any row to see full details.
      </p>

      {loading ? (
        <div style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>Loading…</div>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 20, marginBottom: 8 }}>
            <Clock size={14} color="var(--warning-text)" />
            <h2 style={{ margin: 0, fontSize: 13 }}>Needs your decision ({pendingForMe.length})</h2>
          </div>
          {pendingForMe.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--muted)" }}>Nothing waiting on you right now.</p>
          ) : (
            <RequestsTable rows={pendingForMe} showDecideActions />
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 24, marginBottom: 8 }}>
            <ShieldCheck size={14} color="var(--accent)" />
            <h2 style={{ margin: 0, fontSize: 13 }}>My requests ({mine.length})</h2>
          </div>
          {mine.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--muted)" }}>You haven't requested any extensions.</p>
          ) : (
            <RequestsTable rows={mine} showDecideActions={false} />
          )}

          {rest.length > 0 && (
            <>
              <div style={{ marginTop: 24, marginBottom: 8 }}>
                <h2 style={{ margin: 0, fontSize: 13 }}>Other visible requests ({rest.length})</h2>
              </div>
              <RequestsTable rows={rest} showDecideActions={false} />
            </>
          )}
        </>
      )}
    </div>
  );
}
