import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { ChevronLeft, ChevronRight, ChevronDown } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useSession } from "../lib/useSession";
import { PROJECT_PM_DAILY_HOURS } from "../lib/capacityScheduler";

interface PersonRow {
  id: string;
  name: string;
  daily_capacity_hours: number;
  is_active: boolean;
}
interface ProjectRow {
  id: string;
  name: string;
  owner_id: string | null;
  start_date: string | null;
  end_date: string | null;
  is_archived: boolean;
}
interface TaskRow {
  id: string;
  project_id: string;
  name: string;
  assignee_id: string | null;
  start_date: string | null;
  current_due_date: string;
  is_archived: boolean;
}
interface AllocationRow {
  id: string;
  person_id: string;
  item_type: "task" | "project" | "adhoc";
  item_id: string | null;
  date: string;
  hours: number;
}
interface AvailabilityRow {
  id: string;
  person_id: string;
  date: string;
  status: "off" | "half_day";
}
interface HolidayRow {
  id: string;
  date: string;
  name: string;
  category: "legal_ph" | "local" | "internal";
}
// Ownership/assignment history (2026-08-14): a project-owner/task-assignee
// transfer must freeze already-elapsed days under the ORIGINAL person, not
// silently move them to the new one -- same fix as Utilization.tsx, and
// same DB tables (see supabase/policies.sql "Migration 2026-08-14b").
interface OwnerHistoryRow {
  project_id: string;
  person_id: string;
  effective_from: string;
  effective_to: string | null;
}
interface AssigneeHistoryRow {
  task_id: string;
  person_id: string;
  effective_from: string;
  effective_to: string | null;
}
// Deletion history archive (2026-08-14c): when a task/project is
// permanently deleted, its already-elapsed Day-Planner hours are archived
// (supabase/policies.sql "Migration 2026-08-14c") as raw per-person-per-day
// numbers before the row disappears -- deliberately no task/project name
// retained ("just the numbers", Sandra's explicit choice for this scope).
// Same table Utilization.tsx reads for its own points-flavored version.
interface DeletedHourRow {
  person_id: string;
  date: string;
  hours: number;
}

type SubItem = { type: "adhoc" | "project" | "task"; id: string | null; label: string; project?: string; start: string | null; end: string | null };

// Local-timezone date formatting/math throughout — avoids the classic
// `new Date("YYYY-MM-DD")` UTC-midnight parsing shift (see timingOf() in
// Projects.tsx for the same fix applied to due-date logic).
function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function startOfWeek(d: Date): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = r.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(r, diff);
}
const WEEKDAY_LABEL = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const RANGE_OPTIONS = [1, 2, 4] as const;
// A project owner's own "project" row (as opposed to a specific task row)
// defaults to a small recurring project-management/coordination allowance
// rather than sitting blank — still edited like any other cell, just
// capped low so it stays overhead time, not a place to log real project work.
// Phase 2 (2026-08-20): the default itself now comes from
// capacityScheduler.ts's PROJECT_PM_DAILY_HOURS, unifying this with
// Utilization.tsx's own PM-overhead allowance (they used to be two
// separately-tuned mechanisms -- see that file's pmHoursFor doc comment).
// PROJECT_PM_MAX_HOURS stays Day-Planner-specific: it's a manual-entry cap
// on this one cell, unrelated to the unification.
const PROJECT_PM_MAX_HOURS = 2;
const CELL_W = 58;
const LABEL_W = 275;

// Phase 2 (2026-08-20): thresholds moved to align with Utilization.tsx's
// new 6-tier bands (utilizationBands.ts) -- danger now starts where that
// page's "Overloaded" tier starts (>100%), and warning now starts where
// its "High" tier starts (>=81%), so Day Planner's simplified 3-tone view
// stays conceptually consistent with the richer grid. Day Planner
// intentionally keeps its own 3-tone logic rather than importing the new
// tierOf -- it only ever needs success/warning/danger for its own styling.
function utilTone(pct: number): "success" | "warning" | "danger" {
  if (pct > 100) return "danger";
  if (pct >= 81) return "warning";
  return "success";
}

function rollupCellStyle(i: number): CSSProperties {
  return {
    width: CELL_W,
    minWidth: CELL_W,
    textAlign: "center",
    padding: "9px 3px",
    borderBottom: "1px solid var(--border)",
    borderLeft: i % 7 === 0 ? "1px solid var(--border)" : undefined,
  };
}
function subCellStyle(i: number): CSSProperties {
  return {
    width: CELL_W,
    minWidth: CELL_W,
    padding: 0,
    borderBottom: "1px solid var(--border)",
    borderLeft: i % 7 === 0 ? "1px solid var(--border)" : undefined,
  };
}

// Small anchored popover (reuses the same visual language as ViewTabs'
// "..." dropdown) for the one self-service action every person gets on
// their own row: tag a day Off or Half day, or clear a previous tag.
function DayMenu({ onPick, onClose }: { onPick: (s: "off" | "half_day" | null) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [onClose]);
  return (
    <div ref={ref} className="view-tab-dropdown" style={{ position: "static", width: 118, textAlign: "left" }} onClick={(e) => e.stopPropagation()}>
      <button onClick={() => onPick("off")}>Mark Off</button>
      <button onClick={() => onPick("half_day")}>Mark Half day</button>
      <button onClick={() => onPick(null)}>Clear</button>
    </div>
  );
}

// Daily time-planning grid: decoupled from a task's estimated/spent hours —
// this is purely "when does the work happen", entered day by day. Everyone
// sees the whole team's grid (transparency); each person can only enter
// hours or mark days off on their own row (self-service, no approval).
export default function DayPlanner() {
  const { person: me } = useSession();
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [allocations, setAllocations] = useState<AllocationRow[]>([]);
  const [availability, setAvailability] = useState<AvailabilityRow[]>([]);
  const [holidays, setHolidays] = useState<HolidayRow[]>([]);
  const [ownerHistory, setOwnerHistory] = useState<OwnerHistoryRow[]>([]);
  const [assigneeHistory, setAssigneeHistory] = useState<AssigneeHistoryRow[]>([]);
  const [deletedHours, setDeletedHours] = useState<DeletedHourRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [weekOffset, setWeekOffset] = useState(0);
  const [rangeWeeks, setRangeWeeks] = useState<(typeof RANGE_OPTIONS)[number]>(2);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [offMenu, setOffMenu] = useState<{ personId: string; date: string; x: number; y: number } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  async function loadAll() {
    setLoading(true);
    const [{ data: p }, { data: pr }, { data: tk }, { data: al }, { data: av }, { data: hol }, { data: ownHist }, { data: assHist }, { data: delHrs }, { data: settings }] = await Promise.all([
      supabase.from("people").select("id,name,daily_capacity_hours,is_active").eq("is_active", true).order("name"),
      supabase.from("projects").select("id,name,owner_id,start_date,end_date,is_archived").eq("is_archived", false),
      supabase.from("tasks").select("id,project_id,name,assignee_id,start_date,current_due_date,is_archived").eq("is_archived", false),
      supabase.from("time_allocations").select("*"),
      supabase.from("person_availability").select("*"),
      supabase.from("holidays").select("*"),
      supabase.from("project_owner_history").select("project_id,person_id,effective_from,effective_to"),
      supabase.from("task_assignee_history").select("task_id,person_id,effective_from,effective_to"),
      supabase.from("deleted_person_day_hours").select("person_id,date,hours"),
      supabase.from("app_settings").select("historical_locking_enabled").eq("id", true).single(),
    ]);
    setPeople((p as PersonRow[]) ?? []);
    setProjects((pr as ProjectRow[]) ?? []);
    setTasks((tk as TaskRow[]) ?? []);
    setAllocations((al as AllocationRow[]) ?? []);
    setAvailability((av as AvailabilityRow[]) ?? []);
    setHolidays((hol as HolidayRow[]) ?? []);
    // Sandra, 2026-08-14: same global off switch as Utilization.tsx -- see
    // that file's loadAll for the full explanation.
    const historicalLockingEnabled = (settings as { historical_locking_enabled?: boolean } | null)?.historical_locking_enabled ?? false;
    setOwnerHistory(historicalLockingEnabled ? (ownHist as OwnerHistoryRow[]) ?? [] : []);
    setAssigneeHistory(historicalLockingEnabled ? (assHist as AssigneeHistoryRow[]) ?? [] : []);
    setDeletedHours((delHrs as DeletedHourRow[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    loadAll();
  }, []);

  const days = useMemo(() => {
    const base = addDays(startOfWeek(new Date()), weekOffset * 7);
    return Array.from({ length: rangeWeeks * 7 }, (_, i) => addDays(base, i));
  }, [weekOffset, rangeWeeks]);

  // Jump directly to the week containing a chosen date, instead of only
  // stepping week by week.
  function jumpToDate(dateStr: string) {
    if (!dateStr) return;
    const [y, m, d] = dateStr.split("-").map(Number);
    const chosenMonday = startOfWeek(new Date(y, (m ?? 1) - 1, d ?? 1));
    const todayMonday = startOfWeek(new Date());
    const diffWeeks = Math.round((chosenMonday.getTime() - todayMonday.getTime()) / (7 * 24 * 60 * 60 * 1000));
    setWeekOffset(diffWeeks);
  }
  const weeks: Date[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));

  const holidayByDate = useMemo(() => {
    const m = new Map<string, HolidayRow>();
    holidays.forEach((h) => m.set(h.date, h));
    return m;
  }, [holidays]);

  function availabilityFor(personId: string, dateStr: string): AvailabilityRow | undefined {
    return availability.find((a) => a.person_id === personId && a.date === dateStr);
  }

  // "Ever associated" -- 2026-08-14: a person's expandable row lists every
  // project/task their history shows they EVER owned/were assigned, not
  // just whoever currently holds it. Otherwise a transfer would silently
  // drop a manually-logged hour allocation for the OLD person (it still
  // exists in time_allocations, but with no matching sub-item to attach it
  // to, personTotalFor would simply never sum it -- the exact "sticks then
  // disappears" bug Sandra flagged). The PM-overhead default hours (below,
  // in personTotalFor) are separately gated to only apply on days history
  // says this person actually held ownership.
  function ownerMatchesOnDate(p: ProjectRow, personId: string, dateStr: string): boolean {
    const rows = ownerHistory.filter((h) => h.project_id === p.id);
    if (rows.length === 0) return p.owner_id === personId;
    return rows.some((h) => h.person_id === personId && h.effective_from <= dateStr && (h.effective_to === null || h.effective_to >= dateStr));
  }

  // Deletion archive: folds archived hours from permanently-deleted
  // tasks/projects into a person's daily total, and flags whether they
  // have any at all (to show the generic "Deleted items" sub-row below --
  // generic because no task/project name was retained for these).
  function deletedHoursFor(personId: string, dateStr: string): number {
    return deletedHours.filter((d) => d.person_id === personId && d.date === dateStr).reduce((sum, d) => sum + Number(d.hours), 0);
  }
  function hasDeletedHistory(personId: string): boolean {
    return deletedHours.some((d) => d.person_id === personId);
  }

  function subItemsFor(personId: string): SubItem[] {
    const items: SubItem[] = [{ type: "adhoc", id: null, label: "Adhoc", start: null, end: null }];
    projects
      .filter((p) => p.owner_id === personId || ownerHistory.some((h) => h.project_id === p.id && h.person_id === personId))
      .forEach((p) => items.push({ type: "project", id: p.id, label: p.name, start: p.start_date, end: p.end_date }));
    tasks
      .filter((t) => t.assignee_id === personId || assigneeHistory.some((h) => h.task_id === t.id && h.person_id === personId))
      .forEach((t) => {
        const proj = projects.find((p) => p.id === t.project_id);
        items.push({ type: "task", id: t.id, label: t.name, project: proj?.name, start: t.start_date, end: t.current_due_date });
      });
    return items;
  }

  function inWindow(item: SubItem, dateStr: string): boolean {
    if (item.type === "adhoc") return true;
    if (!item.start || !item.end) return false;
    return dateStr >= item.start && dateStr <= item.end;
  }

  function dayBlocked(personId: string, dateStr: string, dow: number): "holiday" | "off" | "weekend" | null {
    if (dow === 0 || dow === 6) return "weekend";
    if (holidayByDate.has(dateStr)) return "holiday";
    if (availabilityFor(personId, dateStr)?.status === "off") return "off";
    return null;
  }

  function allocFor(personId: string, itemType: string, itemId: string | null, dateStr: string): AllocationRow | undefined {
    return allocations.find((a) => a.person_id === personId && a.item_type === itemType && (itemId ? a.item_id === itemId : !a.item_id) && a.date === dateStr);
  }

  function personTotalFor(personId: string, dateStr: string): number {
    const subtotal = subItemsFor(personId).reduce((sum, item) => {
      const alloc = allocFor(personId, item.type, item.id, dateStr);
      if (alloc) return sum + Number(alloc.hours);
      if (item.type === "project" && inWindow(item, dateStr)) {
        const proj = projects.find((p) => p.id === item.id);
        if (proj && ownerMatchesOnDate(proj, personId, dateStr)) return sum + PROJECT_PM_DAILY_HOURS;
      }
      return sum;
    }, 0);
    return subtotal + deletedHoursFor(personId, dateStr);
  }

  async function commitHours(personId: string, itemType: SubItem["type"], itemId: string | null, dateStr: string, raw: string) {
    const hours = parseFloat(raw);
    const existing = allocFor(personId, itemType, itemId, dateStr);
    if (!raw.trim() || isNaN(hours)) {
      if (existing) {
        setAllocations((prev) => prev.filter((a) => a.id !== existing.id));
        const { error } = await supabase.from("time_allocations").delete().eq("id", existing.id);
        if (error) {
          window.alert(`Couldn't clear hours: ${error.message}`);
          loadAll();
        }
      }
      return;
    }
    if (hours < 0) {
      window.alert("Hours can't be negative.");
      return;
    }
    if (itemType === "project" && hours > PROJECT_PM_MAX_HOURS) {
      window.alert(`Project management time is capped at ${PROJECT_PM_MAX_HOURS} hours/day — log real project work under its tasks instead.`);
      return;
    }
    if (existing) {
      setAllocations((prev) => prev.map((a) => (a.id === existing.id ? { ...a, hours } : a)));
      const { error } = await supabase.from("time_allocations").update({ hours }).eq("id", existing.id);
      if (error) {
        window.alert(`Couldn't save hours: ${error.message}`);
        loadAll();
      }
    } else {
      const { data, error } = await supabase
        .from("time_allocations")
        .insert({ person_id: personId, item_type: itemType, item_id: itemId, date: dateStr, hours })
        .select()
        .single();
      if (!error && data) setAllocations((prev) => [...prev, data as AllocationRow]);
      if (error) window.alert(`Couldn't save hours: ${error.message}`);
    }
  }

  async function setDayStatus(personId: string, dateStr: string, status: "off" | "half_day" | null) {
    const existing = availabilityFor(personId, dateStr);
    if (!status) {
      if (existing) {
        setAvailability((prev) => prev.filter((a) => a.id !== existing.id));
        const { error } = await supabase.from("person_availability").delete().eq("id", existing.id);
        if (error) {
          window.alert(`Couldn't clear status: ${error.message}`);
          loadAll();
        }
      }
    } else if (existing) {
      setAvailability((prev) => prev.map((a) => (a.id === existing.id ? { ...a, status } : a)));
      const { error } = await supabase.from("person_availability").update({ status }).eq("id", existing.id);
      if (error) {
        window.alert(`Couldn't save status: ${error.message}`);
        loadAll();
      }
    } else {
      const { data, error } = await supabase.from("person_availability").insert({ person_id: personId, date: dateStr, status }).select().single();
      if (!error && data) setAvailability((prev) => [...prev, data as AvailabilityRow]);
      if (error) window.alert(`Couldn't save: ${error.message}`);
    }
    setOffMenu(null);
  }

  // Opens the Off/Half-day popover anchored to the clicked cell's own
  // screen coordinates (position: fixed), rather than absolutely inside
  // the cell — the card's horizontally-scrollable container computes
  // overflow-y to "auto" as soon as overflow-x is "auto" (per the CSS
  // overflow spec), which still clips an absolutely-positioned popover
  // even when overflow-y is explicitly set to "visible". Fixed positioning
  // escapes that entirely since there is no transformed ancestor here.
  function openOffMenu(e: ReactMouseEvent, personId: string, dateStr: string) {
    if (offMenu && offMenu.personId === personId && offMenu.date === dateStr) {
      setOffMenu(null);
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setOffMenu({ personId, date: dateStr, x: rect.left + rect.width / 2, y: rect.bottom + 2 });
  }

  return (
    <div>
      <h1>Day Planner</h1>
      <p className="subtitle">
        Plan daily time across projects, tasks, and ad hoc work — separate from a task's estimated/spent hours. Everyone can see the team's plan; you can only
        enter hours or mark days off on your own row.
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        <button onClick={() => setWeekOffset((w) => w - rangeWeeks)} className="planner-nav-btn" title={`Previous ${rangeWeeks} week${rangeWeeks > 1 ? "s" : ""}`}>
          <ChevronLeft size={14} />
        </button>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--navy)", minWidth: 150 }}>
          {days[0].toLocaleDateString("en-US", { month: "short", day: "numeric" })} –{" "}
          {days[days.length - 1].toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
        </span>
        <button onClick={() => setWeekOffset((w) => w + rangeWeeks)} className="planner-nav-btn" title={`Next ${rangeWeeks} week${rangeWeeks > 1 ? "s" : ""}`}>
          <ChevronRight size={14} />
        </button>
        {weekOffset !== 0 && (
          <button
            onClick={() => setWeekOffset(0)}
            style={{ fontSize: 11, color: "var(--accent)", background: "none", border: "none", cursor: "pointer", fontWeight: 600 }}
          >
            Today
          </button>
        )}

        <div style={{ width: 1, height: 18, background: "var(--border)" }} />

        <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--muted)" }}>
          Show
          <select
            value={rangeWeeks}
            onChange={(e) => setRangeWeeks(Number(e.target.value) as (typeof RANGE_OPTIONS)[number])}
            style={{ fontSize: 11, fontWeight: 600, color: "var(--navy)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "3px 6px" }}
          >
            {RANGE_OPTIONS.map((w) => (
              <option key={w} value={w}>
                {w} week{w > 1 ? "s" : ""}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--muted)" }}>
          Jump to
          <input
            type="date"
            onChange={(e) => jumpToDate(e.target.value)}
            style={{ fontSize: 11, color: "var(--navy)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "3px 6px" }}
          />
        </label>
      </div>

      <div className="card" style={{ padding: 0, overflowX: "auto", overflowY: "visible" }}>
        {loading ? (
          <div style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>Loading…</div>
        ) : (
          <table style={{ borderCollapse: "collapse", width: "max-content" }}>
            <thead>
              <tr>
                <th
                  style={{
                    position: "sticky",
                    left: 0,
                    zIndex: 2,
                    background: "var(--surface)",
                    width: LABEL_W,
                    minWidth: LABEL_W,
                    borderBottom: "1px solid var(--border)",
                  }}
                />
                {weeks.map((week, wi) => (
                  <th
                    key={wi}
                    colSpan={7}
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: "var(--muted)",
                      textTransform: "uppercase",
                      letterSpacing: 0.3,
                      padding: "8px 5px",
                      borderBottom: "1px solid var(--border)",
                      borderLeft: "1px solid var(--border)",
                    }}
                  >
                    Week of {week[0].toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </th>
                ))}
              </tr>
              <tr>
                <th
                  style={{
                    position: "sticky",
                    left: 0,
                    zIndex: 2,
                    background: "var(--surface)",
                    width: LABEL_W,
                    minWidth: LABEL_W,
                    borderBottom: "1px solid var(--border)",
                    textAlign: "left",
                    padding: "5px 13px",
                    fontSize: 13,
                    color: "var(--muted)",
                  }}
                >
                  Person
                </th>
                {days.map((d, i) => {
                  const dow = d.getDay();
                  const weekend = dow === 0 || dow === 6;
                  return (
                    <th
                      key={i}
                      style={{
                        width: CELL_W,
                        minWidth: CELL_W,
                        padding: "5px 3px",
                        fontSize: 12,
                        fontWeight: 600,
                        color: weekend ? "var(--muted)" : "var(--navy)",
                        background: weekend ? "var(--hover-bg)" : undefined,
                        borderBottom: "1px solid var(--border)",
                        borderLeft: i % 7 === 0 ? "1px solid var(--border)" : undefined,
                      }}
                    >
                      {WEEKDAY_LABEL[dow]} {d.getDate()}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {people.length === 0 ? (
                <tr>
                  <td colSpan={1 + days.length} style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>
                    No active people found.
                  </td>
                </tr>
              ) : (
                people.map((person) => {
                  const isMe = me?.id === person.id;
                  const isExpanded = expanded.includes(person.id);
                  const items = subItemsFor(person.id);
                  return (
                    <Fragment key={person.id}>
                      <tr style={{ background: "#fafbfc" }}>
                        <td
                          style={{
                            position: "sticky",
                            left: 0,
                            zIndex: 1,
                            background: "#fafbfc",
                            padding: "8px 13px",
                            fontSize: 12,
                            fontWeight: 600,
                            color: "var(--navy)",
                            borderBottom: "1px solid var(--border)",
                            cursor: "pointer",
                            whiteSpace: "nowrap",
                          }}
                          onClick={() => setExpanded((prev) => (isExpanded ? prev.filter((id) => id !== person.id) : [...prev, person.id]))}
                        >
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                            {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                            {person.name}
                          </span>
                        </td>
                        {days.map((d, i) => {
                          const dateStr = toISO(d);
                          const dow = d.getDay();
                          const blocked = dayBlocked(person.id, dateStr, dow);

                          if (blocked === "holiday") {
                            const h = holidayByDate.get(dateStr)!;
                            return (
                              <td key={i} title={h.name} style={{ ...rollupCellStyle(i), background: "#eef1f5", color: "var(--muted)", fontSize: 11, fontWeight: 600 }}>
                                Holiday
                              </td>
                            );
                          }
                          if (blocked === "weekend") {
                            return <td key={i} style={{ ...rollupCellStyle(i), background: "var(--hover-bg)" }} />;
                          }
                          const av = availabilityFor(person.id, dateStr);
                          if (blocked === "off") {
                            return (
                              <td
                                key={i}
                                style={{
                                  ...rollupCellStyle(i),
                                  background: "#f1f2f4",
                                  color: "var(--muted)",
                                  fontSize: 12,
                                  fontWeight: 600,
                                  cursor: isMe ? "pointer" : undefined,
                                }}
                                onClick={(e) => isMe && openOffMenu(e, person.id, dateStr)}
                              >
                                Off
                              </td>
                            );
                          }
                          const total = personTotalFor(person.id, dateStr);
                          const capacity = av?.status === "half_day" ? person.daily_capacity_hours / 2 : person.daily_capacity_hours;
                          const pct = capacity > 0 ? (total / capacity) * 100 : 0;
                          const tone = utilTone(pct);
                          const bg = total === 0 ? undefined : tone === "danger" ? "var(--danger-bg)" : tone === "warning" ? "var(--warning-bg)" : "var(--success-bg)";
                          const fg = tone === "danger" ? "var(--danger-text)" : tone === "warning" ? "var(--warning-text)" : "var(--success-text)";
                          return (
                            <td
                              key={i}
                              style={{
                                ...rollupCellStyle(i),
                                background: bg,
                                color: total > 0 ? fg : "var(--muted)",
                                fontSize: 12.5,
                                fontWeight: 600,
                                cursor: isMe ? "pointer" : undefined,
                              }}
                              onClick={(e) => isMe && openOffMenu(e, person.id, dateStr)}
                              title={av?.status === "half_day" ? "Half day" : undefined}
                            >
                              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                                <span>
                                  {total > 0 ? `${Math.round(pct)}%` : "–"}
                                  {av?.status === "half_day" && <span style={{ fontSize: 9, marginLeft: 2 }}>½</span>}
                                </span>
                                <span style={{ fontSize: 9, fontWeight: 500, opacity: 0.75, visibility: total > 0 ? "visible" : "hidden" }}>
                                  {total > 0 ? `${total.toFixed(1)}h` : "0.0h"}
                                </span>
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                      {isExpanded &&
                        items.map((item) => (
                          <tr key={`${person.id}-${item.type}-${item.id ?? "adhoc"}`}>
                            <td
                              title={item.project ? `${item.label} — ${item.project}` : item.label}
                              style={{
                                position: "sticky",
                                left: 0,
                                zIndex: 1,
                                background: "var(--surface)",
                                padding: "5px 13px 5px 35px",
                                fontSize: 11,
                                color: "var(--text-secondary)",
                                borderBottom: "1px solid var(--border)",
                                whiteSpace: "nowrap",
                                maxWidth: LABEL_W,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                              }}
                            >
                              {item.label}
                              {item.project && (
                                <span style={{ fontSize: 9.5, fontWeight: 600, color: "var(--muted)", marginLeft: 6 }}>{item.project}</span>
                              )}
                            </td>
                            {days.map((d, i) => {
                              const dateStr = toISO(d);
                              const dow = d.getDay();
                              const blocked = dayBlocked(person.id, dateStr, dow);
                              const win = inWindow(item, dateStr);
                              const alloc = allocFor(person.id, item.type, item.id, dateStr);
                              const draftKey = `${person.id}|${item.type}|${item.id ?? "adhoc"}|${dateStr}`;
                              const itemProject = item.type === "project" ? projects.find((p) => p.id === item.id) : undefined;
                              const defaultValue =
                                item.type === "project" && itemProject && ownerMatchesOnDate(itemProject, person.id, dateStr)
                                  ? String(PROJECT_PM_DAILY_HOURS)
                                  : "";
                              const value = drafts[draftKey] ?? (alloc ? String(alloc.hours) : defaultValue);
                              const openForEntry = !blocked && win;
                              return (
                                <td key={i} style={{ ...subCellStyle(i), background: blocked ? "var(--hover-bg)" : !win ? "#f7f8fa" : undefined }}>
                                  {openForEntry ? (
                                    <input
                                      value={value}
                                      disabled={!isMe}
                                      placeholder={isMe ? "–" : ""}
                                      title={item.type === "project" ? `Defaults to ${PROJECT_PM_DAILY_HOURS}h project management time — editable, capped at ${PROJECT_PM_MAX_HOURS}h/day` : undefined}
                                      onChange={(e) => setDrafts((prev) => ({ ...prev, [draftKey]: e.target.value }))}
                                      onFocus={(e) => e.target.select()}
                                      onBlur={(e) => {
                                        commitHours(person.id, item.type, item.id, dateStr, e.target.value);
                                        setDrafts((prev) => {
                                          const next = { ...prev };
                                          delete next[draftKey];
                                          return next;
                                        });
                                      }}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                      }}
                                      style={{
                                        width: "100%",
                                        border: "none",
                                        background: "transparent",
                                        textAlign: "center",
                                        fontSize: 11,
                                        padding: "5px 3px",
                                        color: alloc ? "var(--navy)" : "var(--muted)",
                                        cursor: isMe ? "text" : "default",
                                      }}
                                    />
                                  ) : null}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      {isExpanded && hasDeletedHistory(person.id) && (
                        <tr>
                          <td
                            title="Hours from tasks/projects that have since been permanently deleted — numbers only, no name retained"
                            style={{
                              position: "sticky",
                              left: 0,
                              zIndex: 1,
                              background: "var(--surface)",
                              padding: "5px 13px 5px 35px",
                              fontSize: 11,
                              color: "var(--muted)",
                              fontStyle: "italic",
                              borderBottom: "1px solid var(--border)",
                              whiteSpace: "nowrap",
                              maxWidth: LABEL_W,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            Deleted items
                          </td>
                          {days.map((d, i) => {
                            const dateStr = toISO(d);
                            const dow = d.getDay();
                            const blocked = dayBlocked(person.id, dateStr, dow);
                            const win = !blocked;
                            const value = deletedHoursFor(person.id, dateStr);
                            return (
                              <td key={i} style={{ ...subCellStyle(i), background: blocked ? "var(--hover-bg)" : !win ? "#f7f8fa" : undefined }}>
                                {value > 0 ? (
                                  <span style={{ display: "block", textAlign: "center", fontSize: 11, padding: "5px 3px", color: "var(--muted)" }}>{value.toFixed(1)}</span>
                                ) : null}
                              </td>
                            );
                          })}
                        </tr>
                      )}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        )}
      </div>

      {offMenu && (
        <div style={{ position: "fixed", left: offMenu.x, top: offMenu.y, transform: "translateX(-50%)", zIndex: 50 }}>
          <DayMenu onPick={(s) => setDayStatus(offMenu.personId, offMenu.date, s)} onClose={() => setOffMenu(null)} />
        </div>
      )}
    </div>
  );
}
