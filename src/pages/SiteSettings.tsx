import { useEffect, useState, type CSSProperties } from "react";
import { ShieldCheck, ShieldOff, Pencil, Check, X, Plus, ArrowUp, ArrowDown, Trash2, CalendarClock, CalendarDays } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useSession } from "../lib/useSession";

function AccessDenied() {
  return (
    <div>
      <h1>Site settings</h1>
      <p className="subtitle">Admin only.</p>
      <div className="card">
        <p style={{ margin: 0, fontSize: 12.5 }}>
          Your account doesn&apos;t have Full Access, so this page isn&apos;t available. Ask a director or manager
          with Full Access to make changes here.
        </p>
      </div>
    </div>
  );
}

// Work Type -- admin-configurable lookup (Phase 12, 2026-08-20; moved out
// of Admin.tsx into its own Site Settings page in a later round). See
// supabase/phase12_migration.sql for the table itself (work_types) and
// supabase/phase12_migration_2.sql for the delete RLS policy added
// alongside the Delete button below.
interface WorkTypeRow {
  id: string;
  name: string;
  sort_order: number;
  is_active: boolean;
  is_fixed_schedule: boolean;
}

export default function SiteSettings() {
  const { person: me, loading: sessionLoading } = useSession();

  // Work Types (Phase 12, 2026-08-20): admin-configurable lookup backing
  // the new task-level "Work Type" field on Projects/WBS Planning, so
  // Sandra can add/rename/reorder/deactivate categories herself with no
  // code change. Reorder is done with simple up/down buttons rather than
  // the grip-handle drag used for table columns elsewhere -- this list is
  // short (starts at 8 rows) and swapping sort_order with a neighbor via
  // two buttons is simpler/less fragile to build correctly here than
  // replicating the full drag machinery for a brand-new list; worth
  // revisiting if this list grows much longer.
  const [workTypes, setWorkTypes] = useState<WorkTypeRow[]>([]);
  const [workTypesLoading, setWorkTypesLoading] = useState(true);
  const [newWorkTypeName, setNewWorkTypeName] = useState("");
  const [workTypeBusy, setWorkTypeBusy] = useState(false);
  const [editingWorkTypeId, setEditingWorkTypeId] = useState<string | null>(null);
  const [editWorkTypeName, setEditWorkTypeName] = useState("");

  // Global historical-locking switch (Sandra, 2026-08-14): "we're still
  // playing around with the system" -- while off, Utilization/Day Planner
  // ignore ownership/assignee history and just use each project/task's
  // current owner_id/assignee_id, same as before that feature existed.
  // Moved here from Admin.tsx (2026-08-20 User Management redesign) --
  // this is a site-wide setting, not a per-user one, so it belongs on
  // this page instead of cluttering User Management.
  const [historicalLockingEnabled, setHistoricalLockingEnabled] = useState(false);
  const [historicalLockingSaving, setHistoricalLockingSaving] = useState(false);

  async function loadHistoricalLocking() {
    const { data } = await supabase.from("app_settings").select("historical_locking_enabled").eq("id", true).single();
    setHistoricalLockingEnabled((data as { historical_locking_enabled?: boolean } | null)?.historical_locking_enabled ?? false);
  }

  async function toggleHistoricalLocking() {
    const next = !historicalLockingEnabled;
    setHistoricalLockingSaving(true);
    const { error } = await supabase.from("app_settings").update({ historical_locking_enabled: next }).eq("id", true);
    setHistoricalLockingSaving(false);
    if (error) {
      window.alert(`Couldn't save: ${error.message}`);
      return;
    }
    setHistoricalLockingEnabled(next);
  }

  async function loadWorkTypes() {
    setWorkTypesLoading(true);
    const { data } = await supabase.from("work_types").select("id,name,sort_order,is_active,is_fixed_schedule").order("sort_order");
    setWorkTypes((data as WorkTypeRow[]) ?? []);
    setWorkTypesLoading(false);
  }

  async function addWorkType() {
    const name = newWorkTypeName.trim();
    if (!name) return;
    setWorkTypeBusy(true);
    const nextSortOrder = workTypes.length > 0 ? Math.max(...workTypes.map((w) => w.sort_order)) + 1 : 1;
    const { error } = await supabase.from("work_types").insert({ name, sort_order: nextSortOrder });
    setWorkTypeBusy(false);
    if (error) {
      window.alert(`Couldn't add: ${error.message}`);
      return;
    }
    setNewWorkTypeName("");
    loadWorkTypes();
  }

  function startEditWorkType(w: WorkTypeRow) {
    setEditingWorkTypeId(w.id);
    setEditWorkTypeName(w.name);
  }

  async function saveWorkTypeRename(id: string) {
    const name = editWorkTypeName.trim();
    if (!name) return;
    setWorkTypeBusy(true);
    const { error } = await supabase.from("work_types").update({ name }).eq("id", id);
    setWorkTypeBusy(false);
    if (error) {
      window.alert(`Couldn't rename: ${error.message}`);
      return;
    }
    setEditingWorkTypeId(null);
    loadWorkTypes();
  }

  async function toggleWorkTypeActive(w: WorkTypeRow) {
    setWorkTypeBusy(true);
    const { error } = await supabase.from("work_types").update({ is_active: !w.is_active }).eq("id", w.id);
    setWorkTypeBusy(false);
    if (error) {
      window.alert(`Couldn't update: ${error.message}`);
      return;
    }
    loadWorkTypes();
  }

  // Phase 3 (2026-08-21, quality-audit follow-on): Fixed-Schedule work
  // types (Training Delivery is the concrete case) don't defer their
  // hours to the next day when the assignee is already busy -- they land
  // on their own scheduled day(s) exactly like Full Effort assumes, so
  // Utilization/Day Planner can honestly show over 100% instead of
  // quietly smoothing the overflow into tomorrow. See
  // capacityScheduler.ts's fixedQueue pass for the scheduling-side half
  // of this.
  async function toggleWorkTypeFixedSchedule(w: WorkTypeRow) {
    setWorkTypeBusy(true);
    const { error } = await supabase.from("work_types").update({ is_fixed_schedule: !w.is_fixed_schedule }).eq("id", w.id);
    setWorkTypeBusy(false);
    if (error) {
      window.alert(`Couldn't update: ${error.message}`);
      return;
    }
    loadWorkTypes();
  }

  // Swaps this row's sort_order with its immediate neighbor (up or down)
  // in the currently-loaded, already sort_order-ordered list.
  async function moveWorkType(w: WorkTypeRow, direction: "up" | "down") {
    const idx = workTypes.findIndex((x) => x.id === w.id);
    const neighborIdx = direction === "up" ? idx - 1 : idx + 1;
    if (idx === -1 || neighborIdx < 0 || neighborIdx >= workTypes.length) return;
    const neighbor = workTypes[neighborIdx];
    setWorkTypeBusy(true);
    const [{ error: e1 }, { error: e2 }] = await Promise.all([
      supabase.from("work_types").update({ sort_order: neighbor.sort_order }).eq("id", w.id),
      supabase.from("work_types").update({ sort_order: w.sort_order }).eq("id", neighbor.id),
    ]);
    setWorkTypeBusy(false);
    if (e1 || e2) {
      window.alert(`Couldn't reorder: ${(e1 ?? e2)?.message}`);
      return;
    }
    loadWorkTypes();
  }

  // Delete (2026-08-20 round): only allowed when no task currently
  // references this Work Type. We check client-side first (cheap, gives
  // a friendly message with the actual count) -- the DB itself is also a
  // backstop: tasks.work_type_id's FK to work_types is default NO ACTION
  // (not CASCADE/SET NULL), so even a delete that raced past this check
  // against a concurrent insert would still be rejected by Postgres with
  // a raw FK-violation error rather than silently orphaning/blanking any
  // task. See supabase/phase12_migration_2.sql for the delete RLS policy
  // this needs (work_types had no delete policy until now -- see
  // [[feedback_supabase_rls_silent_delete_noop]], a delete with no
  // policy silently no-ops instead of erroring, which is why the count
  // check below is the primary UX path rather than relying on catching
  // an RLS failure).
  async function deleteWorkType(w: WorkTypeRow) {
    setWorkTypeBusy(true);
    const { count, error: countError } = await supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("work_type_id", w.id);
    if (countError) {
      setWorkTypeBusy(false);
      window.alert(`Couldn't check usage: ${countError.message}`);
      return;
    }
    if ((count ?? 0) > 0) {
      setWorkTypeBusy(false);
      window.alert(
        `Can't delete -- ${count} task${count === 1 ? "" : "s"} still use this Work Type. Deactivate it instead, or reassign those tasks first.`
      );
      return;
    }
    if (!window.confirm(`Delete "${w.name}"? This can't be undone.`)) {
      setWorkTypeBusy(false);
      return;
    }
    const { error } = await supabase.from("work_types").delete().eq("id", w.id);
    setWorkTypeBusy(false);
    if (error) {
      window.alert(`Couldn't delete: ${error.message}`);
      return;
    }
    loadWorkTypes();
  }

  useEffect(() => {
    if (me?.access_level === "full") {
      loadWorkTypes();
      loadHistoricalLocking();
    }
  }, [me?.access_level]);

  if (sessionLoading) return null;
  if (!me || me.access_level !== "full") return <AccessDenied />;

  return (
    <div>
      <div>
        <h1>Site settings</h1>
        <p className="subtitle">Full Access only. Configure options shared across the whole app.</p>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 600 }}>Work Types</div>
            <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
              The list of Work Type options offered on every task (Projects &amp; WBS Planning). Reorder with the arrows,
              rename inline, deactivate a type you no longer want offered on NEW tasks (deactivating keeps its label on
              any task that already has it set, it just disappears from the picker), or delete one outright if no task
              uses it. Mark a type <strong>Fixed-Schedule</strong> (e.g. Training Delivery) if its hours happen on
              specific calendar days regardless of what else is competing for that person's time -- its tasks land on
              their own day(s) and never defer, so Utilization/Day Planner can honestly show over 100% instead of
              quietly pushing the overflow to tomorrow. Leave a type Flexible (the default) if its work can genuinely
              shift to whenever capacity frees up.
            </div>
          </div>
        </div>
        <table className="data-table" style={{ width: "100%", maxWidth: 520 }}>
          <thead>
            <tr>
              <th style={{ width: 40 }} />
              <th>Name</th>
              <th style={{ width: 90 }}>Status</th>
              <th style={{ width: 110 }}>Scheduling</th>
              <th style={{ width: 150 }} />
            </tr>
          </thead>
          <tbody>
            {workTypesLoading && (
              <tr>
                <td colSpan={5} style={{ color: "var(--muted)" }}>Loading…</td>
              </tr>
            )}
            {!workTypesLoading && workTypes.length === 0 && (
              <tr>
                <td colSpan={5} style={{ color: "var(--muted)" }}>None yet.</td>
              </tr>
            )}
            {workTypes.map((w, idx) => {
              const isEditing = editingWorkTypeId === w.id;
              return (
                <tr key={w.id}>
                  <td>
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <button
                        onClick={() => moveWorkType(w, "up")}
                        disabled={workTypeBusy || idx === 0}
                        title="Move up"
                        style={{ background: "none", border: "none", cursor: idx === 0 ? "default" : "pointer", opacity: idx === 0 ? 0.3 : 1, padding: 0 }}
                      >
                        <ArrowUp size={13} />
                      </button>
                      <button
                        onClick={() => moveWorkType(w, "down")}
                        disabled={workTypeBusy || idx === workTypes.length - 1}
                        title="Move down"
                        style={{ background: "none", border: "none", cursor: idx === workTypes.length - 1 ? "default" : "pointer", opacity: idx === workTypes.length - 1 ? 0.3 : 1, padding: 0 }}
                      >
                        <ArrowDown size={13} />
                      </button>
                    </div>
                  </td>
                  <td style={{ fontWeight: 600, color: "var(--navy)" }}>
                    {isEditing ? (
                      <input
                        value={editWorkTypeName}
                        onChange={(e) => setEditWorkTypeName(e.target.value)}
                        spellCheck={false}
                        autoComplete="off"
                        style={{ ...inputStyle, marginTop: 0, fontWeight: 600 }}
                      />
                    ) : (
                      w.name
                    )}
                  </td>
                  <td>
                    <span className={`status-pill ${w.is_active ? "success" : "neutral"}`}>{w.is_active ? "Active" : "Deactivated"}</span>
                  </td>
                  <td>
                    <span
                      className={`status-pill ${w.is_fixed_schedule ? "warning" : "neutral"}`}
                      title={
                        w.is_fixed_schedule
                          ? "Fixed-Schedule: this type's hours land on their own calendar day(s) and never defer, even if that overloads the day."
                          : "Flexible: this type's hours can defer to a later day if the assignee doesn't have room."
                      }
                    >
                      {w.is_fixed_schedule ? "Fixed-Schedule" : "Flexible"}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 8 }}>
                      {isEditing ? (
                        <>
                          <button
                            onClick={() => saveWorkTypeRename(w.id)}
                            disabled={workTypeBusy}
                            title="Save"
                            style={{ display: "flex", background: "none", border: "none", cursor: "pointer", color: "var(--success-text)" }}
                          >
                            <Check size={14} />
                          </button>
                          <button
                            onClick={() => setEditingWorkTypeId(null)}
                            title="Cancel"
                            style={{ display: "flex", background: "none", border: "none", cursor: "pointer", color: "var(--muted)" }}
                          >
                            <X size={14} />
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => startEditWorkType(w)}
                            title="Rename"
                            style={{ display: "flex", background: "none", border: "none", cursor: "pointer", color: "var(--navy)" }}
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            onClick={() => toggleWorkTypeActive(w)}
                            disabled={workTypeBusy}
                            title={w.is_active ? "Deactivate" : "Reactivate"}
                            style={{ display: "flex", background: "none", border: "none", cursor: "pointer", color: w.is_active ? "var(--danger-text)" : "var(--success-text)" }}
                          >
                            {w.is_active ? <ShieldOff size={13} /> : <ShieldCheck size={13} />}
                          </button>
                          <button
                            onClick={() => toggleWorkTypeFixedSchedule(w)}
                            disabled={workTypeBusy}
                            title={w.is_fixed_schedule ? "Make Flexible (hours can defer to a later day)" : "Make Fixed-Schedule (hours never defer)"}
                            style={{ display: "flex", background: "none", border: "none", cursor: "pointer", color: w.is_fixed_schedule ? "var(--warning-text)" : "var(--muted)" }}
                          >
                            {w.is_fixed_schedule ? <CalendarClock size={13} /> : <CalendarDays size={13} />}
                          </button>
                          <button
                            onClick={() => deleteWorkType(w)}
                            disabled={workTypeBusy}
                            title="Delete (only if unused)"
                            style={{ display: "flex", background: "none", border: "none", cursor: "pointer", color: "var(--danger-text)" }}
                          >
                            <Trash2 size={13} />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div style={{ display: "flex", gap: 8, marginTop: 10, maxWidth: 480 }}>
          <input
            value={newWorkTypeName}
            onChange={(e) => setNewWorkTypeName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addWorkType();
            }}
            placeholder="New work type name"
            spellCheck={false}
            autoComplete="off"
            style={{ ...inputStyle, marginTop: 0, flex: 1 }}
          />
          <button
            onClick={addWorkType}
            disabled={workTypeBusy || !newWorkTypeName.trim()}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "7px 12px",
              fontSize: 12,
              fontWeight: 600,
              color: "#fff",
              background: "var(--navy)",
              border: "none",
              opacity: !newWorkTypeName.trim() ? 0.6 : 1,
              cursor: !newWorkTypeName.trim() ? "default" : "pointer",
            }}
          >
            <Plus size={14} />
            Add
          </button>
        </div>
      </div>

      <div
        className="card"
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}
      >
        <div>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>Lock historical ownership/assignee attribution</div>
          <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
            {historicalLockingEnabled
              ? "On -- Utilization and Day Planner freeze past attribution when a project/task changes owner or assignee."
              : "Off -- Utilization and Day Planner always show the CURRENT owner/assignee, even for past dates. Turn this on when you're ready to stop testing and go live with real data."}
          </div>
        </div>
        <button
          onClick={toggleHistoricalLocking}
          disabled={historicalLockingSaving}
          title={historicalLockingEnabled ? "Turn off" : "Turn on"}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "7px 14px",
            fontSize: 12,
            fontWeight: 600,
            color: historicalLockingEnabled ? "#fff" : "var(--navy)",
            background: historicalLockingEnabled ? "var(--success-text)" : "var(--surface)",
            border: "1px solid var(--border)",
            opacity: historicalLockingSaving ? 0.6 : 1,
            cursor: historicalLockingSaving ? "default" : "pointer",
            flexShrink: 0,
          }}
        >
          {historicalLockingSaving ? "Saving…" : historicalLockingEnabled ? "On" : "Off"}
        </button>
      </div>
    </div>
  );
}

const inputStyle: CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: 4,
  padding: "6px 8px",
  fontSize: 12,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
};
