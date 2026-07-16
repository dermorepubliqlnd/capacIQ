import { useEffect, useState, type FormEvent, type CSSProperties } from "react";
import { UserPlus, ShieldCheck, ShieldOff } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useSession, type Person } from "../lib/useSession";

function AccessDenied() {
  return (
    <div>
      <h1>User management</h1>
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

export default function Admin() {
  const { person: me, loading: sessionLoading } = useSession();
  const [people, setPeople] = useState<Person[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [accessLevel, setAccessLevel] = useState<"standard" | "full">("standard");
  const [reportsTo, setReportsTo] = useState("");
  const [capacityHours, setCapacityHours] = useState("7.5");

  async function loadPeople() {
    setLoading(true);
    const { data } = await supabase.from("people").select("*").order("name");
    setPeople((data as Person[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    if (me?.access_level === "full") loadPeople();
  }, [me?.access_level]);

  if (sessionLoading) return null;
  if (!me || me.access_level !== "full") return <AccessDenied />;

  async function handleInvite(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setFormSuccess(null);
    setSubmitting(true);

    const { data, error } = await supabase.functions.invoke("admin-invite-user", {
      body: {
        name,
        email,
        access_level: accessLevel,
        reports_to: reportsTo || null,
        daily_capacity_hours: Number(capacityHours) || 7.5,
      },
    });

    setSubmitting(false);

    if (error || (data as { error?: string })?.error) {
      // supabase-js only gives a generic "non-2xx" message on `error` — the
      // real reason is in the JSON body of the failed response, reachable via
      // error.context (the raw Response object).
      let message = (data as { error?: string })?.error || error?.message || "Failed to invite user.";
      const context = (error as { context?: Response } | undefined)?.context;
      if (context && typeof context.json === "function") {
        try {
          const body = await context.clone().json();
          if (body?.error) message = body.error;
        } catch {
          // response wasn't JSON — keep the generic message
        }
      }
      setFormError(message);
      return;
    }

    setFormSuccess(`Invited ${name}. They'll get an email to set their password.`);
    setName("");
    setEmail("");
    setAccessLevel("standard");
    setReportsTo("");
    setCapacityHours("7.5");
    setFormOpen(false);
    loadPeople();
  }

  async function toggleActive(p: Person) {
    if (p.id === me?.id && p.is_active) {
      window.alert(
        "You can't deactivate your own account from here \u2014 it would immediately lock you out of Admin, " +
          "since deactivating removes Full Access on the spot. Ask another Full Access person to do it, or deactivate " +
          "yourself last."
      );
      return;
    }

    const verb = p.is_active ? "deactivate" : "reactivate";
    const warning = p.is_active
      ? `Deactivate ${p.name}? They'll immediately lose access to CapacIQ. You can reactivate them any time.`
      : `Reactivate ${p.name}? They'll regain the access level shown (${p.access_level === "full" ? "Full Access" : "Standard"}).`;

    if (!window.confirm(warning)) return;

    const { error } = await supabase.from("people").update({ is_active: !p.is_active }).eq("id", p.id);
    if (error) {
      window.alert(`Couldn't ${verb} ${p.name}: ${error.message}`);
      return;
    }
    loadPeople();
  }

  async function changeAccessLevel(p: Person, level: "standard" | "full") {
    await supabase.from("people").update({ access_level: level }).eq("id", p.id);
    loadPeople();
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1>User management</h1>
          <p className="subtitle">Full Access only. Grant access, adjust permissions, or deactivate people.</p>
        </div>
        <button
          onClick={() => setFormOpen((v) => !v)}
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
          }}
        >
          <UserPlus size={14} />
          {formOpen ? "Cancel" : "Grant access"}
        </button>
      </div>

      {formOpen && (
        <form onSubmit={handleInvite} className="card" style={{ marginBottom: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-secondary)" }}>
            Full name
            <input required value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
          </label>
          <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-secondary)" }}>
            Email
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} style={inputStyle} />
          </label>
          <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-secondary)" }}>
            Access level
            <select value={accessLevel} onChange={(e) => setAccessLevel(e.target.value as "standard" | "full")} style={inputStyle}>
              <option value="standard">Standard</option>
              <option value="full">Full Access</option>
            </select>
          </label>
          <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-secondary)" }}>
            Reports to
            <select value={reportsTo} onChange={(e) => setReportsTo(e.target.value)} style={inputStyle}>
              <option value="">— none —</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-secondary)" }}>
            Daily capacity (hrs)
            <input type="number" step="0.5" value={capacityHours} onChange={(e) => setCapacityHours(e.target.value)} style={inputStyle} />
          </label>

          <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: 10 }}>
            <button
              type="submit"
              disabled={submitting}
              style={{ padding: "7px 14px", fontSize: 12, fontWeight: 600, color: "#fff", background: "var(--accent)", border: "none" }}
            >
              {submitting ? "Sending invite…" : "Send invite"}
            </button>
            {formError && <span style={{ fontSize: 11.5, color: "var(--danger-text)" }}>{formError}</span>}
            {formSuccess && <span style={{ fontSize: 11.5, color: "var(--success-text)" }}>{formSuccess}</span>}
          </div>
        </form>
      )}

      <div className="card" style={{ padding: 0 }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Access</th>
              <th>Reports to</th>
              <th>Capacity/day</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={7} style={{ color: "var(--muted)" }}>Loading…</td>
              </tr>
            )}
            {!loading && people.length === 0 && (
              <tr>
                <td colSpan={7} style={{ color: "var(--muted)" }}>No one yet.</td>
              </tr>
            )}
            {people.map((p) => (
              <tr key={p.id}>
                <td style={{ fontWeight: 600, color: "var(--navy)" }}>{p.name}</td>
                <td>{p.email}</td>
                <td>
                  <select
                    value={p.access_level}
                    onChange={(e) => changeAccessLevel(p, e.target.value as "standard" | "full")}
                    style={{ fontSize: 11, padding: "3px 5px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}
                  >
                    <option value="standard">Standard</option>
                    <option value="full">Full Access</option>
                  </select>
                </td>
                <td>{people.find((x) => x.id === p.reports_to)?.name ?? "—"}</td>
                <td>{p.daily_capacity_hours}</td>
                <td>
                  <span className={`status-pill ${p.is_active ? "success" : "neutral"}`}>
                    {p.is_active ? "Active" : "Deactivated"}
                  </span>
                </td>
                <td>
                  <button
                    onClick={() => toggleActive(p)}
                    title={p.is_active ? "Deactivate" : "Reactivate"}
                    style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", color: p.is_active ? "var(--danger-text)" : "var(--success-text)", fontSize: 11 }}
                  >
                    {p.is_active ? <ShieldOff size={13} /> : <ShieldCheck size={13} />}
                    {p.is_active ? "Deactivate" : "Reactivate"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
