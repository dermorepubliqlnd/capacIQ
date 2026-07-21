import { Fragment, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, GripVertical } from "lucide-react";
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
  // Row-selection (checkbox) + bulk-action support. When selectable is set,
  // a hover-revealed checkbox appears in a leading gutter column; selected
  // rows keep it visible even without hover so selection stays legible.
  selectable?: boolean;
  selectedKeys?: string[];
  onToggleSelect?: (key: string) => void;
  onToggleSelectAll?: (visibleKeys: string[]) => void;
  // Drag-to-reorder via a grip handle in the same gutter column. Dropping a
  // dragged row onto another inserts it immediately before the target --
  // the caller (Projects.tsx) is responsible for persisting the new order
  // and for warning/clearing an active sort first.
  orderable?: boolean;
  onReorder?: (draggedKey: string, targetKey: string) => void;
  // Tasks has no per-row icon (Projects does, via its own name-column
  // render), so its gutter can sit tighter to the first column than
  // Projects' -- shaves the shared paddingLeft down without touching
  // Projects' gutter at all.
  compactGutter?: boolean;
}

// ~1cm at 96dpi -- narrow enough for icon-only columns, but still a
// readable floor for text columns when a max width no longer applies.
const MIN_COL_WIDTH = 38;
// Fixed width of the leading checkbox/grip gutter column -- not
// resizable or draggable like the real data columns.
const GUTTER_WIDTH = 46;

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
  selectable,
  selectedKeys,
  onToggleSelect,
  onToggleSelectAll,
  orderable,
  compactGutter,
  onReorder,
}: DataTableProps<T>) {
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dragRowKey, setDragRowKey] = useState<string | null>(null);
  const [dragOverRowKey, setDragOverRowKey] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  const resizeState = useRef<{ key: string; startX: number; startWidth: number } | null>(null);
  const isResizingRef = useRef(false);
  const [, forceRerender] = useState(0);

  const hasGutter = Boolean(selectable || orderable);
  // Tasks passes compactGutter (no per-row icon to make room for);
  // Projects doesn't, so its gutter is unchanged.
  const gutterWidth = compactGutter ? GUTTER_WIDTH - 10 : GUTTER_WIDTH;
  const gutterPadding = compactGutter ? 4 : 8;

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
    // No upper clamp: columns can be dragged as wide as the user wants:
    // when the table's total width exceeds the card, the table container
    // scrolls horizontally instead (see the wrapping div below) rather than
    // forcing columns to shrink or stretch to fit.
    return Math.max(stored, min ?? MIN_COL_WIDTH);
  }

  // Each column's actual (stored/default) width -- the table is never
  // stretched or shrunk to fill the container; if it's narrower than the
  // card, the leftover space is just blank, and if it's wider, the
  // container scrolls (Notion does the same rather than distorting columns
  // to fit the window).
  const baseWidths = useMemo(() => {
    const map: Record<string, number> = {};
    visibleColumns.forEach((c) => {
      map[c.key] = widthFor(c.key, c.defaultWidth, c.minWidth);
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleColumns, view.columnWidths]);

  function displayWidth(key: string) {
    return baseWidths[key] ?? 140;
  }

  // table-layout:fixed only makes columns keep their literal pixel widths
  // when the <table> itself has an explicit total width -- left as "auto"
  // (or 100%), the browser instead treats each column's width as a mere
  // proportion within whatever width the table resolves to (a plain block
  // box, which fills its container), so a column dragged wider than the
  // container was getting silently squeezed back down instead of causing
  // overflow. Setting the table's own width to the exact sum of its visible
  // columns is what makes the wrapping div's overflow-x:auto (below) able
  // to kick in.
  const totalWidth = useMemo(
    () => visibleColumns.reduce((sum, c) => sum + displayWidth(c.key), 0) + (hasGutter ? gutterWidth : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleColumns, baseWidths, hasGutter, gutterWidth]
  );

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

  const colSpanTotal = (visibleColumns.length || 1) + (hasGutter ? 1 : 0);
  const allVisibleKeys = sortedRows.map(rowKey);
  const allSelected = Boolean(hasGutter && selectable && allVisibleKeys.length > 0 && allVisibleKeys.every((k) => selectedKeys?.includes(k)));
  const someSelected = Boolean(hasGutter && selectable && allVisibleKeys.some((k) => selectedKeys?.includes(k)));

  const header = (
    <thead>
      <tr className={activeGroupOption ? "is-grouped" : undefined}>
        {hasGutter && (
          <th style={{ width: gutterWidth, minWidth: gutterWidth, maxWidth: gutterWidth, padding: 0 }}>
            {selectable && (
              // Matches the body row's gutter layout exactly (an invisible
              // spacer standing in for the grip handle's width + gap) so
              // the header checkbox lines up with the ones below it,
              // instead of sitting flush against the column's left edge.
              <div style={{ display: "flex", alignItems: "center", gap: 2, paddingLeft: gutterPadding }}>
                <span style={{ display: "inline-block", width: 16, flexShrink: 0 }} />
                <input
                  type="checkbox"
                  className="row-checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = !allSelected && someSelected;
                  }}
                  onChange={() => onToggleSelectAll?.(allVisibleKeys)}
                />
              </div>
            )}
          </th>
        )}
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
    const key = rowKey(row);
    const isSelected = Boolean(selectable && selectedKeys?.includes(key));
    return (
      <tr
        key={key}
        onClick={() => onRowClick?.(row)}
        className={[
          isSelected ? "row-selected" : undefined,
          orderable && dragOverRowKey === key && dragRowKey !== key ? "row-drop-target" : undefined,
        ]
          .filter(Boolean)
          .join(" ") || undefined}
        style={{ cursor: onRowClick ? "pointer" : "default" }}
        onDragOver={
          orderable
            ? (e) => {
                e.preventDefault();
                if (dragOverRowKey !== key) setDragOverRowKey(key);
              }
            : undefined
        }
        onDragLeave={orderable ? () => setDragOverRowKey((prev) => (prev === key ? null : prev)) : undefined}
        onDrop={
          orderable
            ? () => {
                if (dragRowKey && dragRowKey !== key) onReorder?.(dragRowKey, key);
                setDragRowKey(null);
                setDragOverRowKey(null);
              }
            : undefined
        }
      >
        {hasGutter && (
          <td className="row-gutter-cell" style={{ width: gutterWidth, minWidth: gutterWidth, maxWidth: gutterWidth }} onClick={(e) => e.stopPropagation()}>
            <div className="row-gutter-inner" style={{ paddingLeft: gutterPadding }}>
              {orderable && (
                <span
                  className="row-grip-btn"
                  draggable
                  onDragStart={() => setDragRowKey(key)}
                  onDragEnd={() => {
                    setDragRowKey(null);
                    setDragOverRowKey(null);
                  }}
                  title="Drag to reorder"
                >
                  <GripVertical size={13} />
                </span>
              )}
              {selectable && (
                <input type="checkbox" className="row-checkbox" checked={isSelected} onChange={() => onToggleSelect?.(key)} />
              )}
            </div>
          </td>
        )}
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
          <td colSpan={colSpanTotal} style={{ color: "var(--muted)" }}>
            {emptyLabel}
          </td>
        </tr>
      </tbody>
    );
  } else if (activeGroupOption) {
    const groups = new Map<string, T[]>();
    activeGroupOption.allGroups?.().forEach((g) => {
      if (!groups.has(g)) groups.set(g, []);
    });
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
                  colSpan={colSpanTotal}
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
                <tr>{groupFooterRow(colSpanTotal, { key: groupName, rows: groupRows })}</tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    );
  } else {
    body = <tbody>{sortedRows.map((row) => renderRow(row))}</tbody>;
  }

  const footerContent = footerRow ? footerRow(colSpanTotal) : null;

  return (
    <div style={{ width: "100%", overflowX: "auto", overflowY: "visible" }}>
      <table className="data-table" style={{ tableLayout: "fixed", width: totalWidth }}>
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
