import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { ChevronLeft, ChevronRight, ChevronDown } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useSession } from "../lib/useSession";

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
const CELL_W = 46;
const LABEL_W = 220;

function utilTone(pct: number): "success" | "warning" | "danger" {
  if (pct > 110) return "danger";
  if (pct >= 80) return "warning";
  return "success";
}

function rollupCellStyle(i: number): CSSProperties {
  return {
    width: CELL_W,
    minWidth: CELL_W,
    textAlign: "center",
    padding: "6px 2px",
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
  const [loading, setLoading] = useState(true);

  const [weekOffset, setWeekOffset] = useState(0);
  const [rangeWeeks, setRangeWeeks] = useState<(typeof RANGE_OPTIONS)[number]>(2);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [offMenu, setOffMenu] = useState<{ personId: string; date: string; x: number; y: number } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  async function loadAll() {
    setLoading(true);
    const [{ data: p }, { data: pr }, { data: tk }, { data: al }, { data: av }, { data: hol }] = await Promise.all([
      supabase.from("people").select("id,name,daily_capacity_hours,is_active").eq("is_active", true).order("name"),
      supabase.from("projects").select("id,name,owner_id,start_date,end_date,is_archived").eq("is_archived", false),
      supabase.from("tasks").select("id,project_id,name,assignee_id,start_date,current_due_date,is_archived").eq("is_archived", false),
      supabase.from("time_allocations").select("*"),
      supabase.from("person_availability").select("*"),
      supabase.from("holidays").select("*"),
    ]);
    setPeople((p as PersonRow[]) ?? []);
    setProjects((pr as ProjectRow[]) ?? []);
    setTasks((tk as TaskRow[]) ?? []);
    setAllocations((al as AllocationRow[]) ?? []);
    setAvailability((av as AvailabilityRow[]) ?? []);
    setHolidays((hol as HolidayRow[]) ?? []);
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

  function subItemsFor(personId: string): SubItem[] {
    const items: SubItem[] = [{ type: "adhoc", id: null, label: "Adhoc", start: null, end: null }];
    projects.filter((p) => p.owner_id === personId).forEach((p) => items.push({ type: "project", id: p.id, label: p.name, start: p.start_date, end: p.end_date }));
    tasks
      .filter((t) => t.assignee_id === personId)
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
    return allocations.filter((a) => a.person_id === personId && a.date === dateStr).reduce((sum, a) => sum + Number(a.hours), 0);
  }

  async function commitHours(personId: string, itemType: SubItem["type"], itemId: string | null, dateStr: string, raw: string) {
    const hours = parseFloat(raw);
    const existing = allocFor(personId, itemType, itemId, dateStr);
    if (!raw.trim() || isNaN(hours) || hours <= 0) {
      if (existing) {
        setAllocations((prev) => prev.filter((a) => a.id !== existing.id));
        await supabase.from("time_allocations").delete().eq("id", existing.id);
      }
      return;
    }
    if (existing) {
      setAllocations((prev) => prev.map((a) => (a.id === existing.id ? { ...a, hours } : a)));
      await supabase.from("time_allocations").update({ hours }).eq("id", existing.id);
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
        await supabase.from("person_availability").delete().eq("id", existing.id);
      }
    } else if (existing) {
      setAvailability((prev) => prev.map((a) => (a.id === existing.id ? { ...a, status } : a)));
      await supabase.from("person_availability").update({ status }).eq("id", existing.id);
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
                      fontSize: 10,
                      fontWeight: 600,
                      color: "var(--muted)",
                      textTransform: "uppercase",
                      letterSpacing: 0.3,
                      padding: "6px 4px",
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
                    padding: "4px 10px",
                    fontSize: 11,
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
                        padding: "4px 2px",
                        fontSize: 10,
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
                            padding: "6px 10px",
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
                              <td key={i} title={h.name} style={{ ...rollupCellStyle(i), background: "#eef1f5", color: "var(--muted)", fontSize: 9, fontWeight: 600 }}>
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
                                  fontSize: 9.5,
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
                                fontSize: 10,
                                fontWeight: 600,
                                cursor: isMe ? "pointer" : undefined,
                              }}
                              onClick={(e) => isMe && openOffMenu(e, person.id, dateStr)}
                              title={av?.status === "half_day" ? "Half day" : undefined}
                            >
                              {total > 0 ? `${Math.round(pct)}%` : "–"}
                              {av?.status === "half_day" && <span style={{ fontSize: 8, marginLeft: 2 }}>½</span>}
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
                                padding: "4px 10px 4px 28px",
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
                              const value = drafts[draftKey] ?? (alloc ? String(alloc.hours) : "");
                              const openForEntry = !blocked && win;
                              return (
                                <td key={i} style={{ ...subCellStyle(i), background: blocked ? "var(--hover-bg)" : !win ? "#f7f8fa" : undefined }}>
                                  {openForEntry ? (
                                    <input
                                      value={value}
                                      disabled={!isMe}
                                      placeholder={isMe ? "–" : ""}
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
                                        padding: "6px 2px",
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
