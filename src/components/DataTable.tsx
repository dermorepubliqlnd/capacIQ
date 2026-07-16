import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ColumnDef, GroupOption, SortOption, TableView } from "../lib/tableTypes";
import { sortRows, TONE_STYLES } from "../lib/tableTypes";

interface DataTableProps<T> {
  columns: ColumnDef<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  view: TableView;
  onViewChange: (patch: Partial<TableView>) => void;
  groupOptions?: GroupOption<T>[];
  sortOptions?: SortOption<T>[];
  onRowClick?: (row: T) => void;
  emptyLabel?: string;
  footerRow?: (colSpan: number) => ReactNode;
  groupFooterRow?: (colSpan: number, group: { key: string; rows: T[] }) => ReactNode;
}

const MIN_COL_WIDTH = 70;

// Dense, Notion-style data table: drag column headers to reorder, drag the
// right edge to resize, use the Columns menu to hide/show or group, and
// (when groupOptions + view.groupBy are set) rows render as collapsible
// sections instead of a flat list.
export default function DataTable<T>({
  columns,
  rows,
  rowKey,
  view,
  onViewChange,
  groupOptions,
  sortOptions,
  onRowClick,
  emptyLabel = "Nothing here yet.",
  footerRow,
  groupFooterRow,
}: DataTableProps<T>) {
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  const resizeState = useRef<{ key: string; startX: number; startWidth: number } | null>(null);
  const isResizingRef = useRef(false);
  const [, forceRerender] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  // Measure the card's available width so the table can fill it by default
  // (rather than sitting at the bare sum of its column widths, or relying
  // on CSS auto-stretch which broke column alignment — see widthFor below).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setContainerWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const orderedKeys = useMemo(() => {
    const known = columns.map((c) => c.key);
    const ordered = view.columnOrder.filter((k) => known.includes(k));
    const missing = known.filter((k) => !ordered.includes(k));
    return [...ordered, ...missing];
  }, [columns, view.columnOrder]);

  const visibleColumns = orderedKeys
    .filter((k) => !view.hiddenColumns.includes(k))
    .map((k) => columns.find((c) => c.key === k)!)
    .filter(Boolean);

  function widthFor(key: string, def?: number, min?: number, max?: number) {
    const stored = view.columnWidths[key] ?? def ?? 140;
    // Clamp against the column's minWidth so a stale stored width (saved
    // before a minWidth existed, or from a narrower column set) can't make
    // the <td> narrower than the <th> above it — that mismatch is what
    // made row content look like it was "floating" into the next column.
    // Also clamp against maxWidth so a column sized for short content
    // (dates, statuses) can't be dragged out to an unreasonable width.
    const withMin = Math.max(stored, min ?? MIN_COL_WIDTH);
    return max ? Math.min(withMin, max) : withMin;
  }

  // Base (stored/default) width per visible column, before any fill-to-
  // container distribution.
  const baseWidths = useMemo(() => {
    const map: Record<string, number> = {};
    visibleColumns.forEach((c) => {
      map[c.key] = widthFor(c.key, c.defaultWidth, c.minWidth, c.maxWidth);
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleColumns, view.columnWidths]);

  // Fills any leftover width in the card out to the real columns instead of
  // leaving it blank — each column can only grow up to its own maxWidth
  // (a Name column can soak up a lot of extra space; a Status or date
  // column shouldn't), so the fill favors the columns that actually
  // benefit from more room. A CSS-only stretch (table width:100% with
  // table-layout:fixed) was tried first but proportionally stretched EVERY
  // column including ones with fixed pixel widths, breaking alignment; this
  // computes explicit per-column pixel widths instead, so it's exact.
  const filledWidths = useMemo(() => {
    const result = { ...baseWidths };
    if (!containerWidth) return result;
    const totalBase = visibleColumns.reduce((sum, c) => sum + result[c.key], 0);
    let extra = containerWidth - totalBase;
    if (extra <= 0) return result;
    let growable = visibleColumns.filter((c) => !c.maxWidth || result[c.key] < c.maxWidth);
    let guard = 0;
    while (extra > 0.5 && growable.length > 0 && guard < 20) {
      guard++;
      const share = extra / growable.length;
      let used = 0;
      const stillGrowable: typeof growable = [];
      for (const c of growable) {
        const room = c.maxWidth ? c.maxWidth - result[c.key] : Infinity;
        const grant = Math.min(share, room);
        result[c.key] += grant;
        used += grant;
        if (!c.maxWidth || result[c.key] < c.maxWidth - 0.5) stillGrowable.push(c);
      }
      extra -= used;
      growable = stillGrowable;
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseWidths, containerWidth, visibleColumns]);

  function displayWidth(key: string) {
    return filledWidths[key] ?? baseWidths[key] ?? 140;
  }

  function handleDrop(targetKey: string) {
    if (!dragKey || dragKey === targetKey) {
      setDragKey(null);
      return;
    }
    const next = orderedKeys.filter((k) => k !== dragKey);
    const targetIdx = next.indexOf(targetKey);
    next.splice(targetIdx, 0, dragKey);
    onViewChange({ columnOrder: next });
    setDragKey(null);
  }

  function startResize(key: string, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    isResizingRef.current = true;
    const col = columns.find((c) => c.key === key);
    const startWidth = displayWidth(key);
    const minForCol = col?.minWidth ?? MIN_COL_WIDTH;
    const maxForCol = col?.maxWidth;
    resizeState.current = { key, startX: e.clientX, startWidth };

    function onMove(ev: MouseEvent) {
      if (!resizeState.current) return;
      const delta = ev.clientX - resizeState.current.startX;
      let newWidth = Math.max(minForCol, resizeState.current.startWidth + delta);
      if (maxForCol) newWidth = Math.min(newWidth, maxForCol);
      view.columnWidths[resizeState.current.key] = newWidth;
      forceRerender((n) => n + 1);
    }
    function onUp() {
      if (resizeState.current) {
        onViewChange({ columnWidths: { ...view.columnWidths } });
      }
      resizeState.current = null;
      // Small delay so a trailing click/dragstart triggered by the same
      // gesture doesn't briefly re-enter drag-reorder mode.
      setTimeout(() => {
        isResizingRef.current = false;
      }, 0);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  function toggleGroup(name: string) {
    setCollapsedGroups((prev) => (prev.includes(name) ? prev.filter((g) => g !== name) : [...prev, name]));
  }

  const activeGroupOption = groupOptions?.find((g) => g.key === view.groupBy);
  const sortedRows = useMemo(
    () => (sortOptions && view.sorts?.length ? sortRows(rows, view.sorts, sortOptions) : rows),
    [rows, sortOptions, view.sorts]
  );

  const header = (
    <thead>
      <tr className={activeGroupOption ? "is-grouped" : undefined}>
        {visibleColumns.map((c) => (
          <th
            key={c.key}
            draggable
            onDragStart={(e) => {
              if (isResizingRef.current) {
                e.preventDefault();
                return;
              }
              setDragKey(c.key);
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => handleDrop(c.key)}
            style={{
              position: "relative",
              width: displayWidth(c.key),
              maxWidth: displayWidth(c.key),
              minWidth: c.minWidth ?? MIN_COL_WIDTH,
              cursor: "grab",
              userSelect: "none",
              opacity: dragKey === c.key ? 0.4 : 1,
            }}
            title="Drag to reorder"
          >
            {c.label}
            <span
              onMouseDown={(e) => startResize(c.key, e)}
              draggable={false}
              onDragStart={(e) => e.preventDefault()}
              style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 8, cursor: "col-resize", zIndex: 1 }}
            />
          </th>
        ))}
      </tr>
    </thead>
  );

  function renderRow(row: T) {
    return (
      <tr key={rowKey(row)} onClick={() => onRowClick?.(row)} style={{ cursor: onRowClick ? "pointer" : "default" }}>
        {visibleColumns.map((c) => (
          <td
            key={c.key}
            style={{
              width: displayWidth(c.key),
              maxWidth: displayWidth(c.key),
              minWidth: c.minWidth ?? MIN_COL_WIDTH,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {c.render(row)}
          </td>
        ))}
      </tr>
    );
  }

  let body: ReactNode;

  if (sortedRows.length === 0) {
    body = (
      <tbody>
        <tr>
          <td colSpan={visibleColumns.length || 1} style={{ color: "var(--muted)" }}>
            {emptyLabel}
          </td>
        </tr>
      </tbody>
    );
  } else if (activeGroupOption) {
    const groups = new Map<string, T[]>();
    sortedRows.forEach((row) => {
      const g = activeGroupOption.getGroup(row) || "—";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(row);
    });
    const hiddenGroups = view.hiddenGroups ?? [];
    body = (
      <tbody>
        {Array.from(groups.entries())
          .filter(([groupName]) => !hiddenGroups.includes(groupName))
          .map(([groupName, groupRows]) => {
          const collapsed = collapsedGroups.includes(groupName);
          const groupTone = activeGroupOption?.getTone?.(groupRows[0]);
          return (
            <Fragment key={`group_${groupName}`}>
              <tr className="data-table-group-row" onClick={() => toggleGroup(groupName)}>
                <td
                  colSpan={visibleColumns.length || 1}
                  style={{
                    fontWeight: 600,
                    color: groupTone ? TONE_STYLES[groupTone]?.text ?? "var(--navy)" : "var(--navy)",
                    background: groupTone ? TONE_STYLES[groupTone]?.bg ?? "var(--bg)" : "var(--bg)",
                    cursor: "pointer",
                  }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    {groupName}
                    <span style={{ opacity: 0.7, fontWeight: 400 }}>({groupRows.length})</span>
                  </span>
                </td>
              </tr>
              {!collapsed && groupRows.map((row) => renderRow(row))}
              {!collapsed && groupFooterRow && (
                <tr>{groupFooterRow(visibleColumns.length || 1, { key: groupName, rows: groupRows })}</tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    );
  } else {
    body = <tbody>{sortedRows.map((row) => renderRow(row))}</tbody>;
  }

  const footerContent = footerRow ? footerRow(visibleColumns.length || 1) : null;

  return (
    <div ref={containerRef} style={{ width: "100%" }}>
      <table className="data-table" style={{ tableLayout: "fixed" }}>
        {header}
        {body}
        {footerContent != null && (
          <tfoot>
            <tr>{footerContent}</tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

