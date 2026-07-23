import { useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { TONE_STYLES } from "../lib/tableTypes";

interface CalendarViewProps<T> {
  rows: T[];
  rowKey: (row: T) => string;
  // Same idea as TimelineView's renderLabel -- reuses the caller's own
  // column render() (e.g. the Name column) so a calendar bar looks and
  // edits exactly like its Table/Board/Timeline counterparts.
  renderLabel: (row: T) => ReactNode;
  getStart: (row: T) => string | null;
  getDue: (row: T) => string | null;
  getTone?: (row: T) => string;
  getTooltip?: (row: T) => string;
  emptyLabel?: string;
  // Called on drop -- both dates already shifted by the same day-delta
  // (range items) or with just the single relevant field moved (items
  // that only had a Start or only a Due). Null values are left null.
  onReschedule?: (row: T, newStart: string | null, newDue: string | null) => void;
  // Per-row gate on top of onReschedule -- e.g. a locked task/project, or
  // one whose dates are themselves computed from its own sub-tasks/tasks
  // rather than stored directly, shouldn't be draggable even though
  // onReschedule exists for other rows. Defaults to "always draggable"
  // when omitted.
  canDrag?: (row: T) => boolean;
}

const MAX_LANES = 4;
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}
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
function diffDays(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / 86400000);
}
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function getMonthGrid(month: Date): Date[][] {
  const year = month.getFullYear();
  const mo = month.getMonth();
  const firstOfMonth = new Date(year, mo, 1);
  const lastOfMonth = new Date(year, mo + 1, 0);
  const gridStart = addDays(firstOfMonth, -firstOfMonth.getDay());
  const totalDaysNeeded = diffDays(lastOfMonth, gridStart) + 1;
  const weekCount = Math.ceil(totalDaysNeeded / 7);
  const weeks: Date[][] = [];
  let cursor = gridStart;
  for (let w = 0; w < weekCount; w++) {
    const week: Date[] = [];
    for (let d = 0; d < 7; d++) {
      week.push(cursor);
      cursor = addDays(cursor, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

export default function CalendarView<T>({
  rows,
  rowKey,
  renderLabel,
  getStart,
  getDue,
  getTone,
  getTooltip,
  emptyLabel = "Nothing here yet.",
  onReschedule,
  canDrag,
}: CalendarViewProps<T>) {
  const today = useMemo(() => new Date(), []);
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [dragKey, setDragKey] = useState<string | null>(null);

  const weeks = useMemo(() => getMonthGrid(month), [month]);

  // Every row that has at least a Start or a Due date, resolved to a
  // {start, due} pair -- a row with only one date renders as a one-day
  // bar on that date (no separate "marker" look; a 1-day bar already
  // reads as a single-day event).
  const ranged = useMemo(() => {
    return rows
      .map((row) => {
        const s = getStart(row);
        const d = getDue(row);
        if (!s && !d) return null;
        const start = s ? parseLocalDate(s) : parseLocalDate(d!);
        const dueRaw = d ? parseLocalDate(d) : parseLocalDate(s!);
        const due = dueRaw < start ? start : dueRaw;
        return { row, start, due, hasStart: Boolean(s), hasDue: Boolean(d) };
      })
      .filter((r): r is { row: T; start: Date; due: Date; hasStart: boolean; hasDue: boolean } => r !== null);
  }, [rows, getStart, getDue]);

  function layoutWeek(weekDates: Date[]) {
    const weekStart = weekDates[0];
    const weekEnd = weekDates[6];
    const touching = ranged
      .filter((e) => e.due >= weekStart && e.start <= weekEnd)
      .map((e) => {
        const clipStart = e.start < weekStart ? weekStart : e.start;
        const clipEnd = e.due > weekEnd ? weekEnd : e.due;
        const colStart = diffDays(clipStart, weekStart);
        const colSpan = diffDays(clipEnd, clipStart) + 1;
        return { ...e, colStart, colSpan };
      })
      .sort((a, b) => a.colStart - b.colStart || b.colSpan - a.colSpan);

    const laneEnd: number[] = [];
    const laid: Array<(typeof touching)[number] & { lane: number }> = [];
    const overflowByCol = new Array(7).fill(0);
    for (const e of touching) {
      let lane = 0;
      while (laneEnd[lane] !== undefined && laneEnd[lane] >= e.colStart) lane++;
      if (lane >= MAX_LANES) {
        for (let c = e.colStart; c < e.colStart + e.colSpan; c++) overflowByCol[c]++;
        continue;
      }
      laneEnd[lane] = e.colStart + e.colSpan - 1;
      laid.push({ ...e, lane });
    }
    return { laid, overflowByCol };
  }

  function handleDragStart(key: string) {
    setDragKey(key);
  }

  function handleDrop(dropDate: Date) {
    if (!dragKey || !onReschedule) return;
    const dragged = ranged.find((e) => rowKey(e.row) === dragKey);
    setDragKey(null);
    if (!dragged) return;
    // Anchor on Start when present (matches how a person would naturally
    // grab the front of a bar), otherwise Due for a due-only item.
    const anchor = dragged.hasStart ? dragged.start : dragged.due;
    const delta = diffDays(dropDate, anchor);
    const newStart = dragged.hasStart ? toISO(addDays(dragged.start, delta)) : null;
    const newDue = dragged.hasDue ? toISO(addDays(dragged.due, delta)) : null;
    onReschedule(dragged.row, newStart, newDue);
  }

  const hasAnyRows = ranged.length > 0;

  return (
    <div className="calendar-view">
      <div className="calendar-view-header">
        <button className="calendar-nav-btn" onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))} title="Previous month">
          <ChevronLeft size={14} />
        </button>
        <span className="calendar-month-label">
          {month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
        </span>
        <button className="calendar-nav-btn" onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))} title="Next month">
          <ChevronRight size={14} />
        </button>
        <button
          className="calendar-today-btn"
          onClick={() => setMonth(new Date(today.getFullYear(), today.getMonth(), 1))}
        >
          Today
        </button>
      </div>

      <div className="calendar-weekday-row">
        {DAY_LABELS.map((d) => (
          <div key={d} className="calendar-weekday-cell">{d}</div>
        ))}
      </div>

      {!hasAnyRows ? (
        <div className="calendar-empty">{emptyLabel}</div>
      ) : (
        weeks.map((weekDates, wi) => {
          const { laid, overflowByCol } = layoutWeek(weekDates);
          const laneCount = Math.max(1, ...laid.map((e) => e.lane + 1));
          const rowHeight = 22 + laneCount * 24 + 4;
          return (
            <div key={wi} className="calendar-week-row" style={{ height: rowHeight }}>
              {weekDates.map((d, di) => {
                const inMonth = d.getMonth() === month.getMonth();
                const isToday = sameDay(d, today);
                return (
                  <div
                    key={di}
                    className={`calendar-day-cell${inMonth ? "" : " is-outside"}`}
                    style={{ left: `${(di / 7) * 100}%`, width: `${(1 / 7) * 100}%` }}
                    onDragOver={onReschedule ? (e) => e.preventDefault() : undefined}
                    onDrop={onReschedule ? () => handleDrop(d) : undefined}
                  >
                    <span className={`calendar-day-number${isToday ? " is-today" : ""}`}>{d.getDate()}</span>
                    {overflowByCol[di] > 0 && (
                      <span className="calendar-day-overflow">+{overflowByCol[di]} more</span>
                    )}
                  </div>
                );
              })}
              {laid.map((e) => {
                const key = rowKey(e.row);
                const tone = TONE_STYLES[getTone?.(e.row) ?? "neutral"] ?? TONE_STYLES.neutral;
                const draggableHere = Boolean(onReschedule) && (canDrag ? canDrag(e.row) : true);
                return (
                  <div
                    key={key}
                    className="calendar-bar"
                    title={getTooltip?.(e.row)}
                    draggable={draggableHere}
                    onDragStart={draggableHere ? () => handleDragStart(key) : undefined}
                    onDragEnd={draggableHere ? () => setDragKey(null) : undefined}
                    style={{
                      left: `${(e.colStart / 7) * 100}%`,
                      width: `${(e.colSpan / 7) * 100}%`,
                      top: 22 + e.lane * 24,
                      background: tone.bg,
                      color: tone.text,
                      opacity: dragKey === key ? 0.4 : 1,
                      cursor: draggableHere ? "grab" : "default",
                    }}
                  >
                    {renderLabel(e.row)}
                  </div>
                );
              })}
            </div>
          );
        })
      )}
    </div>
  );
}
