import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { TONE_STYLES, type ColumnDef } from "../lib/tableTypes";

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
  // Whichever columns are currently visible per the view's Properties
  // settings, already filtered to exclude the label/name column itself
  // (it's already shown as the label) -- same
  // visibleOrderedColumns(...).filter(name-out) callers compute for Board's
  // renderProjectCard/renderTaskCard. Rendered as small inline chips after
  // the name using each column's own render(row), so a chip is exactly
  // what that property looks like everywhere else (a status pill, an
  // owner name, etc.) rather than a bespoke Timeline-only representation.
  propertyColumns?: ColumnDef<T>[];
  // Optional: when provided, a "range" bar (both Start and Due present)
  // gets a second, darker fill layer from its left edge covering
  // `percent`% of the bar's own width -- a Gantt-style actual-progress
  // overlay on top of the plain start->due span. Null means "no weighted
  // tasks to measure progress from" and renders the bar as before with no
  // overlay. Not used at all for start/due single-marker rendering, or by
  // callers (e.g. Tasks Timeline) that don't pass it.
  getProgress?: (row: T) => number | null;
  // Optional grouping -- when set, rows render as vertical swimlane
  // sections (group header row, then that group's rows) instead of one
  // flat list, while the date-axis columns/header stay shared across every
  // section (computed once from the full `rows` list, same as the
  // ungrouped case). Mirrors Table's grouped-accordion bucketing (group by
  // getGroup(row), "—" for empty/falsy) and Board's per-group tone.
  getGroup?: (row: T) => string;
  getGroupTone?: (row: T) => string;
  hiddenGroups?: string[];
  // Width (px) of the sticky label column -- lifted to the caller (backed by
  // each view's own timelineLabelWidth, see tableTypes.ts) so it persists
  // per-view the same way progressDisplay/timelineScale already do, rather
  // than resetting every time TimelineView remounts. Replaces the old
  // hardcoded LABEL_W constant everywhere it was used (header cell, label
  // cell, timeline-inner's total width, the today-line's left offset).
  labelWidth: number;
  onLabelWidthChange: (width: number) => void;
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
// Label column is now user-resizable (drag handle on the right edge of
// .timeline-label-cell / .timeline-header-label-cell) rather than a fixed
// constant -- these just bound the drag, and give TimelineView something
// sane to render before the caller's own labelWidth prop arrives.
const LABEL_W_MIN = 220;
const LABEL_W_MAX = 640;
const HEADER_H = 30;
// Day scale uses a two-row header (Month group row + Day-number row)
// instead of a single row of "Jul 16"-style labels, so a Gantt view at
// day resolution reads at a glance which month a run of day-columns
// belongs to without repeating it in every cell. Week/Month/Quarter
// scales are unaffected and keep the original single-row HEADER_H.
const HEADER_ROW_H = 22;
// Swimlane section header row (group name + count), same idea as Table's
// grouped-accordion group row and Board's per-column header.
const GROUP_ROW_H = 26;

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
  propertyColumns,
  getProgress,
  getGroup,
  getGroupTone,
  hiddenGroups,
  labelWidth,
  onLabelWidthChange,
}: TimelineViewProps<T>) {
  const cellW = CELL_W[scale];

  // Live width while dragging the label-column resize handle -- mirrors
  // DataTable's own column-resize pattern (a ref tracks the in-progress
  // drag, mousemove updates a rerender-triggering piece of state, mouseup
  // commits the final value to the caller via onLabelWidthChange). Synced
  // back to the prop whenever it changes from outside the drag (switching
  // views, or a fresh view that predates timelineLabelWidth).
  const [dragLabelWidth, setDragLabelWidth] = useState<number | null>(null);
  const labelResizeState = useRef<{ startX: number; startWidth: number } | null>(null);
  useEffect(() => {
    setDragLabelWidth(null);
  }, [labelWidth]);
  const effectiveLabelWidth = dragLabelWidth ?? labelWidth;

  function startLabelResize(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    labelResizeState.current = { startX: e.clientX, startWidth: effectiveLabelWidth };

    function onMove(ev: MouseEvent) {
      if (!labelResizeState.current) return;
      const delta = ev.clientX - labelResizeState.current.startX;
      const next = Math.min(LABEL_W_MAX, Math.max(LABEL_W_MIN, labelResizeState.current.startWidth + delta));
      setDragLabelWidth(next);
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      labelResizeState.current = null;
      // Commit whatever the last onMove landed on (dragLabelWidth is only
      // null before a drag has happened, or once useEffect clears it after
      // the prop catches up) to the caller's persisted per-view width.
      setDragLabelWidth((current) => {
        if (current !== null) onLabelWidthChange(current);
        return current;
      });
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

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

  // Bucket rows into swimlane sections when getGroup is provided --
  // insertion order (first row encountered for a group starts its
  // section), same as DataTable's grouped-accordion body when it has no
  // allGroups() list to pre-seed empty sections with. Hidden groups (the
  // same per-view hiddenGroups the Group-by popover's Show/Hide-all list
  // writes to) are filtered out entirely rather than rendered collapsed.
  const groupedRows = useMemo(() => {
    if (!getGroup) return null;
    const map = new Map<string, T[]>();
    rows.forEach((r) => {
      const g = getGroup(r) || "—";
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(r);
    });
    const hidden = hiddenGroups ?? [];
    return Array.from(map.entries()).filter(([groupName]) => !hidden.includes(groupName));
  }, [rows, getGroup, hiddenGroups]);

  const contentHeight = groupedRows
    ? groupedRows.reduce((sum, [, groupRows]) => sum + GROUP_ROW_H + groupRows.length * ROW_H, 0)
    : rows.length * ROW_H;

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
      const progress = getProgress?.(row) ?? null;
      return (
        <div key="range-wrap" style={{ position: "absolute", left, top: "50%", transform: "translateY(-50%)", display: "flex", alignItems: "center", gap: 6 }}>
          <div
            className="timeline-bar"
            title={tooltip}
            style={{ position: "static", top: "auto", transform: "none", width, background: tone.bg, borderColor: tone.text }}
          >
            {progress !== null && (
              <div
                className="timeline-bar-progress"
                style={{ width: `${Math.max(0, Math.min(100, progress))}%`, background: tone.text }}
              />
            )}
          </div>
          {/* Plain "NN%" label just after the bar's end -- replaces the old
              progress chip that used to live in the label column (Sandra:
              "can't the progress % be after the bar... only show the
              number"). Only rendered when a real percent exists; the bar's
              own fill overlay above already carries the visual, this is
              just the readable number next to it. */}
          {progress !== null && <span className="timeline-bar-progress-label" style={{ color: tone.text }}>{Math.round(progress)}%</span>}
        </div>
      );
    }
    if (startStr) return marker(startStr, "start-only");
    if (dueStr) return marker(dueStr, "due-only");
    return null;
  }

  function renderRow(row: T) {
    return (
      <div key={rowKey(row)} className="timeline-row" style={{ height: ROW_H }}>
        <div className="timeline-label-cell" style={{ width: effectiveLabelWidth }}>
          <div className="timeline-label-row">
            <span className="timeline-label-name">{renderLabel(row)}</span>
            {propertyColumns && propertyColumns.length > 0 && (
              <div className="timeline-label-chips">
                {propertyColumns.map((c) => (
                  <span key={c.key} className="timeline-chip">
                    {c.render(row)}
                  </span>
                ))}
              </div>
            )}
          </div>
          <span
            className="timeline-label-resize-handle"
            onMouseDown={startLabelResize}
            draggable={false}
            onDragStart={(e) => e.preventDefault()}
            title="Drag to resize"
          />
        </div>
        <div className="timeline-row-grid" style={{ width: gridWidth }}>
          {barFor(row)}
        </div>
      </div>
    );
  }

  return (
    <div className="timeline-view">
      <div className="timeline-scroll">
        <div className="timeline-inner" style={{ width: effectiveLabelWidth + gridWidth }}>
          <div className="timeline-header-row" style={{ height: headerHeight }}>
            <div className="timeline-header-label-cell" style={{ width: effectiveLabelWidth }}>
              <span className="timeline-header-name-label">Name</span>
              {propertyColumns && propertyColumns.length > 0 && (
                <div className="timeline-header-chips">
                  {propertyColumns.map((c) => (
                    <span key={c.key} className="timeline-header-chip-label">
                      {c.label}
                    </span>
                  ))}
                </div>
              )}
              <span
                className="timeline-label-resize-handle"
                onMouseDown={startLabelResize}
                draggable={false}
                onDragStart={(e) => e.preventDefault()}
                title="Drag to resize"
              />
            </div>
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
          {groupedRows
            ? groupedRows.map(([groupName, groupRows]) => {
                const tone = TONE_STYLES[getGroupTone?.(groupRows[0]) ?? "neutral"] ?? TONE_STYLES.neutral;
                return (
                  <div key={`group_${groupName}`}>
                    <div
                      className="timeline-group-row"
                      style={{ height: GROUP_ROW_H, background: tone.bg, color: tone.text }}
                    >
                      <span className="timeline-group-row-label">
                        {groupName}
                        <span style={{ opacity: 0.7, fontWeight: 400 }}> ({groupRows.length})</span>
                      </span>
                    </div>
                    {groupRows.map((row) => renderRow(row))}
                  </div>
                );
              })
            : rows.map((row) => renderRow(row))}
          {rows.length === 0 && <div className="timeline-empty">{emptyLabel}</div>}
          {showToday && rows.length > 0 && (
            <div
              className="timeline-today-line"
              style={{ left: effectiveLabelWidth + todayX, top: headerHeight, height: contentHeight }}
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

const DATE_MODE_OPTIONS: { value: TimelineDateMode; label: string }[] = [
  { value: "range", label: "Start and End Date" },
  { value: "start", label: "Start Date" },
  { value: "due", label: "End Date" },
];

// Small toolbar controls for Timeline: scale stays a 4-way segmented
// button (Day/Week/Month/Quarter), but the date-mode picker (what a bar
// represents) is a labeled "Dates View" dropdown rather than a 3-way
// segmented control -- Sandra asked for a dropdown with an explicit
// header label instead of Range/Start/Due tiles, with wordier option text
// ("Start and End Date" / "Start Date" / "End Date"). The underlying
// TimelineDateMode values (range/start/due) are unchanged; only the label
// and control type differ.
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
      <div className="timeline-datemode" title="What a bar represents">
        <span className="timeline-datemode-label">Dates View</span>
        <select
          className="timeline-datemode-select"
          value={dateMode}
          onChange={(e) => onDateModeChange(e.target.value as TimelineDateMode)}
        >
          {DATE_MODE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}
