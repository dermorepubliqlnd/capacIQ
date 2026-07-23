import { useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { TONE_STYLES, type ColumnDef } from "../lib/tableTypes";

export type CalendarDateMode = "range" | "start" | "due";

const DATE_MODE_OPTIONS: { value: CalendarDateMode; label: string }[] = [
  { value: "range", label: "Start and Due Date" },
  { value: "start", label: "Start Date" },
  { value: "due", label: "Due Date" },
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
  // Which date(s) a row is anchored to. "start"/"due" anchor a row on
  // just that one date (single-day card, skipped if that date is
  // missing). "range" anchors a row with only one of the two dates (or
  // with both dates falling on the same day) the same way, as a single
  // day-cell card -- but a row with BOTH dates set, spanning more than
  // one day, instead renders as one continuous bar across every day
  // from Start to Due (clipped to each week row), per Sandra: "the block
  // should be continuous" rather than two disconnected single-day cards
  // on the start day and the due day. Still fully read-only -- no drag/
  // resize -- same "view only" constraint as the rest of Calendar. Same
  // three modes/labels as Timeline's own "Dates View" dropdown for
  // consistency.
  dateMode?: CalendarDateMode;
  onDateModeChange?: (mode: CalendarDateMode) => void;
  // Extra properties shown as their own line inside each single-day card,
  // below the Project line -- e.g. Assignee / Effort. Reuses each
  // column's own render() same as Timeline's chips, just laid out as
  // stacked lines (Notion's calendar cards) instead of inline pills. Not
  // shown on multi-day spanning bars (too little room -- title only).
  propertyColumns?: ColumnDef<T>[];
  // A single small badge rendered inline on the SAME line as the title,
  // right-aligned (e.g. the Effort icon-pill) -- per Sandra's annotated
  // mockup, Effort sits next to the task name instead of on its own
  // stacked line below. Callers that pass this should exclude that same
  // column from propertyColumns to avoid showing it twice. Also shown
  // inline on multi-day spanning bars, same idea.
  titleBadge?: (row: T) => ReactNode;
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

type SpanPlacement<T> = {
  row: T;
  start: Date;
  due: Date;
  colStart: number;
  colEnd: number;
  lane: number;
  isStartEdge: boolean;
  isDueEdge: boolean;
};

// Greedy interval-graph-coloring lane packing for one week row's multi-day
// spans, clipped to that week's 7 columns (col 0 = Sunday .. col 6 =
// Saturday). Sorted by column start (then longer spans first) so the
// "first free lane" scan produces the minimum lane count. isStartEdge /
// isDueEdge mark whether the row's *actual* start/due date falls inside
// this week (so only the true ends of the bar get rounded corners --
// a bar continuing from/into an adjacent week row stays square on that
// side).
function packWeekSpans<T>(
  weekDates: Date[],
  spans: { row: T; start: Date; due: Date }[]
): { placements: SpanPlacement<T>[]; laneCount: number } {
  const weekStart = weekDates[0];
  const weekEnd = weekDates[6];
  const items = spans
    .filter((sp) => sp.due >= weekStart && sp.start <= weekEnd)
    .map((sp) => {
      const rawStartCol = diffDays(sp.start, weekStart);
      const rawEndCol = diffDays(sp.due, weekStart);
      return {
        row: sp.row,
        start: sp.start,
        due: sp.due,
        colStart: Math.max(0, Math.min(6, rawStartCol)),
        colEnd: Math.max(0, Math.min(6, rawEndCol)),
        isStartEdge: rawStartCol >= 0,
        isDueEdge: rawEndCol <= 6,
      };
    })
    .sort((a, b) => a.colStart - b.colStart || b.colEnd - b.colStart - (a.colEnd - a.colStart));

  const laneEnds: number[] = [];
  const placements: SpanPlacement<T>[] = items.map((it) => {
    let lane = laneEnds.findIndex((end) => end < it.colStart);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(it.colEnd);
    } else {
      laneEnds[lane] = it.colEnd;
    }
    return { ...it, lane };
  });
  return { placements, laneCount: laneEnds.length };
}

// Read-only month calendar for Projects and Tasks. Single-date (or
// same-day) rows render as small Notion-style stacked cards on their one
// anchor day; rows with both a Start and a Due date spanning more than a
// day render as one continuous colored bar across the days between, per
// week row. No drag/resize anywhere -- Sandra: "let this be view only".
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
  titleBadge,
}: CalendarViewProps<T>) {
  const today = useMemo(() => new Date(), []);
  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));

  const weeks = useMemo(() => getMonthGrid(month), [month]);

  type AnchorEntry = { row: T; anchor: Date; start: Date; due: Date; hasStart: boolean; hasDue: boolean };

  const anchored = useMemo((): AnchorEntry[] => {
    return rows.flatMap((row): AnchorEntry[] => {
      const s = getStart(row);
      const d = getDue(row);
      if (dateMode === "start") {
        if (!s) return [];
        const start = parseLocalDate(s);
        return [{ row, anchor: start, start, due: start, hasStart: true, hasDue: false }];
      }
      if (dateMode === "due") {
        if (!d) return [];
        const due = parseLocalDate(d);
        return [{ row, anchor: due, start: due, due, hasStart: false, hasDue: true }];
      }
      if (!s && !d) return [];
      const start = s ? parseLocalDate(s) : parseLocalDate(d!);
      const dueRaw = d ? parseLocalDate(d) : parseLocalDate(s!);
      const due = dueRaw < start ? start : dueRaw;
      const hasStart = Boolean(s);
      const hasDue = Boolean(d);
      // Rows with both dates set, spanning more than a single day, are
      // rendered by the `spans` overlay below instead (a continuous bar)
      // -- not as a day-cell card here. Single-date (or same-day) rows
      // still resolve to one anchored card, same as before.
      if (hasStart && hasDue && !sameDay(start, due)) return [];
      return [{ row, anchor: hasDue ? due : start, start, due, hasStart, hasDue }];
    });
  }, [rows, getStart, getDue, dateMode]);

  const spans = useMemo((): { row: T; start: Date; due: Date }[] => {
    if (dateMode !== "range") return [];
    return rows.flatMap((row) => {
      const s = getStart(row);
      const d = getDue(row);
      if (!s || !d) return [];
      const start = parseLocalDate(s);
      const dueRaw = parseLocalDate(d);
      const due = dueRaw < start ? start : dueRaw;
      if (sameDay(start, due)) return [];
      return [{ row, start, due }];
    });
  }, [rows, getStart, getDue, dateMode]);

  const weekSpanData = useMemo(() => weeks.map((w) => packWeekSpans(w, spans)), [weeks, spans]);

  function itemsForDay(day: Date) {
    return anchored.filter((e) => sameDay(e.anchor, day));
  }

  function dateText(e: AnchorEntry): string {
    if (e.hasStart && e.hasDue && !sameDay(e.start, e.due)) return `${formatShort(e.start)} → ${formatShort(e.due)}`;
    return formatShort(e.anchor);
  }

  const hasAnyRows = anchored.length > 0 || spans.length > 0;

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
          const { placements, laneCount } = weekSpanData[wi];
          const maxCount = Math.max(...weekDates.map((d) => itemsForDay(d).length));
          const visibleCount = Math.min(maxCount, MAX_VISIBLE_PER_DAY);
          // Weeks with zero single-day items this row stay compact (just
          // the day number, no reserved card space) instead of always
          // padding out to at least one card's height -- Sandra: "for days
          // that have no task just keep it blank and white", pointing at
          // Notion's own calendar where empty weeks/days don't reserve
          // phantom card space. Weeks that DO have at least one item keep
          // the existing per-card height budget unchanged.
          const rowMinHeight = visibleCount > 0 ? 26 + visibleCount * 58 : 30;
          return (
            <div key={wi} className="calendar-week-row-wrap">
              {laneCount > 0 && (
                // Normal document flow now (not position:absolute) -- Sandra
                // rejected the thin one-line bar this shipped as first
                // ("i don't want the one line height. please follow this",
                // pointing at a single-day card screenshot): span bars now
                // render the exact same stacked content a single-day card
                // does (parent/title/project/each property/date), just
                // spanning multiple grid columns instead of one. Letting
                // this sit in normal flow (auto height) instead of an
                // absolutely-positioned fixed-height overlay means the day
                // cells below it just follow naturally -- no manual height
                // math, and no repeat of the earlier margin-collapse bug
                // that came from faking this with position:absolute +
                // marginTop/paddingTop.
                <div className="calendar-week-spans">
                  {placements.map((p) => {
                    const tone = TONE_STYLES[getTone?.(p.row) ?? "neutral"] ?? TONE_STYLES.neutral;
                    const parentLabel = getParentLabel?.(p.row);
                    const projectLabel = getProjectLabel?.(p.row);
                    return (
                      <div
                        key={`${rowKey(p.row)}_span`}
                        className="calendar-card calendar-span-bar"
                        title={getTooltip?.(p.row)}
                        style={{
                          gridColumn: `${p.colStart + 1} / ${p.colEnd + 2}`,
                          gridRow: p.lane + 1,
                          background: tone.bg,
                          borderLeftColor: p.isStartEdge ? tone.text : "transparent",
                          borderTopLeftRadius: p.isStartEdge ? undefined : 0,
                          borderBottomLeftRadius: p.isStartEdge ? undefined : 0,
                          borderTopRightRadius: p.isDueEdge ? undefined : 0,
                          borderBottomRightRadius: p.isDueEdge ? undefined : 0,
                        }}
                      >
                        {parentLabel && <div className="calendar-card-parent">{parentLabel}</div>}
                        <div className="calendar-card-title-row">
                          <div className="calendar-card-title">{renderLabel(p.row)}</div>
                          {titleBadge && <div className="calendar-card-title-badge">{titleBadge(p.row)}</div>}
                        </div>
                        {projectLabel && <div className="calendar-card-project">{projectLabel}</div>}
                        {propertyColumns?.map((c) => (
                          <div key={c.key} className="calendar-card-prop">{c.render(p.row)}</div>
                        ))}
                        <div className="calendar-card-dates" style={{ color: tone.text }}>{`${formatShort(p.start)} → ${formatShort(p.due)}`}</div>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="calendar-week-row-cards">
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
                      style={{ minHeight: rowMinHeight }}
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
                              <div className="calendar-card-title-row">
                                <div className="calendar-card-title">{renderLabel(e.row)}</div>
                                {titleBadge && <div className="calendar-card-title-badge">{titleBadge(e.row)}</div>}
                              </div>
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
            </div>
          );
        })
      )}
    </div>
  );
}
