import { useEffect, useRef, useState, type FormEvent, type CSSProperties } from "react";
import { UserPlus, ShieldCheck, ShieldOff, Pencil, Check, X, Upload, Download, Copy, Trash2, KeyRound, Plus, ArrowUp, ArrowDown } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useSession, type Person } from "../lib/useSession";
import { defaultColorFor, isValidHex } from "../lib/personColors";
import { parseCsvToObjects, getField, toCsv } from "../lib/csv";
import Modal from "../components/Modal";

// CSV bulk-import (Sandra, 2026-08-14): "data only for now, no emails sent
// -- I'll give pilot users the link and a randomly-generated password
// myself." A row whose Email doesn't match an existing person creates a
// brand-new login (via the admin-create-user Edge Function, which
// generates the password server-side and returns it once so it can be
// shown here -- Supabase never stores or re-displays a plaintext password
// after this). A row whose Email DOES match an existing person just
// updates their roster fields directly (people_update RLS already allows
// any Full Access person to do this with no Edge Function needed).
//
// "Reports To" is given as a name or email, not a raw id, and may refer to
// someone else who's ALSO new in this same CSV -- so it's resolved in a
// second pass after every row has been created/updated, once the full
// people list (including brand-new rows) is available to match against.
interface CsvRowResult {
  rowNumber: number;
  name: string;
  email: string;
  action: "created" | "updated" | "error" | "skipped";
  message?: string;
  password?: string;
}

const CSV_TEMPLATE_HEADERS = [
  "Employee ID",
  "Full Name",
  "Email",
  "Role",
  "Reports To",
  "Capacity/Day",
  "Admin",
  "Approve Closures",
  "Approve Reopening",
  "Approve Rebaseline",
  "Status",
];

function parseYesNo(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  return v === "yes" || v === "y" || v === "true" || v === "1" || v === "admin" || v === "full";
}

function parseStatus(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (!v) return true;
  return !(v === "inactive" || v === "deactivated" || v === "no" || v === "false" || v === "0");
}

function downloadTemplate() {
  const exampleRow = [
    "1001",
    "Juan Dela Cruz",
    "juan.delacruz@dermorepubliq.com",
    "Content Developer",
    "jo.sanjose@dermorepubliq.com",
    "7.5",
    "No",
    "No",
    "No",
    "No",
    "Active",
  ];
  const csv = toCsv(CSV_TEMPLATE_HEADERS, [exampleRow]);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "capaciq_user_management_template.csv";
  a.click();
  URL.revokeObjectURL(url);
}

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

// Work Type -- admin-configurable lookup (Phase 12, 2026-08-20). See
// supabase/phase12_migration.sql for the table itself (work_types).
interface WorkTypeRow {
  id: string;
  name: string;
  sort_order: number;
  is_active: boolean;
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
  const [accessLevel, setAccessLevel] = useState<"limited" | "full">("limited");
  const [reportsTo, setReportsTo] = useState("");
  const [capacityHours, setCapacityHours] = useState("7.5");
  const [employeeId, setEmployeeId] = useState("");
  const [jobTitle, setJobTitle] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editReportsTo, setEditReportsTo] = useState("");
  const [editCapacity, setEditCapacity] = useState("7.5");
  const [editEmployeeId, setEditEmployeeId] = useState("");
  const [editJobTitle, setEditJobTitle] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [resettingId, setResettingId] = useState<string | null>(null);

  // CSV bulk import (see doc comment above CSV_TEMPLATE_HEADERS).
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvResults, setCsvResults] = useState<CsvRowResult[] | null>(null);

  // Global historical-locking switch (Sandra, 2026-08-14): "we're still
  // playing around with the system" -- while off, Utilization/Day Planner
  // ignore ownership/assignee history and just use each project/task's
  // current owner_id/assignee_id, same as before that feature existed.
  const [historicalLockingEnabled, setHistoricalLockingEnabled] = useState(false);
  const [historicalLockingSaving, setHistoricalLockingSaving] = useState(false);

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

  async function loadWorkTypes() {
    setWorkTypesLoading(true);
    const { data } = await supabase.from("work_types").select("id,name,sort_order,is_active").order("sort_order");
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

  async function loadPeople() {
    setLoading(true);
    const { data } = await supabase.from("people").select("*").order("name");
    setPeople((data as Person[]) ?? []);
    setLoading(false);
  }

  async function loadSettings() {
    const { data } = await supabase.from("app_settings").select("historical_locking_enabled").eq("id", true).single();
    setHistoricalLockingEnabled((data as { historical_locking_enabled?: boolean } | null)?.historical_locking_enabled ?? false);
  }

  useEffect(() => {
    if (me?.access_level === "full") {
      loadPeople();
      loadSettings();
      loadWorkTypes();
    }
  }, [me?.access_level]);

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

  if (sessionLoading) return null;
  if (!me || me.access_level !== "full") return <AccessDenied />;

  // Sandra, 2026-08-14: an invite-email link expired on her ("otp_expired")
  // -- she doesn't want email-link auth at all, same as another app (LEAP)
  // she uses: new accounts get a random password shown once, she shares it
  // herself. Grant-access now creates the login the same way the CSV path
  // already does (admin-create-user), instead of admin-invite-user's email
  // link. admin-invite-user itself is left in place/deployed but unused by
  // this UI now, in case a real-inbox-based invite is wanted again later.
  async function handleInvite(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setFormSuccess(null);
    setSubmitting(true);

    const { data, error } = await supabase.functions.invoke("admin-create-user", {
      body: {
        name,
        email,
        access_level: accessLevel,
        reports_to: reportsTo || null,
        daily_capacity_hours: Number(capacityHours) || 7.5,
        employee_id: employeeId.trim() || null,
        job_title: jobTitle.trim() || null,
      },
    });

    setSubmitting(false);

    const result = data as { error?: string; password?: string } | null;
    if (error || result?.error) {
      // supabase-js only gives a generic "non-2xx" message on `error` — the
      // real reason is in the JSON body of the failed response, reachable via
      // error.context (the raw Response object).
      let message = result?.error || error?.message || "Failed to create login.";
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

    // Reuses the CSV-results modal (single row) to show the generated
    // password once, with the same "copy name/link/password" button.
    setCsvResults([{ rowNumber: 1, name, email, action: "created", password: result?.password }]);
    setFormSuccess(null);
    setName("");
    setEmail("");
    setAccessLevel("limited");
    setReportsTo("");
    setCapacityHours("7.5");
    setEmployeeId("");
    setJobTitle("");
    setFormOpen(false);
    loadPeople();
  }

  async function resetPassword(p: Person) {
    if (!window.confirm(`Reset ${p.name}'s password? Their old password stops working immediately -- you'll need to share the new one with them yourself.`)) {
      return;
    }
    setResettingId(p.id);
    const { data, error } = await supabase.functions.invoke("admin-reset-password", {
      body: { person_id: p.id },
    });
    setResettingId(null);
    const result = data as { error?: string; password?: string } | null;
    if (error || result?.error) {
      const message = await extractFunctionError(error, data, "Failed to reset password.");
      window.alert(`Couldn't reset password for ${p.name}: ${message}`);
      return;
    }
    setCsvResults([{ rowNumber: 1, name: p.name, email: p.email, action: "updated", message: "Password reset.", password: result?.password }]);
  }

  // Sandra, 2026-08-14: found via Joseph San Jose that a roster row created
  // by CSV-matching an existing email never gets a login (only Grant
  // access / a brand-new CSV row do) -- this gives that person a real
  // login after the fact, without disturbing their existing roster row
  // (reports-to links, role, etc. all stay put).
  async function grantLogin(p: Person) {
    if (!window.confirm(`Create a login for ${p.name} (${p.email})? You'll get a password to share with them.`)) {
      return;
    }
    setResettingId(p.id);
    const { data, error } = await supabase.functions.invoke("admin-grant-login", {
      body: { person_id: p.id },
    });
    setResettingId(null);
    const result = data as { error?: string; password?: string } | null;
    if (error || result?.error) {
      const message = await extractFunctionError(error, data, "Failed to create login.");
      window.alert(`Couldn't create a login for ${p.name}: ${message}`);
      return;
    }
    setCsvResults([{ rowNumber: 1, name: p.name, email: p.email, action: "created", password: result?.password }]);
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
      : `Reactivate ${p.name}? They'll regain the access level shown (${p.access_level === "full" ? "Full" : "Limited"}).`;

    if (!window.confirm(warning)) return;

    const { error } = await supabase.from("people").update({ is_active: !p.is_active }).eq("id", p.id);
    if (error) {
      window.alert(`Couldn't ${verb} ${p.name}: ${error.message}`);
      return;
    }
    loadPeople();
  }

  async function changeAccessLevel(p: Person, level: "limited" | "full") {
    if (p.id === me?.id && level === "limited") {
      window.alert(
        "You can't demote your own account from here \u2014 it would immediately drop you to Limited access " +
          "and lock you out of Admin. Ask another Full Access person to do it, or change your own level last."
      );
      loadPeople();
      return;
    }

    const verb = level === "full" ? "Promote" : "Demote";
    if (!window.confirm(`${verb} ${p.name} to ${level === "full" ? "Full" : "Limited"} access?`)) {
      loadPeople();
      return;
    }

    const { error } = await supabase.from("people").update({ access_level: level }).eq("id", p.id);
    if (error) {
      window.alert(`Couldn't change access level for ${p.name}: ${error.message}`);
    }
    loadPeople();
  }

  // Sandra, 2026-07-29: "add in user management who has authorization to
  // approve reopening of projects and re-baselining -- no tiering yet."
  // Flat authorization toggles, same pattern as can_approve_closures --
  // not wired to any actual approval workflow yet (reopening a closed
  // project doesn't exist as a feature yet; re-baselining exists but
  // isn't gated by this flag yet either), just settable here so the
  // designation exists ahead of that work.
  async function toggleApprovalFlag(p: Person, field: "can_approve_closures" | "can_approve_reopening" | "can_approve_rebaseline", value: boolean) {
    setPeople((prev) => prev.map((x) => (x.id === p.id ? { ...x, [field]: value } : x)));
    const { error } = await supabase.from("people").update({ [field]: value }).eq("id", p.id);
    if (error) {
      window.alert(`Couldn't save: ${error.message}`);
      loadPeople();
    }
  }

  // Per-person color for the WBS Gantt chart's assignee-based bar
  // coloring (Sandra, 2026-07-24) -- stored as a nullable hex string;
  // `null` means "use the deterministic default," not "no color."
  async function saveColor(p: Person, hex: string | null) {
    const value = hex && isValidHex(hex) ? hex.trim() : null;
    setPeople((prev) => prev.map((x) => (x.id === p.id ? { ...x, color: value } : x)));
    const { error } = await supabase.from("people").update({ color: value }).eq("id", p.id);
    if (error) {
      window.alert(`Couldn't save color: ${error.message}`);
      loadPeople();
    }
  }

  function startEdit(p: Person) {
    setEditingId(p.id);
    setEditName(p.name);
    setEditReportsTo(p.reports_to ?? "");
    setEditCapacity(String(p.daily_capacity_hours));
    setEditEmployeeId(p.employee_id ?? "");
    setEditJobTitle(p.job_title ?? "");
    setEditEmail(p.email);
  }

  function cancelEdit() {
    setEditingId(null);
  }

  // Pulls the real error message out of a failed Edge Function invoke --
  // supabase-js only gives a generic "non-2xx" message on `error`, the
  // actual reason is JSON in the response body (same pattern as handleInvite).
  async function extractFunctionError(error: unknown, data: unknown, fallback: string): Promise<string> {
    let message = (data as { error?: string } | null)?.error || (error as Error | undefined)?.message || fallback;
    const context = (error as { context?: Response } | undefined)?.context;
    if (context && typeof context.json === "function") {
      try {
        const body = await context.clone().json();
        if (body?.error) message = body.error;
      } catch {
        // response wasn't JSON — keep the generic message
      }
    }
    return message;
  }

  async function saveEdit(p: Person) {
    if (p.id === editReportsTo) {
      window.alert("Someone can't report to themselves.");
      return;
    }
    setEditSaving(true);

    // Email lives on both the people row and the Supabase Auth login, so
    // changing it goes through the admin-update-email Edge Function (it
    // updates the login first, then the people row) rather than a plain
    // table update.
    const newEmail = editEmail.trim().toLowerCase();
    if (newEmail && newEmail !== p.email.toLowerCase()) {
      const { data, error } = await supabase.functions.invoke("admin-update-email", {
        body: { person_id: p.id, new_email: newEmail },
      });
      if (error || (data as { error?: string })?.error) {
        const message = await extractFunctionError(error, data, "Failed to update email.");
        setEditSaving(false);
        window.alert(`Couldn't update email: ${message}`);
        return;
      }
    }

    const { error } = await supabase
      .from("people")
      .update({
        name: editName.trim() || p.name,
        reports_to: editReportsTo || null,
        daily_capacity_hours: Number(editCapacity) || p.daily_capacity_hours,
        employee_id: editEmployeeId.trim() || null,
        job_title: editJobTitle.trim() || null,
      })
      .eq("id", p.id);
    setEditSaving(false);
    if (error) {
      window.alert(`Couldn't save changes: ${error.message}`);
      return;
    }
    setEditingId(null);
    loadPeople();
  }

  // Hard delete (Sandra, 2026-08-14): "for fixing mistakes -- wrong CSV
  // row, duplicate, test account." Deliberately does NOT try to reassign
  // or archive history -- if the person owns/is assigned to anything, has
  // logged time, or is listed as someone's manager, the people table's own
  // foreign keys (no ON DELETE CASCADE anywhere) reject the delete and the
  // Edge Function surfaces that as a friendly error pointing at Deactivate
  // instead. This keeps the ownership/utilization history features intact.
  async function deletePerson(p: Person) {
    if (p.id === me?.id) {
      window.alert("You can't delete your own account. Ask another Full Access person to do it.");
      return;
    }
    if (
      !window.confirm(
        `Permanently delete ${p.name}? This removes their login and record entirely and can't be undone. ` +
          `Only do this for a mistaken entry (wrong CSV row, duplicate, test account) -- if they have any real ` +
          `history in the system, this will be rejected and you should use Deactivate instead.`
      )
    ) {
      return;
    }
    setDeletingId(p.id);
    const { data, error } = await supabase.functions.invoke("admin-delete-user", {
      body: { person_id: p.id },
    });
    setDeletingId(null);
    if (error || (data as { error?: string })?.error) {
      const message = await extractFunctionError(error, data, "Failed to delete person.");
      window.alert(`Couldn't delete ${p.name}: ${message}`);
      return;
    }
    if ((data as { warning?: string })?.warning) {
      window.alert((data as { warning: string }).warning);
    }
    loadPeople();
  }

  async function handleCsvFile(file: File) {
    setCsvBusy(true);
    setCsvResults(null);
    try {
      const text = await file.text();
      const { headers, rows } = parseCsvToObjects(text);
      if (headers.length === 0 || rows.length === 0) {
        window.alert("That file looks empty. Use \"Download template\" for the expected format.");
        setCsvBusy(false);
        return;
      }

      const results: CsvRowResult[] = [];
      // reportsToByRow tracks each row's raw "Reports To" text (name or
      // email) alongside the id of the person it applies to, so it can be
      // resolved in a second pass below once everyone in this batch has a
      // real people-row id (including brand-new people created moments ago).
      const reportsToByRow: { personId: string; raw: string }[] = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNumber = i + 2; // +1 for 0-index, +1 for the header row
        const fullName = getField(row, "Full Name", "Name").trim();
        const emailRaw = getField(row, "Email").trim();
        const email = emailRaw.toLowerCase();

        if (!fullName || !emailRaw) {
          results.push({ rowNumber, name: fullName || "(no name)", email: emailRaw, action: "error", message: "Full Name and Email are required." });
          continue;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) {
          results.push({ rowNumber, name: fullName, email: emailRaw, action: "error", message: "Not a valid email address." });
          continue;
        }

        const employee_id = getField(row, "Employee ID", "Employee Id", "EmployeeID").trim() || null;
        const job_title = getField(row, "Role", "Job Title").trim() || null;
        const reportsToRaw = getField(row, "Reports To", "Reports to", "Manager").trim();
        const capacityRaw = getField(row, "Capacity/Day", "Capacity per Day", "Daily Capacity", "Capacity");
        const daily_capacity_hours = Number(capacityRaw) > 0 ? Number(capacityRaw) : 7.5;
        const access_level: "full" | "limited" = parseYesNo(getField(row, "Admin", "Access Rights", "Access Level")) ? "full" : "limited";
        const can_approve_closures = parseYesNo(getField(row, "Approve Closures", "Approval Closures"));
        const can_approve_reopening = parseYesNo(getField(row, "Approve Reopening"));
        const can_approve_rebaseline = parseYesNo(getField(row, "Approve Rebaseline"));
        const is_active = parseStatus(getField(row, "Status"));

        const existing = people.find((p) => p.email.toLowerCase() === email);

        if (existing) {
          const { error } = await supabase
            .from("people")
            .update({
              name: fullName,
              employee_id,
              job_title,
              daily_capacity_hours,
              access_level,
              can_approve_closures,
              can_approve_reopening,
              can_approve_rebaseline,
              is_active,
            })
            .eq("id", existing.id);
          if (error) {
            results.push({ rowNumber, name: fullName, email: emailRaw, action: "error", message: error.message });
            continue;
          }
          results.push({ rowNumber, name: fullName, email: emailRaw, action: "updated" });
          if (reportsToRaw) reportsToByRow.push({ personId: existing.id, raw: reportsToRaw });
        } else {
          const { data, error } = await supabase.functions.invoke("admin-create-user", {
            body: {
              name: fullName,
              email: emailRaw,
              access_level,
              daily_capacity_hours,
              employee_id,
              job_title,
              can_approve_closures,
              can_approve_reopening,
              can_approve_rebaseline,
              is_active,
            },
          });
          const errBody = data as { error?: string; person?: Person; password?: string } | null;
          if (error || errBody?.error) {
            let message = errBody?.error || error?.message || "Failed to create login.";
            const context = (error as { context?: Response } | undefined)?.context;
            if (context && typeof context.json === "function") {
              try {
                const parsedBody = await context.clone().json();
                if (parsedBody?.error) message = parsedBody.error;
              } catch {
                // not JSON -- keep generic message
              }
            }
            results.push({ rowNumber, name: fullName, email: emailRaw, action: "error", message });
            continue;
          }
          results.push({ rowNumber, name: fullName, email: emailRaw, action: "created", password: errBody?.password });
          if (reportsToRaw && errBody?.person) reportsToByRow.push({ personId: errBody.person.id, raw: reportsToRaw });
        }
      }

      // Second pass: resolve "Reports To" now that every row in this batch
      // has a real people-row id -- matches by email first (unambiguous),
      // falling back to an exact case-insensitive full-name match.
      if (reportsToByRow.length > 0) {
        const { data: freshPeople } = await supabase.from("people").select("*");
        const all = (freshPeople as Person[]) ?? [];
        for (const { personId, raw } of reportsToByRow) {
          const rawLower = raw.toLowerCase();
          const manager = all.find((p) => p.email.toLowerCase() === rawLower) ?? all.find((p) => p.name.toLowerCase() === rawLower);
          if (!manager) {
            const r = results.find((res) => res.email.toLowerCase() === all.find((p) => p.id === personId)?.email.toLowerCase());
            if (r) r.message = `${r.message ? r.message + " " : ""}Couldn't match "Reports To: ${raw}" to anyone -- left blank.`;
            continue;
          }
          if (manager.id === personId) continue; // can't report to self
          await supabase.from("people").update({ reports_to: manager.id }).eq("id", personId);
        }
      }

      setCsvResults(results);
      loadPeople();
    } catch (e) {
      window.alert(`Couldn't read that file: ${e instanceof Error ? e.message : "unknown error"}`);
    }
    setCsvBusy(false);
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1>User management</h1>
          <p className="subtitle">Full Access only. Grant access, adjust permissions, or deactivate people.</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={downloadTemplate}
            title="Download a CSV template with the expected column headers"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "7px 12px",
              fontSize: 12,
              fontWeight: 600,
              color: "var(--navy)",
              background: "var(--surface)",
              border: "1px solid var(--border)",
            }}
          >
            <Download size={14} />
            Download template
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={csvBusy}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "7px 12px",
              fontSize: 12,
              fontWeight: 600,
              color: "var(--navy)",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              opacity: csvBusy ? 0.6 : 1,
              cursor: csvBusy ? "default" : "pointer",
            }}
          >
            <Upload size={14} />
            {csvBusy ? "Uploading…" : "Upload CSV"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleCsvFile(file);
              e.target.value = "";
            }}
          />
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
      </div>

      <div
        className="card"
        style={{ marginBottom: 16, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}
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

      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div>
            <div style={{ fontSize: 12.5, fontWeight: 600 }}>Work Types</div>
            <div style={{ fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>
              The list of Work Type options offered on every task (Projects &amp; WBS Planning). Reorder with the arrows,
              rename inline, or deactivate a type you no longer want offered on NEW tasks -- deactivating keeps its label
              on any task that already has it set, it just disappears from the picker.
            </div>
          </div>
        </div>
        <table className="data-table" style={{ width: "100%", maxWidth: 480 }}>
          <thead>
            <tr>
              <th style={{ width: 40 }} />
              <th>Name</th>
              <th style={{ width: 90 }}>Status</th>
              <th style={{ width: 90 }} />
            </tr>
          </thead>
          <tbody>
            {workTypesLoading && (
              <tr>
                <td colSpan={4} style={{ color: "var(--muted)" }}>Loading…</td>
              </tr>
            )}
            {!workTypesLoading && workTypes.length === 0 && (
              <tr>
                <td colSpan={4} style={{ color: "var(--muted)" }}>None yet.</td>
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

      {formOpen && (
        <form onSubmit={handleInvite} className="card" style={{ marginBottom: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-secondary)" }}>
            Full name
            <input required spellCheck={false} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
          </label>
          <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-secondary)" }}>
            Email
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} style={inputStyle} />
          </label>
          <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-secondary)" }}>
            Access level
            <select value={accessLevel} onChange={(e) => setAccessLevel(e.target.value as "limited" | "full")} style={inputStyle}>
              <option value="limited">Limited</option>
              <option value="full">Full</option>
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
          <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-secondary)" }}>
            Employee ID
            <input spellCheck={false} autoComplete="off" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} style={inputStyle} />
          </label>
          <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-secondary)" }}>
            Role (job title)
            <input spellCheck={false} autoComplete="off" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} style={inputStyle} />
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
              <th>Employee ID</th>
              <th>Role</th>
              <th>Color</th>
              <th>Email</th>
              <th>Access</th>
              <th>Reports to</th>
              <th>Capacity/day</th>
              <th title="Flat authorization flags -- not tiered yet. Reopening a Closed project, re-baselining, and Closed-project decisions aren't tiered further than this, this is just the designation.">
                Approvals
              </th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={11} style={{ color: "var(--muted)" }}>Loading…</td>
              </tr>
            )}
            {!loading && people.length === 0 && (
              <tr>
                <td colSpan={11} style={{ color: "var(--muted)" }}>No one yet.</td>
              </tr>
            )}
            {people.map((p) => {
              const isEditing = editingId === p.id;
              return (
                <tr key={p.id}>
                  <td style={{ fontWeight: 600, color: "var(--navy)" }}>
                    {isEditing ? (
                      <input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        spellCheck={false}
                        autoComplete="off"
                        style={{ ...inputStyle, marginTop: 0, fontWeight: 600 }}
                      />
                    ) : (
                      p.name
                    )}
                  </td>
                  <td>
                    {isEditing ? (
                      <input
                        value={editEmployeeId}
                        onChange={(e) => setEditEmployeeId(e.target.value)}
                        spellCheck={false}
                        autoComplete="off"
                        style={{ ...inputStyle, marginTop: 0, width: 90 }}
                      />
                    ) : (
                      p.employee_id ?? "—"
                    )}
                  </td>
                  <td>
                    {isEditing ? (
                      <input
                        value={editJobTitle}
                        onChange={(e) => setEditJobTitle(e.target.value)}
                        spellCheck={false}
                        autoComplete="off"
                        style={{ ...inputStyle, marginTop: 0, width: 130 }}
                      />
                    ) : (
                      p.job_title ?? "—"
                    )}
                  </td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <input
                        type="color"
                        value={p.color || defaultColorFor(p.id)}
                        onChange={(e) => saveColor(p, e.target.value)}
                        title="Pick a color -- used for this person's bars in the WBS Gantt chart"
                        style={{ width: 26, height: 22, padding: 0, border: "1px solid var(--border)", borderRadius: 4, cursor: "pointer", background: "none" }}
                      />
                      <input
                        key={`${p.id}-${p.color ?? "default"}`}
                        type="text"
                        defaultValue={p.color ?? ""}
                        placeholder={defaultColorFor(p.id)}
                        spellCheck={false}
                        autoComplete="off"
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          if (v && !isValidHex(v)) {
                            window.alert(`"${v}" isn't a valid hex color (expected format: #3b82f6). Not saved.`);
                            e.target.value = p.color ?? "";
                            return;
                          }
                          saveColor(p, v || null);
                        }}
                        style={{ ...inputStyle, marginTop: 0, width: 78, fontFamily: "monospace", fontSize: 11 }}
                      />
                    </div>
                  </td>
                  <td>
                    {isEditing ? (
                      <input
                        type="email"
                        value={editEmail}
                        onChange={(e) => setEditEmail(e.target.value)}
                        spellCheck={false}
                        autoComplete="off"
                        title="Changes their login email too"
                        style={{ ...inputStyle, marginTop: 0, width: 150 }}
                      />
                    ) : (
                      p.email
                    )}
                  </td>
                  <td>
                    <select
                      value={p.access_level}
                      onChange={(e) => changeAccessLevel(p, e.target.value as "limited" | "full")}
                      style={{ fontSize: 11, padding: "3px 5px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}
                    >
                      <option value="limited">Limited</option>
                      <option value="full">Full</option>
                    </select>
                  </td>
                  <td>
                    {isEditing ? (
                      <select
                        value={editReportsTo}
                        onChange={(e) => setEditReportsTo(e.target.value)}
                        style={{ ...inputStyle, marginTop: 0 }}
                      >
                        <option value="">— none —</option>
                        {people
                          .filter((x) => x.id !== p.id)
                          .map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.name}
                            </option>
                          ))}
                      </select>
                    ) : (
                      people.find((x) => x.id === p.reports_to)?.name ?? "—"
                    )}
                  </td>
                  <td>
                    {isEditing ? (
                      <input
                        type="number"
                        step="0.5"
                        value={editCapacity}
                        onChange={(e) => setEditCapacity(e.target.value)}
                        style={{ ...inputStyle, marginTop: 0, width: 70 }}
                      />
                    ) : (
                      p.daily_capacity_hours
                    )}
                  </td>
                  <td>
                    <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11 }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }} title="Decide WBS Closed-project decisions (in addition to Full Access and the project owner)">
                        <input
                          type="checkbox"
                          checked={p.can_approve_closures}
                          onChange={(e) => toggleApprovalFlag(p, "can_approve_closures", e.target.checked)}
                        />
                        Closures
                      </label>
                      <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={p.can_approve_reopening}
                          onChange={(e) => toggleApprovalFlag(p, "can_approve_reopening", e.target.checked)}
                        />
                        Reopen projects
                      </label>
                      <label style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={p.can_approve_rebaseline}
                          onChange={(e) => toggleApprovalFlag(p, "can_approve_rebaseline", e.target.checked)}
                        />
                        Re-baseline
                      </label>
                    </div>
                  </td>
                  <td>
                    <span className={`status-pill ${p.is_active ? "success" : "neutral"}`}>
                      {p.is_active ? "Active" : "Deactivated"}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      {isEditing ? (
                        <>
                          <button
                            onClick={() => saveEdit(p)}
                            disabled={editSaving}
                            title="Save"
                            style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", color: "var(--success-text)", fontSize: 11, fontWeight: 600 }}
                          >
                            <Check size={13} />
                            {editSaving ? "Saving…" : "Save"}
                          </button>
                          <button
                            onClick={cancelEdit}
                            disabled={editSaving}
                            title="Cancel"
                            style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", color: "var(--muted)", fontSize: 11 }}
                          >
                            <X size={13} />
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => startEdit(p)}
                            title="Edit"
                            style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", color: "var(--accent)", fontSize: 11 }}
                          >
                            <Pencil size={13} />
                            Edit
                          </button>
                          <button
                            onClick={() => toggleActive(p)}
                            title={p.is_active ? "Deactivate" : "Reactivate"}
                            style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", color: p.is_active ? "var(--danger-text)" : "var(--success-text)", fontSize: 11 }}
                          >
                            {p.is_active ? <ShieldOff size={13} /> : <ShieldCheck size={13} />}
                            {p.is_active ? "Deactivate" : "Reactivate"}
                          </button>
                          {p.auth_user_id ? (
                            <button
                              onClick={() => resetPassword(p)}
                              disabled={resettingId === p.id}
                              title="Generate a new password to share with this person -- no email sent"
                              style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", color: "var(--navy)", fontSize: 11 }}
                            >
                              <KeyRound size={13} />
                              {resettingId === p.id ? "Resetting…" : "Reset password"}
                            </button>
                          ) : (
                            <button
                              onClick={() => grantLogin(p)}
                              disabled={resettingId === p.id}
                              title="This person doesn't have a login yet -- create one and get a password to share"
                              style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", color: "var(--warning-text)", fontSize: 11 }}
                            >
                              <KeyRound size={13} />
                              {resettingId === p.id ? "Creating…" : "Give login"}
                            </button>
                          )}
                          <button
                            onClick={() => deletePerson(p)}
                            disabled={deletingId === p.id}
                            title="Permanently delete -- only for mistaken entries with no history"
                            style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", color: "var(--danger-text)", fontSize: 11 }}
                          >
                            <Trash2 size={13} />
                            {deletingId === p.id ? "Deleting…" : "Delete"}
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
      </div>

      {csvResults && (
        <Modal title={csvResults.length === 1 ? "Login details" : "CSV import results"} onClose={() => setCsvResults(null)} width={620}>
          <p style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 0 }}>
            {csvResults.length === 1
              ? "Copy the password below and share it (and the app link) with this person yourself -- nothing was emailed."
              : <>
                  {csvResults.filter((r) => r.action === "created").length} created,{" "}
                  {csvResults.filter((r) => r.action === "updated").length} updated,{" "}
                  {csvResults.filter((r) => r.action === "error").length} failed. For each newly created login below, copy
                  the password and share it (and the app link) with that person yourself -- nothing was emailed.
                </>}
          </p>
          <div style={{ maxHeight: 360, overflowY: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Result</th>
                  <th>Password</th>
                </tr>
              </thead>
              <tbody>
                {csvResults.map((r) => (
                  <tr key={r.rowNumber}>
                    <td>{r.rowNumber}</td>
                    <td>{r.name}</td>
                    <td>{r.email}</td>
                    <td>
                      <span
                        className={`status-pill ${r.action === "error" ? "danger" : r.action === "created" ? "success" : "neutral"}`}
                        title={r.message}
                      >
                        {r.action === "created" ? "Created" : r.action === "updated" ? "Updated" : r.action === "error" ? "Error" : "Skipped"}
                      </span>
                      {r.message && r.action !== "error" && (
                        <div style={{ fontSize: 10.5, color: "var(--warning-text)", marginTop: 2 }}>{r.message}</div>
                      )}
                      {r.message && r.action === "error" && (
                        <div style={{ fontSize: 10.5, color: "var(--danger-text)", marginTop: 2 }}>{r.message}</div>
                      )}
                    </td>
                    <td>
                      {r.password ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                          <code style={{ fontSize: 11 }}>{r.password}</code>
                          <button
                            onClick={() => navigator.clipboard.writeText(`${r.name} <${r.email}>\nLink: ${window.location.origin}${window.location.pathname}\nTemporary password: ${r.password}`)}
                            title="Copy name, link, and password to share with this person"
                            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--accent)" }}
                          >
                            <Copy size={12} />
                          </button>
                        </div>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
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
