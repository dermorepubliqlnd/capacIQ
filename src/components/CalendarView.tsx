import { useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { TONE_STYLES, type ColumnDef } from "../lib/tableTypes";

export type CalendarDateMode = "range" | "start" | "due";

const DATE_MODE_OPTIONS: { value: CalendarDateMode; label: string }[] = [
  { value: "range", label: "Start and End Date" },
  { value: "start", label: "Start Date" },
  { value: "due", label: "End Date" },
];

interface CalendarViewProps<T> {
  rows: T[];
  rowKey: (row: T) => string;
  // Plain editable title only (no Table-chrome like collapse
  // chevrons/connectors/add-sub-task buttons -- those belong in the
  // Table row, not a small calendar card).
  renderLabel: (row: T) => ReactNode;
  getStart: (row: T) => string | null;
  getDue: (row: T) => string | null;
  getTone?: (row: T) => string;
  getTooltip?: (row: T) => string;
  emptyLabel?: string;
  // Sandra's card spec (annotated over a Notion screenshot): a small
  // muted line ABOVE the title showing the parent task's name, only when
  // this row actually has a parent (a sub-task) -- omitted/undefined for
  // a top-level row so nothing renders. Tasks-only; Projects has no
  // parent concept and simply won't pass this.
  getParentLabel?: (row: T) => string | null | undefined;
  // Same spec: Project name shown as its own line right under the title,
  // in a smaller size -- always shown (not part of the togglable
  // propertyColumns list) since it's structural card identity, same
  // treatment as the title itself. Tasks-only.
  getProjectLabel?: (row: T) => string | null | undefined;
  // Which single date a card is anchored to (Notion-style: a card renders
  // once, on one day, with its date range shown as text inside the card
  // rather than visually spanning multiple day cells). "range" anchors on
  // Due (falling back to Start) and shows the full "Start -> Due" text
  // when they differ; "start"/"due" anchor on just that one date and skip
  // rows missing it. Same three modes/labels as Timeline's own "Dates
  // View" dropdown for consistency.
  dateMode?: CalendarDateMode;
  onDateModeChange?: (mode: CalendarDateMode) => void;
  // Extra properties shown as their own line inside each card, below the
  // Project line -- e.g. Assignee / Effort. Reuses each column's own
  // render() same as Timeline's chips, just laid out as stacked lines
  // (Notion's calendar cards) instead of inline pills.
  propertyColumns?: ColumnDef<T>[];
}

const MAX_VISIBLE_PER_DAY = 3;
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
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
function formatShort(d: Date): string {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
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

// Read-only, Notion-style month calendar: each item renders as a small
// stacked card on a single anchor day (not a spanning Gantt bar) --
// title, then each property column as its own line, then the date/date
// range as text. Sandra: "let this be view only" -- no drag-to-reschedule
// here, that idea was tried and explicitly walked back in favor of this
// simpler, information-dense card layout matching Notion's own Calendar
// view.
export default function CalendarView<T>({
  rows,
  rowKey,
  renderLabel,
  getStart,
  getDue,
  getTone,
  getTooltip,
  emptyLabel = "Nothing here yet.",
  dateMode = "range",
  onDateModeChange,
  propertyColumns,
  getParentLabel,
  getProjectLabel,
}: CalendarViewProps<T>) {
  const today = useMemo(() => new Date(), []);
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));

  const weeks = useMemo(() => getMonthGrid(month), [month]);

  const anchored = useMemo(() => {
    return rows
      .map((row) => {
        const s = getStart(row);
        const d = getDue(row);
        if (dateMode === "start") {
          if (!s) return null;
          return { row, anchor: parseLocalDate(s), start: parseLocalDate(s), due: parseLocalDate(s), hasStart: true, hasDue: false };
        }
        if (dateMode === "due") {
          if (!d) return null;
          return { row, anchor: parseLocalDate(d), start: parseLocalDate(d), due: parseLocalDate(d), hasStart: false, hasDue: true };
        }
        if (!s && !d) return null;
        const start = s ? parseLocalDate(s) : parseLocalDate(d!);
        const dueRaw = d ? parseLocalDate(d) : parseLocalDate(s!);
        const due = dueRaw < start ? start : dueRaw;
        // Anchor on Due (matches Notion's own behavior in the reference
        // screenshot -- a multi-day item shows once, on its end date),
        // falling back to Start for a start-only row.
        const anchor = d ? due : start;
        return { row, anchor, start, due, hasStart: Boolean(s), hasDue: Boolean(d) };
      })
      .filter(
        (r): r is { row: T; anchor: Date; start: Date; due: Date; hasStart: boolean; hasDue: boolean } => r !== null
      );
  }, [rows, getStart, getDue, dateMode]);

  function itemsForDay(day: Date) {
    return anchored.filter((e) => sameDay(e.anchor, day));
  }

  function dateText(e: (typeof anchored)[number]): string {
    if (e.hasStart && e.hasDue && !sameDay(e.start, e.due)) return `${formatShort(e.start)} → ${formatShort(e.due)}`;
    return formatShort(e.anchor);
  }

  const hasAnyRows = anchored.length > 0;

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
        {onDateModeChange && (
          <div className="timeline-datemode" style={{ marginLeft: "auto" }} title="Which date a card is anchored to">
            <span className="timeline-datemode-label">Dates View</span>
            <select
              className="timeline-datemode-select"
              value={dateMode}
              onChange={(e) => onDateModeChange(e.target.value as CalendarDateMode)}
            >
              {DATE_MODE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        )}
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
          const maxCount = Math.max(...weekDates.map((d) => itemsForDay(d).length));
          const visibleCount = Math.min(maxCount, MAX_VISIBLE_PER_DAY);
          return (
            <div key={wi} className="calendar-week-row-cards">
              {weekDates.map((d, di) => {
                const inMonth = d.getMonth() === month.getMonth();
                const isToday = sameDay(d, today);
                const items = itemsForDay(d);
                const visible = items.slice(0, MAX_VISIBLE_PER_DAY);
                const overflow = items.length - visible.length;
                return (
                  <div
                    key={di}
                    className={`calendar-day-card-cell${inMonth ? "" : " is-outside"}`}
                    style={{ minHeight: 26 + Math.max(visibleCount, 1) * 58 }}
                  >
                    <span className={`calendar-day-number${isToday ? " is-today" : ""}`}>{d.getDate()}</span>
                    <div className="calendar-day-cards">
                      {visible.map((e) => {
                        const tone = TONE_STYLES[getTone?.(e.row) ?? "neutral"] ?? TONE_STYLES.neutral;
                        const parentLabel = getParentLabel?.(e.row);
                        const projectLabel = getProjectLabel?.(e.row);
                        return (
                          <div
                            key={rowKey(e.row)}
                            className="calendar-card"
                            title={getTooltip?.(e.row)}
                            style={{ background: tone.bg, borderLeftColor: tone.text }}
                          >
                            {parentLabel && <div className="calendar-card-parent">{parentLabel}</div>}
                            <div className="calendar-card-title">{renderLabel(e.row)}</div>
                            {projectLabel && <div className="calendar-card-project">{projectLabel}</div>}
                            {propertyColumns?.map((c) => (
                              <div key={c.key} className="calendar-card-prop">{c.render(e.row)}</div>
                            ))}
                            <div className="calendar-card-dates" style={{ color: tone.text }}>{dateText(e)}</div>
                          </div>
                        );
                      })}
                      {overflow > 0 && <div className="calendar-day-overflow">+{overflow} more</div>}
                    </div>
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
