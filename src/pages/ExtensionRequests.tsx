import { Fragment, useEffect, useMemo, useState } from "react";
import { CheckCircle2, XCircle, Clock, ShieldCheck, ChevronRight, ChevronDown, BarChart3, ListChecks } from "lucide-react";
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
    original_due_date: string;
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

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / (1000 * 60 * 60 * 24));
}

export default function ExtensionRequests() {
  const { person: me } = useSession();
  const { confirm, alert, dialog: confirmDialog } = useConfirm();
  const [tab, setTab] = useState<"requests" | "report">("requests");
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
           task:tasks!extension_requests_task_id_fkey ( id, name, original_due_date, current_due_date, project_id, project:projects ( id, name, owner_id ) ),
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
                  <tr>
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

  // ---- Report tab: behavior-data analytics over the same requests[] the
  // list above already has, no new fetch needed. All-time only for v1
  // (Sandra confirmed via AskUserQuestion 2026-07-17) -- a date-range
  // filter can be layered on later once the all-time view proves useful.
  // "Days extended" is measured from each request's task.original_due_date
  // to requested_new_due_date -- i.e. cumulative drift from the original
  // baseline at the moment of that approval, not the incremental hop from
  // whatever the due date happened to be right before it (we don't store
  // that intermediate state, and cumulative drift is the more actionable
  // number anyway).
  function ReportTab() {
    const decided = requests.filter((r) => r.status !== "Pending");
    const approved = requests.filter((r) => r.status === "Approved");
    const rejected = requests.filter((r) => r.status === "Rejected");
    const approvalRate = decided.length > 0 ? Math.round((approved.length / decided.length) * 100) : null;

    const daysExtendedList = approved
      .filter((r) => r.task?.original_due_date)
      .map((r) => daysBetween(r.task!.original_due_date, r.requested_new_due_date));
    const avgDaysExtended = daysExtendedList.length > 0 ? Math.round((daysExtendedList.reduce((a, b) => a + b, 0) / daysExtendedList.length) * 10) / 10 : null;

    const categoryCounts = useMemo(() => {
      const counts: Record<string, number> = {};
      requests.forEach((r) => {
        counts[r.reason_category] = (counts[r.reason_category] ?? 0) + 1;
      });
      return Object.entries(counts).sort((a, b) => b[1] - a[1]);
    }, [requests]);
    const topCategory = categoryCounts[0]?.[0] ?? "—";

    // Per requester: count, approval rate, avg days extended, how many
    // needed manager escalation (a proxy for "requesting extensions on
    // their own project" -- the one case that bypasses owner approval).
    const byRequester = useMemo(() => {
      const map: Record<string, { name: string; total: number; approved: number; rejected: number; pending: number; escalated: number; daysList: number[] }> = {};
      requests.forEach((r) => {
        const id = r.requester?.id ?? "unknown";
        if (!map[id]) map[id] = { name: r.requester?.name ?? "—", total: 0, approved: 0, rejected: 0, pending: 0, escalated: 0, daysList: [] };
        map[id].total += 1;
        if (r.status === "Approved") {
          map[id].approved += 1;
          if (r.task?.original_due_date) map[id].daysList.push(daysBetween(r.task.original_due_date, r.requested_new_due_date));
        }
        if (r.status === "Rejected") map[id].rejected += 1;
        if (r.status === "Pending") map[id].pending += 1;
        if (r.is_manager_initiated === false && r.task?.project?.owner_id === r.requester?.id) map[id].escalated += 1;
      });
      return Object.values(map).sort((a, b) => b.total - a.total);
    }, [requests]);

    // Per task: request count + net days drifted (current vs original due
    // date on the task itself -- exact, no reconstruction needed).
    const byTask = useMemo(() => {
      const map: Record<string, { name: string; project: string; count: number; drift: number }> = {};
      requests.forEach((r) => {
        if (!r.task) return;
        const id = r.task.id;
        if (!map[id]) {
          map[id] = {
            name: r.task.name,
            project: r.task.project?.name ?? "—",
            count: 0,
            drift: daysBetween(r.task.original_due_date, r.task.current_due_date),
          };
        }
        map[id].count += 1;
      });
      return Object.values(map).sort((a, b) => b.count - a.count);
    }, [requests]);

    // Requests per month, oldest to newest -- simple trend read.
    const byMonth = useMemo(() => {
      const map: Record<string, number> = {};
      requests.forEach((r) => {
        const month = r.created_at.slice(0, 7); // YYYY-MM
        map[month] = (map[month] ?? 0) + 1;
      });
      return Object.entries(map).sort((a, b) => a[0].localeCompare(b[0]));
    }, [requests]);
    const maxMonthCount = Math.max(1, ...byMonth.map(([, c]) => c));

    if (requests.length === 0) {
      return <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 16 }}>No extension requests yet -- the report will fill in as requests come through.</p>;
    }

    return (
      <div style={{ marginTop: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 24 }}>
          <SummaryCard label="Total requests" value={String(requests.length)} />
          <SummaryCard label="Approval rate" value={approvalRate === null ? "—" : `${approvalRate}%`} sub={`${approved.length} approved / ${rejected.length} rejected`} />
          <SummaryCard label="Avg. days extended" value={avgDaysExtended === null ? "—" : `${avgDaysExtended}d`} sub="beyond original due date, approved only" />
          <SummaryCard label="Top reason" value={topCategory} />
        </div>

        <h2 style={{ fontSize: 13, margin: "0 0 8px" }}>Who's requesting</h2>
        <table className="data-table" style={{ width: "100%", marginBottom: 24 }}>
          <thead>
            <tr>
              <th>Requester</th>
              <th>Total requests</th>
              <th>Approval rate</th>
              <th>Avg. days extended</th>
              <th>Manager-escalated</th>
            </tr>
          </thead>
          <tbody>
            {byRequester.map((r) => {
              const decidedCount = r.approved + r.rejected;
              const rate = decidedCount > 0 ? Math.round((r.approved / decidedCount) * 100) : null;
              const avg = r.daysList.length > 0 ? Math.round((r.daysList.reduce((a, b) => a + b, 0) / r.daysList.length) * 10) / 10 : null;
              return (
                <tr key={r.name}>
                  <td style={{ fontWeight: 600 }}>{r.name}</td>
                  <td>{r.total}</td>
                  <td>{rate === null ? "—" : `${rate}%`}</td>
                  <td>{avg === null ? "—" : `${avg}d`}</td>
                  <td>{r.escalated}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <h2 style={{ fontSize: 13, margin: "0 0 8px" }}>Which tasks need it most</h2>
        <table className="data-table" style={{ width: "100%", marginBottom: 24 }}>
          <thead>
            <tr>
              <th>Task</th>
              <th>Project</th>
              <th>Requests</th>
              <th>Net days drifted</th>
            </tr>
          </thead>
          <tbody>
            {byTask.slice(0, 15).map((t) => (
              <tr key={t.name + t.project}>
                <td style={{ fontWeight: 600 }}>{t.name}</td>
                <td>{t.project}</td>
                <td>{t.count}</td>
                <td>{t.drift}d</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
          <div>
            <h2 style={{ fontSize: 13, margin: "0 0 8px" }}>Why it's happening</h2>
            {categoryCounts.map(([cat, count]) => (
              <div key={cat} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span style={{ width: 140, fontSize: 11.5, flexShrink: 0 }}>{cat}</span>
                <div style={{ flex: 1, background: "var(--hover-bg)", borderRadius: 3, height: 10, overflow: "hidden" }}>
                  <div style={{ width: `${(count / requests.length) * 100}%`, background: "var(--accent)", height: "100%" }} />
                </div>
                <span style={{ fontSize: 11, color: "var(--muted)", width: 20, textAlign: "right" }}>{count}</span>
              </div>
            ))}
          </div>
          <div>
            <h2 style={{ fontSize: 13, margin: "0 0 8px" }}>Requests per month</h2>
            {byMonth.map(([month, count]) => (
              <div key={month} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span style={{ width: 60, fontSize: 11.5, flexShrink: 0 }}>{month}</span>
                <div style={{ flex: 1, background: "var(--hover-bg)", borderRadius: 3, height: 10, overflow: "hidden" }}>
                  <div style={{ width: `${(count / maxMonthCount) * 100}%`, background: "var(--accent)", height: "100%" }} />
                </div>
                <span style={{ fontSize: 11, color: "var(--muted)", width: 20, textAlign: "right" }}>{count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
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

      <div style={{ display: "flex", gap: 4, marginTop: 16, borderBottom: "1px solid var(--border)" }}>
        <button
          onClick={() => setTab("requests")}
          style={{
            display: "flex", alignItems: "center", gap: 5, padding: "8px 12px", fontSize: 12.5, fontWeight: 600, background: "none", border: "none",
            borderBottom: tab === "requests" ? "2px solid var(--accent)" : "2px solid transparent",
            color: tab === "requests" ? "var(--accent)" : "var(--muted)", cursor: "pointer",
          }}
        >
          <ListChecks size={13} />
          Requests
        </button>
        <button
          onClick={() => setTab("report")}
          style={{
            display: "flex", alignItems: "center", gap: 5, padding: "8px 12px", fontSize: 12.5, fontWeight: 600, background: "none", border: "none",
            borderBottom: tab === "report" ? "2px solid var(--accent)" : "2px solid transparent",
            color: tab === "report" ? "var(--accent)" : "var(--muted)", cursor: "pointer",
          }}
        >
          <BarChart3 size={13} />
          Report
        </button>
      </div>

      {loading ? (
        <div style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>Loading…</div>
      ) : tab === "report" ? (
        <ReportTab />
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

function SummaryCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card" style={{ padding: "12px 14px" }}>
      <div style={{ fontSize: 10.5, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: "var(--navy)" }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
