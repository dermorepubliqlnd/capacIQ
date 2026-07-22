import { useMemo, type ReactNode } from "react";
import { TONE_STYLES } from "../lib/tableTypes";

export type TimelineScale = "day" | "week" | "month" | "quarter";
export type TimelineDateMode = "range" | "start" | "due";

interface TimelineViewProps<T> {
  rows: T[];
  rowKey: (row: T) => string;
  // Rendered inside the fixed label column for each row -- callers pass
  // through the same column render() used by Table/Board (e.g. the Name
  // column), mirroring how BoardView's renderCard reuses column renderers
  // instead of building its own label markup from scratch.
  renderLabel: (row: T) => ReactNode;
  getStart: (row: T) => string | null;
  getDue: (row: T) => string | null;
  dateMode: TimelineDateMode;
  scale: TimelineScale;
  getTone?: (row: T) => string;
  getTooltip?: (row: T) => string;
  emptyLabel?: string;
}

// Local-timezone date helpers -- same "YYYY-MM-DD" UTC-midnight parsing fix
// as parseLocalDate/toISO in Projects.tsx and DayPlanner.tsx.
function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function startOfWeek(d: Date): Date {
  const r = startOfDay(d);
  const day = r.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  return addDays(r, diff);
}
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
function startOfQuarter(d: Date): Date {
  return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1);
}
function addQuarters(d: Date, n: number): Date {
  return addMonths(d, n * 3);
}

// Column width per scale -- Daily needs the least horizontal room per unit
// (just a day number), Quarterly the most (a "Qn YYYY" label plus room to
// see several quarters' worth of bars at once without them collapsing to
// slivers).
const CELL_W: Record<TimelineScale, number> = { day: 34, week: 68, month: 96, quarter: 130 };
const ROW_H = 32;
const LABEL_W = 220;
const HEADER_H = 30;
// Day scale uses a two-row header (Month group row + Day-number row)
// instead of a single row of "Jul 16"-style labels, so a Gantt view at
// day resolution reads at a glance which month a run of day-columns
// belongs to without repeating it in every cell. Week/Month/Quarter
// scales are unaffected and keep the original single-row HEADER_H.
const HEADER_ROW_H = 22;

interface Column {
  start: Date;
  end: Date;
  label: string;
}

function buildColumns(scale: TimelineScale, rangeStart: Date, rangeEnd: Date): Column[] {
  const columns: Column[] = [];
  if (scale === "day") {
    let cur = startOfDay(rangeStart);
    while (cur < rangeEnd) {
      const next = addDays(cur, 1);
      columns.push({ start: cur, end: next, label: cur.toLocaleDateString("en-US", { month: "short", day: "numeric" }) });
      cur = next;
    }
  } else if (scale === "week") {
    let cur = startOfWeek(rangeStart);
    while (cur < rangeEnd) {
      const next = addDays(cur, 7);
      columns.push({ start: cur, end: next, label: cur.toLocaleDateString("en-US", { month: "short", day: "numeric" }) });
      cur = next;
    }
  } else if (scale === "month") {
    let cur = startOfMonth(rangeStart);
    while (cur < rangeEnd) {
      const next = addMonths(cur, 1);
      columns.push({ start: cur, end: next, label: cur.toLocaleDateString("en-US", { month: "short", year: "numeric" }) });
      cur = next;
    }
  } else {
    let cur = startOfQuarter(rangeStart);
    while (cur < rangeEnd) {
      const next = addQuarters(cur, 1);
      columns.push({ start: cur, end: next, label: `Q${Math.floor(cur.getMonth() / 3) + 1} ${cur.getFullYear()}` });
      cur = next;
    }
  }
  return columns;
}

// Maps a date to an x-pixel offset within the grid by locating which
// column contains it and interpolating across that column's own width --
// keeps bars aligned to the header's gridlines even though day/month/
// quarter columns don't all cover the same number of days.
function dateToX(date: Date, columns: Column[], cellW: number): number {
  if (columns.length === 0) return 0;
  const first = columns[0].start;
  const last = columns[columns.length - 1].end;
  const clamped = date < first ? first : date > last ? last : date;
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    if (clamped >= col.start && clamped <= col.end) {
      const span = col.end.getTime() - col.start.getTime();
      const frac = span > 0 ? (clamped.getTime() - col.start.getTime()) / span : 0;
      return i * cellW + frac * cellW;
    }
  }
  return columns.length * cellW;
}

const SCALE_PAD: Record<TimelineScale, (d: Date, sign: 1 | -1) => Date> = {
  day: (d, sign) => addDays(d, 3 * sign),
  week: (d, sign) => addDays(d, 7 * sign),
  month: (d, sign) => addMonths(d, 1 * sign),
  quarter: (d, sign) => addQuarters(d, 1 * sign),
};

// Gantt-style alternate render of a rows table: one row per task/project,
// laid out against a date axis whose resolution (day/week/month/quarter)
// is controlled by `scale`, and whose bar semantics (full range vs. a
// single start/due marker) are controlled by `dateMode`. Rows with no
// usable dates for the current dateMode simply render with no bar/marker
// -- they still show up in the label column, just with nothing to draw.
export default function TimelineView<T>({
  rows,
  rowKey,
  renderLabel,
  getStart,
  getDue,
  dateMode,
  scale,
  getTone,
  getTooltip,
  emptyLabel = "No items to show on the timeline.",
}: TimelineViewProps<T>) {
  const cellW = CELL_W[scale];

  const { columns, rangeStart, rangeEnd } = useMemo(() => {
    const allDates: Date[] = [];
    rows.forEach((r) => {
      const s = getStart(r);
      const d = getDue(r);
      if (s) allDates.push(parseLocalDate(s));
      if (d) allDates.push(parseLocalDate(d));
    });

    let minD: Date;
    let maxD: Date;
    if (allDates.length > 0) {
      minD = new Date(Math.min(...allDates.map((d) => d.getTime())));
      maxD = new Date(Math.max(...allDates.map((d) => d.getTime())));
    } else {
      // No dated rows at all -- fall back to a window centered on today
      // so the grid still renders something readable instead of an empty
      // sliver.
      minD = addMonths(startOfDay(new Date()), -1);
      maxD = addMonths(startOfDay(new Date()), 2);
    }

    const paddedStart = SCALE_PAD[scale](minD, -1);
    const paddedEnd = SCALE_PAD[scale](maxD, 1);
    const alignedStart =
      scale === "day"
        ? startOfDay(paddedStart)
        : scale === "week"
        ? startOfWeek(paddedStart)
        : scale === "month"
        ? startOfMonth(paddedStart)
        : startOfQuarter(paddedStart);
    const cols = buildColumns(scale, alignedStart, paddedEnd);
    const end = cols.length > 0 ? cols[cols.length - 1].end : paddedEnd;
    return { columns: cols, rangeStart: alignedStart, rangeEnd: end };
  }, [rows, getStart, getDue, scale]);

  const today = startOfDay(new Date());
  const showToday = today >= rangeStart && today <= rangeEnd;
  const todayX = showToday ? dateToX(today, columns, cellW) : 0;
  const gridWidth = columns.length * cellW;
  const headerHeight = scale === "day" ? HEADER_ROW_H * 2 : HEADER_H;

  // Group consecutive day-columns that fall in the same month, so the
  // Day-scale header's top row can render one "July 2026"-style cell
  // spanning all of that month's visible day-columns instead of repeating
  // the month in every single day cell (the bottom row then only needs
  // the bare day number). Only computed/used when scale === "day" --
  // Week/Month/Quarter keep their existing single-row header untouched.
  const monthGroups = useMemo(() => {
    if (scale !== "day") return [];
    const groups: { label: string; span: number }[] = [];
    for (const col of columns) {
      const label = col.start.toLocaleDateString("en-US", { month: "long", year: "numeric" });
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.span += 1;
      else groups.push({ label, span: 1 });
    }
    return groups;
  }, [columns, scale]);

  function barFor(row: T) {
    const startStr = getStart(row);
    const dueStr = getDue(row);
    const tone = TONE_STYLES[getTone?.(row) ?? "accent"] ?? TONE_STYLES.accent;
    const tooltip = getTooltip?.(row);

    function marker(dateStr: string, key: string) {
      const x = dateToX(parseLocalDate(dateStr), columns, cellW);
      return (
        <div
          key={key}
          className="timeline-marker"
          title={tooltip}
          style={{ left: x - 5, background: tone.text }}
        />
      );
    }

    if (dateMode === "start") return startStr ? marker(startStr, "start") : null;
    if (dateMode === "due") return dueStr ? marker(dueStr, "due") : null;

    // "range": a bar when both ends exist, otherwise fall back to a
    // single-end marker so a task with just one date still shows *something*
    // rather than silently vanishing from the timeline.
    if (startStr && dueStr) {
      const x1 = dateToX(parseLocalDate(startStr), columns, cellW);
      const x2 = dateToX(parseLocalDate(dueStr), columns, cellW);
      const left = Math.min(x1, x2);
      const width = Math.max(Math.abs(x2 - x1), 6);
      return (
        <div
          key="range"
          className="timeline-bar"
          title={tooltip}
          style={{ left, width, background: tone.bg, borderColor: tone.text }}
        />
      );
    }
    if (startStr) return marker(startStr, "start-only");
    if (dueStr) return marker(dueStr, "due-only");
    return null;
  }

  return (
    <div className="timeline-view">
      <div className="timeline-scroll">
        <div className="timeline-inner" style={{ width: LABEL_W + gridWidth }}>
          <div className="timeline-header-row" style={{ height: headerHeight }}>
            <div className="timeline-header-label-cell" style={{ width: LABEL_W }} />
            <div style={{ display: "flex", flexDirection: "column", flexShrink: 0, width: gridWidth }}>
              {scale === "day" && (
                <div style={{ display: "flex", height: HEADER_ROW_H }}>
                  {monthGroups.map((g, i) => (
                    <div key={i} className="timeline-header-cell timeline-header-cell-month" style={{ width: g.span * cellW }}>
                      {g.label}
                    </div>
                  ))}
                </div>
              )}
              <div style={{ display: "flex", height: scale === "day" ? HEADER_ROW_H : headerHeight }}>
                {columns.map((col, i) => (
                  <div key={i} className="timeline-header-cell" style={{ width: cellW }}>
                    {scale === "day" ? col.start.getDate() : col.label}
                  </div>
                ))}
              </div>
            </div>
          </div>
          {rows.map((row) => (
            <div key={rowKey(row)} className="timeline-row" style={{ height: ROW_H }}>
              <div className="timeline-label-cell" style={{ width: LABEL_W }}>
                {renderLabel(row)}
              </div>
              <div className="timeline-row-grid" style={{ width: gridWidth }}>
                {barFor(row)}
              </div>
            </div>
          ))}
          {rows.length === 0 && <div className="timeline-empty">{emptyLabel}</div>}
          {showToday && rows.length > 0 && (
            <div
              className="timeline-today-line"
              style={{ left: LABEL_W + todayX, top: headerHeight, height: rows.length * ROW_H }}
              title="Today"
            />
          )}
        </div>
      </div>
    </div>
  );
}

const SCALE_TILES: { value: TimelineScale; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "quarter", label: "Quarter" },
];

const DATE_MODE_TILES: { value: TimelineDateMode; label: string; title: string }[] = [
  { value: "range", label: "Range", title: "Bar spans Start → Due" },
  { value: "start", label: "Start", title: "Marker at Start date only" },
  { value: "due", label: "Due", title: "Marker at Due date only" },
];

// Small segmented-button pair for Timeline's own toolbar controls (scale +
// date mode) -- same visual idea as ProgressDisplayToggle's per-view
// cycling button in ProgressCell.tsx, just rendered as an explicit 4-way /
// 3-way picker instead of a single cycling icon since both choices have
// more than 2-3 options worth seeing at a glance.
export function TimelineControls({
  scale,
  onScaleChange,
  dateMode,
  onDateModeChange,
}: {
  scale: TimelineScale;
  onScaleChange: (scale: TimelineScale) => void;
  dateMode: TimelineDateMode;
  onDateModeChange: (mode: TimelineDateMode) => void;
}) {
  return (
    <>
      <div className="timeline-segmented" title="Timeline scale">
        {SCALE_TILES.map((t) => (
          <button
            key={t.value}
            className={`timeline-segmented-btn${scale === t.value ? " active" : ""}`}
            onClick={() => onScaleChange(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="timeline-segmented" title="What a task's bar represents">
        {DATE_MODE_TILES.map((t) => (
          <button
            key={t.value}
            className={`timeline-segmented-btn${dateMode === t.value ? " active" : ""}`}
            title={t.title}
            onClick={() => onDateModeChange(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>
    </>
  );
}
