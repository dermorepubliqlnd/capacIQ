import { Fragment, useMemo, useRef, useState, type ReactNode } from "react";
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

  function widthFor(key: string, def?: number, min?: number) {
    const stored = view.columnWidths[key] ?? def ?? 140;
    // Clamp against the column's minWidth so a stale stored width (saved
    // before a minWidth existed, or from a narrower column set) can't make
    // the <td> narrower than the <th> above it — that mismatch is what
    // made row content look like it was "floating" into the next column.
    return Math.max(stored, min ?? MIN_COL_WIDTH);
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
    const startWidth = widthFor(key, col?.defaultWidth, col?.minWidth);
    const minForCol = col?.minWidth ?? MIN_COL_WIDTH;
    resizeState.current = { key, startX: e.clientX, startWidth };

    function onMove(ev: MouseEvent) {
      if (!resizeState.current) return;
      const delta = ev.clientX - resizeState.current.startX;
      const newWidth = Math.max(minForCol, resizeState.current.startWidth + delta);
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
              width: widthFor(c.key, c.defaultWidth, c.minWidth),
              maxWidth: widthFor(c.key, c.defaultWidth, c.minWidth),
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
              width: widthFor(c.key, c.defaultWidth, c.minWidth),
              maxWidth: widthFor(c.key, c.defaultWidth, c.minWidth),
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
    <table className="data-table" style={{ tableLayout: "fixed" }}>
      {header}
      {body}
      {footerContent != null && (
        <tfoot>
          <tr>{footerContent}</tr>
        </tfoot>
      )}
    </table>
  );
}

