import { useEffect, useMemo, useRef, useState, type FormEvent, type CSSProperties } from "react";
import { UserPlus, Upload, Download, Copy, Search } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useSession, type Person } from "../lib/useSession";
import { defaultColorFor, isValidHex } from "../lib/personColors";
import { parseCsvToObjects, getField, toCsv } from "../lib/csv";
import Modal from "../components/Modal";
import UserDrawer from "../components/UserDrawer";
import UserRowMenu from "../components/UserRowMenu";
import { useConfirm } from "../lib/useConfirm";

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

export default function Admin() {
  const { person: me, loading: sessionLoading } = useSession();
  const { confirm, alert, dialog } = useConfirm();
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

  // User Management redesign (2026-08-20, Sandra's brief): View User
  // Details -> Edit User -> Save/Cancel, with a right-side drawer instead
  // of always-visible inline table controls. `drawerMode` starts at
  // "view" every time a row is selected -- only clicking "Edit user"
  // (in the drawer footer or the row's ... menu) switches to "edit".
  const [selectedPersonId, setSelectedPersonId] = useState<string | null>(null);
  const [drawerMode, setDrawerMode] = useState<"view" | "edit">("view");

  // Filter bar (client-side only -- the roster is small and already
  // fully loaded, no pagination to worry about).
  const [searchQuery, setSearchQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [accessFilter, setAccessFilter] = useState<"" | "full" | "limited">("");
  const [statusFilter, setStatusFilter] = useState<"" | "active" | "inactive">("");

  async function loadPeople() {
    setLoading(true);
    const { data } = await supabase.from("people").select("*").order("name");
    setPeople((data as Person[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    if (me?.access_level === "full") {
      loadPeople();
    }
  }, [me?.access_level]);

  const filteredPeople = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return people.filter((p) => {
      if (q) {
        const hay = `${p.name} ${p.email} ${p.employee_id ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (roleFilter && (p.job_title ?? "") !== roleFilter) return false;
      if (accessFilter && p.access_level !== accessFilter) return false;
      if (statusFilter === "active" && !p.is_active) return false;
      if (statusFilter === "inactive" && p.is_active) return false;
      return true;
    });
  }, [people, searchQuery, roleFilter, accessFilter, statusFilter]);

  const roleOptions = useMemo(() => {
    const set = new Set<string>();
    people.forEach((p) => {
      if (p.job_title) set.add(p.job_title);
    });
    return Array.from(set).sort();
  }, [people]);

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
    if (
      !(await confirm({
        title: "Reset password",
        message: `Reset ${p.name}'s password? Their old password stops working immediately -- you'll need to share the new one with them yourself.`,
        confirmLabel: "Reset password",
        danger: true,
      }))
    ) {
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
      await alert(`Couldn't reset password for ${p.name}: ${message}`);
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
    if (
      !(await confirm({
        title: "Create login",
        message: `Create a login for ${p.name} (${p.email})? You'll get a password to share with them.`,
        confirmLabel: "Create login",
      }))
    ) {
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
      await alert(`Couldn't create a login for ${p.name}: ${message}`);
      return;
    }
    setCsvResults([{ rowNumber: 1, name: p.name, email: p.email, action: "created", password: result?.password }]);
    loadPeople();
  }

  async function toggleActive(p: Person) {
    if (p.id === me?.id && p.is_active) {
      await alert(
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

    if (
      !(await confirm({
        title: p.is_active ? "Deactivate account" : "Reactivate account",
        message: warning,
        confirmLabel: p.is_active ? "Deactivate" : "Reactivate",
        danger: p.is_active,
      }))
    )
      return;

    const { error } = await supabase.from("people").update({ is_active: !p.is_active }).eq("id", p.id);
    if (error) {
      await alert(`Couldn't ${verb} ${p.name}: ${error.message}`);
      return;
    }
    loadPeople();
  }

  async function changeAccessLevel(p: Person, level: "limited" | "full") {
    if (p.id === me?.id && level === "limited") {
      await alert(
        "You can't demote your own account from here \u2014 it would immediately drop you to Limited access " +
          "and lock you out of Admin. Ask another Full Access person to do it, or change your own level last."
      );
      loadPeople();
      return;
    }

    const verb = level === "full" ? "Promote" : "Demote";
    if (
      !(await confirm({
        title: `${verb} access`,
        message: `${verb} ${p.name} to ${level === "full" ? "Full" : "Limited"} access?`,
        confirmLabel: verb,
        danger: level === "limited",
      }))
    ) {
      loadPeople();
      return;
    }

    const { error } = await supabase.from("people").update({ access_level: level }).eq("id", p.id);
    if (error) {
      await alert(`Couldn't change access level for ${p.name}: ${error.message}`);
    }
    loadPeople();
  }

  // Sandra, 2026-07-29: "add in user management who has authorization to
  // approve reopening of projects and re-baselining -- no tiering yet."
  // QA fix (2026-08-21): can_approve_reopening was removed -- it was
  // never wired to anything (the "reopen a closed project" feature it
  // was meant for was never built, and TASK reopening -- a separate,
  // already-existing action -- used a flat Full-Access check that never
  // consulted this flag either). Task reopening now uses a real
  // manager-chain check instead (see canReopenTask in Projects.tsx) per
  // Sandra: "re-opening task will only be done by the immediate manager
  // with skip level option as fallback." can_approve_closures/
  // can_approve_rebaseline are unaffected -- both are genuinely wired
  // (can_decide_closure, can_decide_baseline_request).
  async function toggleApprovalFlag(p: Person, field: "can_approve_closures" | "can_approve_rebaseline", value: boolean) {
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
    setSelectedPersonId(p.id);
    setDrawerMode("edit");
    setEditName(p.name);
    setEditReportsTo(p.reports_to ?? "");
    setEditCapacity(String(p.daily_capacity_hours));
    setEditEmployeeId(p.employee_id ?? "");
    setEditJobTitle(p.job_title ?? "");
    setEditEmail(p.email);
  }

  function cancelEdit() {
    setDrawerMode("view");
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
    setDrawerMode("view");
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
      await alert("You can't delete your own account. Ask another Full Access person to do it.");
      return;
    }
    if (
      !(await confirm({
        title: "Delete person",
        message:
          `Permanently delete ${p.name}? This removes their login and record entirely and can't be undone. ` +
          `Only do this for a mistaken entry (wrong CSV row, duplicate, test account) -- if they have any real ` +
          `history in the system, this will be rejected and you should use Deactivate instead.`,
        confirmLabel: "Delete permanently",
        danger: true,
      }))
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
      await alert(`Couldn't delete ${p.name}: ${message}`);
      return;
    }
    if ((data as { warning?: string })?.warning) {
      await alert((data as { warning: string }).warning);
    }
    if (selectedPersonId === p.id) {
      setSelectedPersonId(null);
      setDrawerMode("view");
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

  const selectedPerson = people.find((p) => p.id === selectedPersonId) ?? null;

  function approvalSummary(p: Person): string {
    const n = [p.can_approve_closures, p.can_approve_rebaseline].filter(Boolean).length;
    if (n === 0) return "None";
    return `${n} permission${n === 1 ? "" : "s"}`;
  }

  function initialsFor(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function selectPerson(p: Person) {
    setSelectedPersonId(p.id);
    setDrawerMode("view");
  }

  function closeDrawer() {
    setSelectedPersonId(null);
    setDrawerMode("view");
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1>User management</h1>
          <p className="subtitle">Manage team members, their capacity, system access, and approval rights.</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={downloadTemplate}
            title="Download a CSV template with the expected column headers"
            style={secondaryBtnStyle}
          >
            <Download size={14} />
            Download template
          </button>
          <button onClick={() => fileInputRef.current?.click()} disabled={csvBusy} style={{ ...secondaryBtnStyle, opacity: csvBusy ? 0.6 : 1, cursor: csvBusy ? "default" : "pointer" }}>
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
            onClick={() => {
              setFormError(null);
              setFormSuccess(null);
              setFormOpen(true);
            }}
            style={primaryBtnStyle}
          >
            <UserPlus size={14} />
            Add user
          </button>
        </div>
      </div>

      {/* Search + filters -- client-side only over the already-loaded roster. */}
      <div className="card" style={{ marginBottom: 16, display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <div style={{ position: "relative", flex: "1 1 240px", minWidth: 200 }}>
          <Search size={14} style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "var(--muted)", pointerEvents: "none" }} />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search name, email, or employee ID"
            spellCheck={false}
            autoComplete="off"
            style={{ ...inputStyle, marginTop: 0, paddingLeft: 28 }}
          />
        </div>
        <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} style={{ ...inputStyle, marginTop: 0, width: 170 }}>
          <option value="">All roles</option>
          {roleOptions.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select value={accessFilter} onChange={(e) => setAccessFilter(e.target.value as "" | "full" | "limited")} style={{ ...inputStyle, marginTop: 0, width: 130 }}>
          <option value="">All access</option>
          <option value="full">Full</option>
          <option value="limited">Limited</option>
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as "" | "active" | "inactive")} style={{ ...inputStyle, marginTop: 0, width: 130 }}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </div>

      {formOpen && (
        <Modal
          title="Add user"
          onClose={() => {
            setFormOpen(false);
            setFormError(null);
          }}
          width={520}
        >
          <form onSubmit={handleInvite} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
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
        </Modal>
      )}

      <div className="card" style={{ padding: 0 }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>Manager</th>
              <th>Capacity/day</th>
              <th>Access</th>
              <th title="Flat authorization flags -- not tiered yet. Re-baselining and Closed-project decisions aren't tiered further than this, this is just the designation. Task reopening is now a manager-chain check, not a flag -- see canReopenTask in Projects.tsx.">Approvals</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={8} style={{ color: "var(--muted)" }}>Loading…</td>
              </tr>
            )}
            {!loading && filteredPeople.length === 0 && (
              <tr>
                <td colSpan={8} style={{ color: "var(--muted)" }}>{people.length === 0 ? "No one yet." : "No matches for these filters."}</td>
              </tr>
            )}
            {filteredPeople.map((p) => {
              const manager = people.find((x) => x.id === p.reports_to);
              return (
                <tr
                  key={p.id}
                  className={`user-mgmt-row${selectedPersonId === p.id ? " selected" : ""}`}
                  onClick={() => selectPerson(p)}
                >
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span
                        style={{
                          width: 26,
                          height: 26,
                          borderRadius: "50%",
                          background: p.color || defaultColorFor(p.id),
                          color: "#fff",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 10,
                          fontWeight: 700,
                          flexShrink: 0,
                        }}
                      >
                        {initialsFor(p.name)}
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 600, color: "var(--navy)" }}>{p.name}</div>
                        <div style={{ fontSize: 11, color: "var(--muted)" }}>{p.employee_id ?? "—"}</div>
                      </div>
                    </div>
                  </td>
                  <td>{p.job_title ?? "—"}</td>
                  <td>{manager?.name ?? "—"}</td>
                  <td>{p.daily_capacity_hours}</td>
                  <td>
                    <span className={`status-pill ${p.access_level === "full" ? "success" : "neutral"}`}>
                      {p.access_level === "full" ? "Full" : "Limited"}
                    </span>
                  </td>
                  <td>{approvalSummary(p)}</td>
                  <td>
                    <span className={`status-pill ${p.is_active ? "success" : "neutral"}`}>{p.is_active ? "Active" : "Deactivated"}</span>
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <UserRowMenu
                      person={p}
                      busy={resettingId === p.id || deletingId === p.id}
                      onEdit={() => startEdit(p)}
                      onGiveLogin={() => grantLogin(p)}
                      onResetPassword={() => resetPassword(p)}
                      onToggleActive={() => toggleActive(p)}
                      onDelete={() => deletePerson(p)}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selectedPerson && (
        <UserDrawer
          person={selectedPerson}
          people={people}
          mode={drawerMode}
          onClose={closeDrawer}
          onEnterEdit={() => startEdit(selectedPerson)}
          editName={editName}
          setEditName={setEditName}
          editEmail={editEmail}
          setEditEmail={setEditEmail}
          editReportsTo={editReportsTo}
          setEditReportsTo={setEditReportsTo}
          editCapacity={editCapacity}
          setEditCapacity={setEditCapacity}
          editEmployeeId={editEmployeeId}
          setEditEmployeeId={setEditEmployeeId}
          editJobTitle={editJobTitle}
          setEditJobTitle={setEditJobTitle}
          editSaving={editSaving}
          onCancelEdit={cancelEdit}
          onSaveEdit={() => saveEdit(selectedPerson)}
          onChangeAccessLevel={(level) => changeAccessLevel(selectedPerson, level)}
          onToggleApprovalFlag={(field, value) => toggleApprovalFlag(selectedPerson, field, value)}
          onSaveColor={(hex) => saveColor(selectedPerson, hex)}
        />
      )}

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
      {dialog}
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

const secondaryBtnStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "7px 12px",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--navy)",
  background: "var(--surface)",
  border: "1px solid var(--border)",
};

const primaryBtnStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "7px 12px",
  fontSize: 12,
  fontWeight: 600,
  color: "#fff",
  background: "var(--navy)",
  border: "none",
};
