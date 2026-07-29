import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { formatDate } from "../lib/formatDate";

// Round 3 of the WBS UI redesign (Sandra, 2026-07-29): the "View Full
// Audit Trail" link on the WBS Planning page (top and bottom bars) routes
// here. Per Sandra's explicit choice after seeing a side-by-side mockup
// of both options, this is a genuinely new, dedicated page -- not a
// deep-link back to the Revision History panel.
//
// Deliberately just a flat historical log: every row in
// project_revision_changes across EVERY revision this project has ever
// had (not just the latest one, unlike the WBS page's own Changes/Notes
// columns and Revision Summary panel, which only look at the latest
// applied revision). This reuses data Phase 2's apply_wbs_revision()
// already writes per revision -- no new diff-computation logic, and it
// does NOT reopen the "full per-field diff depth" item that was
// deliberately deferred in [[project_capaciq_wbs_ui_redesign_plan]]
// (decision #2): that deferral was about NEW baseline-vs-current
// per-field scoring, not about surfacing already-recorded revision
// changes in one place.

const CHANGE_TYPE_LABEL: Record<string, string> = {
  task_added: "Task added",
  task_removed: "Task removed",
  hours_changed: "Estimate changed",
  date_changed: "Date changed",
  dependency_changed: "Dependency changed",
  assignee_changed: "Assignee changed",
};

interface ProjectRow {
  id: string;
  name: string;
}
interface RevisionRow {
  id: string;
  revision_number: number;
  reason: string;
  status: "in_progress" | "applied" | "discarded";
  started_at: string;
  applied_at: string | null;
}
interface ChangeRow {
  id: string;
  revision_id: string;
  task_id: string;
  task_name: string;
  change_type: string;
  field: string | null;
  previous_value: unknown;
  new_value: unknown;
  changed_at: string;
  changed_by: string | null;
}

interface PersonRow {
  id: string;
  name: string;
}

// Sandra, 2026-07-29 follow-up: date_changed rows store an object shape
// ({start_full, end_full, start_standard, end_standard}) rather than a
// single scalar -- was rendering as raw JSON ("{"end_full":"2026-08-06"...").
// Pretty-print that shape specifically; fall back to raw JSON for any
// other unrecognized object shape rather than guessing further.
function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const hasDateShape = "start_full" in o || "end_full" in o || "start_standard" in o || "end_standard" in o;
    if (hasDateShape) {
      const parts: string[] = [];
      if (o.start_full || o.start_standard) {
        parts.push(`Start: ${formatDate(String(o.start_full ?? o.start_standard).slice(0, 10))}`);
      }
      if (o.end_full || o.end_standard) {
        parts.push(`End: ${formatDate(String(o.end_full ?? o.end_standard).slice(0, 10))}`);
      }
      return parts.length ? parts.join(" · ") : "—";
    }
    return JSON.stringify(v);
  }
  return String(v);
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  const datePart = formatDate(iso.slice(0, 10));
  const timePart = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${datePart} ${timePart}`;
}

export default function AuditTrail() {
  const { projectId } = useParams<{ projectId: string }>();
  const [project, setProject] = useState<ProjectRow | null>(null);
  const [revisions, setRevisions] = useState<RevisionRow[]>([]);
  const [changes, setChanges] = useState<ChangeRow[]>([]);
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [revisionFilter, setRevisionFilter] = useState<string>("all");

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    (async () => {
      setLoading(true);
      const [{ data: projectRow }, { data: revisionRows }, { data: peopleRows }] = await Promise.all([
        supabase.from("projects").select("id,name").eq("id", projectId).single(),
        supabase
          .from("project_revisions")
          .select("id,revision_number,reason,status,started_at,applied_at")
          .eq("project_id", projectId)
          .order("revision_number", { ascending: false }),
        supabase.from("people").select("id,name"),
      ]);
      if (!active) return;
      setProject((projectRow as ProjectRow) ?? null);
      setPeople((peopleRows as PersonRow[]) ?? []);
      const revs = (revisionRows as RevisionRow[]) ?? [];
      setRevisions(revs);
      if (revs.length > 0) {
        const { data: changeRows } = await supabase
          .from("project_revision_changes")
          .select("id,revision_id,task_id,task_name,change_type,field,previous_value,new_value,changed_at,changed_by")
          .in(
            "revision_id",
            revs.map((r) => r.id)
          )
          .order("changed_at", { ascending: false });
        if (active) setChanges((changeRows as ChangeRow[]) ?? []);
      } else {
        setChanges([]);
      }
      if (active) setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [projectId]);

  const revisionById = new Map(revisions.map((r) => [r.id, r]));
  const personById = new Map(people.map((p) => [p.id, p.name]));
  const visibleChanges = revisionFilter === "all" ? changes : changes.filter((c) => c.revision_id === revisionFilter);

  if (loading) return <div style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>Loading…</div>;
  if (!project) return <div style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>Project not found.</div>;

  return (
    <div>
      <Link
        to={`/projects/${project.id}/wbs`}
        className="back-link"
        style={{ display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 8, fontSize: 12.5 }}
      >
        <ArrowLeft size={13} /> Back to WBS Planning
      </Link>
      <h1>Audit Trail — {project.name}</h1>

      <div className="card" style={{ padding: 14, marginBottom: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy)" }}>Revision:</span>
        <select
          className="inline-cell"
          value={revisionFilter}
          onChange={(e) => setRevisionFilter(e.target.value)}
          style={{ border: "1px solid var(--border)", background: "var(--surface)", minWidth: 220 }}
        >
          <option value="all">All revisions ({changes.length} change{changes.length === 1 ? "" : "s"})</option>
          {revisions.map((r) => (
            <option key={r.id} value={r.id}>
              Revision {r.revision_number} — {r.status} ({formatDate(r.started_at.slice(0, 10))})
            </option>
          ))}
        </select>
        <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
          Every recorded change across every revision this project has had -- a full historical log, not just the latest revision.
        </span>
      </div>

      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table className="data-table" style={{ width: "100%" }}>
          <thead>
            <tr>
              <th style={{ width: 90 }}>Revision</th>
              <th style={{ minWidth: 180 }}>Task</th>
              <th style={{ width: 150 }}>Change</th>
              <th style={{ width: 170 }}>Previous</th>
              <th style={{ width: 170 }}>New</th>
              <th style={{ width: 130 }}>By</th>
              <th style={{ width: 160 }}>When</th>
            </tr>
          </thead>
          <tbody>
            {visibleChanges.length === 0 && (
              <tr>
                <td colSpan={7} style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>
                  No changes recorded yet.
                </td>
              </tr>
            )}
            {visibleChanges.map((c) => {
              const rev = revisionById.get(c.revision_id);
              return (
                <tr key={c.id}>
                  <td>{rev ? `V${rev.revision_number}` : "—"}</td>
                  <td style={{ fontWeight: 500 }}>{c.task_name}</td>
                  <td>{CHANGE_TYPE_LABEL[c.change_type] ?? c.change_type}</td>
                  <td style={{ color: "var(--muted)" }}>{formatValue(c.previous_value)}</td>
                  <td>{formatValue(c.new_value)}</td>
                  <td style={{ color: "var(--muted)", fontSize: 11.5 }}>{c.changed_by ? personById.get(c.changed_by) ?? "—" : "—"}</td>
                  <td style={{ color: "var(--muted)", fontSize: 11.5 }}>{formatWhen(c.changed_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
