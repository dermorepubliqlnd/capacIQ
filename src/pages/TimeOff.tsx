import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useSession } from "../lib/useSession";

// Time Off (2026-08-25) -- split out of the old Work Schedule "Scheduled"
// tab when that manual hour-splitting grid was removed (Sandra: "I don't
// see the point of having them plot their own hours since they already
// have time tracking"). The one thing that grid still did that nothing
// else covers is let a person flag themselves Off or Half-day -- and that
// same person_availability data already feeds both the WBS capacity
// scheduler (capacityScheduler.ts) and Utilization's daily-capacity math,
// so it needs a home that survives the Scheduled tab's removal. This page
// is that home: same person x day grid shape as Work Schedule, but the
// only interaction is marking your own row's days Off/Half-day/Clear --
// everyone can see the whole team's time off (same transparency
// philosophy as Work Schedule always had), only your own row is editable.

interface PersonRow {
  id: string;
  name: string;
  is_active: boolean;
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

function toISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
const WEEKDAY_LABEL = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const RANGE_OPTIONS = [1, 2, 4] as const;
const CELL_W = 58;
const LABEL_W = 220;

// Same anchored popover pattern DayPlanner used to use for this same
// action -- moved here verbatim.
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

export default function TimeOff() {
  const { person: me } = useSession();
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [availability, setAvailability] = useState<AvailabilityRow[]>([]);
  const [holidays, setHolidays] = useState<HolidayRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [weekOffset, setWeekOffset] = useState(0);
  const [rangeWeeks, setRangeWeeks] = useState<(typeof RANGE_OPTIONS)[number]>(4);
  const [dayMenu, setDayMenu] = useState<{ personId: string; date: string; x: number; y: number } | null>(null);

  async function loadAll() {
    setLoading(true);
    const [{ data: p }, { data: av }, { data: hol }] = await Promise.all([
      supabase.from("people").select("id,name,is_active").eq("is_active", true).order("name"),
      supabase.from("person_availability").select("*"),
      supabase.from("holidays").select("*"),
    ]);
    setPeople((p as PersonRow[]) ?? []);
    setAvailability((av as AvailabilityRow[]) ?? []);
    setHolidays((hol as HolidayRow[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    loadAll();
  }, []);

  const EARLIEST_ANCHOR = useMemo(() => new Date(2026, 0, 1), []);
  const todayRaw = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);
  const minWeekOffset = useMemo(
    () => Math.ceil((EARLIEST_ANCHOR.getTime() - todayRaw.getTime()) / (7 * 24 * 60 * 60 * 1000)),
    [EARLIEST_ANCHOR, todayRaw]
  );
  function clampWeekOffset(next: number): number {
    return Math.max(next, minWeekOffset);
  }
  const days = useMemo(() => {
    const base = addDays(todayRaw, weekOffset * 7);
    return Array.from({ length: rangeWeeks * 7 }, (_, i) => addDays(base, i));
  }, [weekOffset, rangeWeeks, todayRaw]);
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
    setDayMenu(null);
  }

  // Fixed positioning, anchored to the clicked cell's own screen
  // coordinates -- same escape-the-scroll-container fix DayPlanner used
  // (overflow-x:auto silently forces overflow-y:auto per the CSS spec,
  // which still clips an absolutely-positioned popover).
  function openDayMenu(e: ReactMouseEvent, personId: string, dateStr: string) {
    if (dayMenu && dayMenu.personId === personId && dayMenu.date === dateStr) {
      setDayMenu(null);
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDayMenu({ personId, date: dateStr, x: rect.left + rect.width / 2, y: rect.bottom + 2 });
  }

  if (loading) return <p style={{ padding: 20, color: "var(--muted)" }}>Loading…</p>;

  return (
    <div>
      <h1>Time Off</h1>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        <button
          onClick={() => setWeekOffset((w) => clampWeekOffset(w - rangeWeeks))}
          className="planner-nav-btn"
          disabled={weekOffset <= minWeekOffset}
          title={weekOffset <= minWeekOffset ? "Can't go earlier than Jan 2026" : `Previous ${rangeWeeks} week${rangeWeeks > 1 ? "s" : ""}`}
          style={weekOffset <= minWeekOffset ? { opacity: 0.4, cursor: "default" } : undefined}
        >
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
        <select
          value={rangeWeeks}
          onChange={(e) => setRangeWeeks(Number(e.target.value) as (typeof RANGE_OPTIONS)[number])}
          style={{ fontSize: 12, padding: "4px 6px" }}
        >
          {RANGE_OPTIONS.map((w) => (
            <option key={w} value={w}>
              {w} week{w > 1 ? "s" : ""}
            </option>
          ))}
        </select>
      </div>

      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "max-content" }}>
          <thead>
            <tr>
              <th style={{ position: "sticky", left: 0, zIndex: 2, background: "var(--surface)", width: LABEL_W, minWidth: LABEL_W, borderBottom: "1px solid var(--border)" }} />
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
                Team Member
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
                return (
                  <tr key={person.id}>
                    <td
                      style={{
                        position: "sticky",
                        left: 0,
                        zIndex: 1,
                        background: "var(--surface)",
                        padding: "8px 13px",
                        fontSize: 12,
                        fontWeight: 600,
                        color: "var(--navy)",
                        borderBottom: "1px solid var(--border)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {person.name}
                    </td>
                    {days.map((d, i) => {
                      const dateStr = toISO(d);
                      const dow = d.getDay();
                      const weekend = dow === 0 || dow === 6;
                      const holiday = holidayByDate.get(dateStr);
                      const av = availabilityFor(person.id, dateStr);
                      const clickable = isMe && !holiday && !weekend;
                      let label: string | null = null;
                      let bg: string | undefined;
                      let fg = "var(--muted)";
                      if (holiday) {
                        label = "Holiday";
                        bg = "#eef1f5";
                      } else if (av?.status === "off") {
                        label = "Off";
                        bg = "var(--danger-bg)";
                        fg = "var(--danger-text)";
                      } else if (av?.status === "half_day") {
                        label = "½ day";
                        bg = "var(--warning-bg)";
                        fg = "var(--warning-text)";
                      } else if (weekend) {
                        bg = "var(--hover-bg)";
                      }
                      return (
                        <td
                          key={i}
                          title={holiday ? holiday.name : undefined}
                          onClick={(e) => clickable && openDayMenu(e, person.id, dateStr)}
                          style={{
                            width: CELL_W,
                            minWidth: CELL_W,
                            textAlign: "center",
                            padding: "9px 3px",
                            fontSize: 11,
                            fontWeight: 600,
                            background: bg,
                            color: fg,
                            borderBottom: "1px solid var(--border)",
                            borderLeft: i % 7 === 0 ? "1px solid var(--border)" : undefined,
                            cursor: clickable ? "pointer" : undefined,
                          }}
                        >
                          {label ?? (clickable ? <span style={{ opacity: 0.35 }}>–</span> : "")}
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {dayMenu && (
        <div style={{ position: "fixed", left: dayMenu.x, top: dayMenu.y, transform: "translateX(-50%)", zIndex: 50 }}>
          <DayMenu onPick={(s) => setDayStatus(dayMenu.personId, dayMenu.date, s)} onClose={() => setDayMenu(null)} />
        </div>
      )}
    </div>
  );
}
