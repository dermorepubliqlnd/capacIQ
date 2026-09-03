import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, GripVertical, Pin, PinOff } from "lucide-react";
import type { ColumnDef, GroupOption, SortOption, TableView } from "../lib/tableTypes";
import { sortRows, sortRowsHierarchical, resolveTone } from "../lib/tableTypes";

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
  // Shift-click range-select (see lastSelectedKeyRef below) -- replaces
  // the current selection with exactly this contiguous range, matching
  // the usual file-explorer/spreadsheet convention.
  onSelectRange?: (keys: string[]) => void;
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
  // When set (alongside rowKey), sorting stays hierarchy-aware: a parent
  // and all its descendants stay grouped together, with the active sort
  // applied at each sibling level instead of flattening the whole list.
  // Only Tasks (which have sub-tasks) pass this -- Projects has no
  // parent/child relationship so it keeps the plain flat sort.
  getParentId?: (row: T) => string | null | undefined;
  // Sandra ("what i meant was the collapse and expand in the projects and
  // list groupings"): when set, the Collapse all/Expand all group toggle
  // portals into this DOM node (the ViewFilterPills row) instead of
  // rendering in its own row above the table, so it sits visually with
  // the Grouped by/Sorted by pills. Falls back to the old standalone row
  // when omitted -- no caller is forced to wire this up.
  collapseAllContainer?: HTMLElement | null;
}

// ~1.3cm at 96dpi -- narrow enough for icon-only columns, but still a
// readable floor for text columns when a max width no longer applies.
// Raised from 38 (2026-09-03, Sandra: headers were overlapping at the old
// floor) alongside the header-label ellipsis fix below -- the ellipsis
// alone stops the visual overlap, but 38px left no room at all for the
// resize-handle padding, so labels still felt cramped right up against
// the next column.
const MIN_COL_WIDTH = 48;
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
  getParentId,
  selectable,
  selectedKeys,
  onToggleSelect,
  onToggleSelectAll,
  onSelectRange,
  orderable,
  compactGutter,
  onReorder,
  collapseAllContainer,
}: DataTableProps<T>) {
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dragRowKey, setDragRowKey] = useState<string | null>(null);
  const lastSelectedKeyRef = useRef<string | null>(null);
  const [dragOverRowKey, setDragOverRowKey] = useState<string | null>(null);
  // Persisted per-user, per-view (2026-08-26, Sandra: "the task list
  // defaults to expanded view every time there's a refresh, can the
  // system remember the last setting or view selected by the user?") --
  // deliberately localStorage, NOT part of the shared `view` record: a
  // TableView is saved to Supabase and shared across the whole team (see
  // TableView's own doc comment on filterAssignedToMe/etc.), so writing
  // collapse state there would leak one person's expand/collapse choice
  // to everyone else looking at the same view. Keyed by view.id so
  // different saved views (and different grouped tables using this same
  // component) each remember their own state independently.
  const collapsedGroupsStorageKey = `capaciq_datatable_collapsed_groups_${view.id}`;
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(collapsedGroupsStorageKey);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });
  function persistCollapsedGroups(next: string[]) {
    setCollapsedGroups(next);
    try {
      localStorage.setItem(collapsedGroupsStorageKey, JSON.stringify(next));
    } catch {
      // ignore -- private browsing / storage full, still works for the
      // rest of this session, it just won't persist across refreshes
    }
  }
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
    .filter((k) => {
      const col = columns.find((c) => c.key === k);
      return col?.alwaysVisible || !view.hiddenColumns.includes(k);
    })
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

  // Sandra, 2026-09-03 ("enable column/pane locking -- right click to
  // select freeze pane"): classic spreadsheet freeze-pane, keyed off
  // view.frozenUpTo (the last column meant to stay put). frozenUpToIndex
  // is -1 whenever nothing's frozen, OR the saved key no longer matches a
  // currently-visible column (hidden/removed since) -- either way nothing
  // renders sticky, no special-casing needed at the render sites below.
  const frozenUpToIndex = view.frozenUpTo ? visibleColumns.findIndex((c) => c.key === view.frozenUpTo) : -1;
  // Left offset (px) for each frozen column's sticky position -- gutter
  // width first (checkbox/grip column, if this table has one), then each
  // frozen column's own width accumulated in order. Body <td> and header
  // <th> share this so the two rows of sticky cells always line up.
  const frozenLeftByKey = useMemo(() => {
    const map: Record<string, number> = {};
    if (frozenUpToIndex < 0) return map;
    let acc = hasGutter ? gutterWidth : 0;
    for (let i = 0; i <= frozenUpToIndex; i++) {
      const key = visibleColumns[i].key;
      map[key] = acc;
      acc += displayWidth(key);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frozenUpToIndex, visibleColumns, hasGutter, gutterWidth, baseWidths]);

  // Right-click context menu for freezing/unfreezing -- opened from a
  // column header's onContextMenu (see the header <th> below), positioned
  // at the click point like a native OS context menu rather than
  // reusing IconPopoverButton's anchored-to-trigger layout.
  const [colContextMenu, setColContextMenu] = useState<{ x: number; y: number; key: string } | null>(null);
  const colContextMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!colContextMenu) return;
    function onDocClick(e: MouseEvent) {
      if (colContextMenuRef.current?.contains(e.target as Node)) return;
      setColContextMenu(null);
    }
    function onEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setColContextMenu(null);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEscape);
    };
  }, [colContextMenu]);

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
    persistCollapsedGroups(collapsedGroups.includes(name) ? collapsedGroups.filter((g) => g !== name) : [...collapsedGroups, name]);
  }

  const activeGroupOption = groupOptions?.find((g) => g.key === view.groupBy);
  const sortedRows = useMemo(() => {
    if (!sortOptions || !view.sorts?.length) return rows;
    return getParentId
      ? sortRowsHierarchical(rows, view.sorts, sortOptions, rowKey, getParentId)
      : sortRows(rows, view.sorts, sortOptions);
  }, [rows, sortOptions, view.sorts, getParentId, rowKey]);

  // Names of every group section actually rendered right now (mirrors the
  // group-building logic in the `activeGroupOption` render branch below,
  // kept separate so the Collapse all/Expand all control -- Sandra:
  // "put a collapse all and expand all quick button somewhere in each
  // section when grouping are applied... helpful in case it's a long list
  // already" -- can know the full set of group names without needing the
  // render branch to run first. Excludes hidden groups (Show/Hide-all in
  // the Group-by popover), since there's nothing to collapse/expand there.
  const visibleGroupNames = useMemo(() => {
    if (!activeGroupOption) return [];
    const names = new Set<string>();
    activeGroupOption.allGroups?.().forEach((g) => names.add(g));
    sortedRows.forEach((row) => names.add(activeGroupOption.getGroup(row) || "—"));
    const hiddenGroups = view.hiddenGroups ?? [];
    return Array.from(names).filter((n) => !hiddenGroups.includes(n));
  }, [activeGroupOption, sortedRows, view.hiddenGroups]);

  const allGroupsCollapsed = visibleGroupNames.length > 0 && visibleGroupNames.every((n) => collapsedGroups.includes(n));

  function toggleAllGroups() {
    persistCollapsedGroups(
      allGroupsCollapsed
        ? collapsedGroups.filter((g) => !visibleGroupNames.includes(g))
        : Array.from(new Set([...collapsedGroups, ...visibleGroupNames]))
    );
  }

  const colSpanTotal = (visibleColumns.length || 1) + (hasGutter ? 1 : 0);

  const header = (
    <thead>
      <tr className={activeGroupOption ? "is-grouped" : undefined}>
        {hasGutter && (
          // Select-all was removed from the header (Sandra: not needed) --
          // individual row checkboxes still work below, this is just an
          // empty spacer cell kept for gutter-column alignment. Sticks to
          // the left edge too whenever any real column is frozen, since
          // it physically sits in front of them.
          <th
            className={frozenUpToIndex >= 0 ? "data-table-frozen-cell" : undefined}
            style={{
              width: gutterWidth,
              minWidth: gutterWidth,
              maxWidth: gutterWidth,
              padding: 0,
              position: frozenUpToIndex >= 0 ? "sticky" : undefined,
              left: frozenUpToIndex >= 0 ? 0 : undefined,
              zIndex: frozenUpToIndex >= 0 ? 3 : undefined,
            }}
          />
        )}
        {visibleColumns.map((c) => {
          const frozenLeft = frozenLeftByKey[c.key];
          const isFrozen = frozenLeft !== undefined;
          const isLastFrozen = frozenUpToIndex >= 0 && c.key === visibleColumns[frozenUpToIndex]?.key;
          return (
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
            onContextMenu={(e) => {
              e.preventDefault();
              setColContextMenu({ x: e.clientX, y: e.clientY, key: c.key });
            }}
            className={isFrozen ? "data-table-frozen-cell" : undefined}
            style={{
              position: isFrozen ? "sticky" : "relative",
              left: isFrozen ? frozenLeft : undefined,
              zIndex: isFrozen ? 2 : undefined,
              boxShadow: isLastFrozen ? "2px 0 6px -2px rgba(0,0,0,0.18)" : undefined,
              width: displayWidth(c.key),
              maxWidth: displayWidth(c.key),
              minWidth: c.minWidth ?? MIN_COL_WIDTH,
              cursor: "grab",
              userSelect: "none",
              opacity: dragKey === c.key ? 0.4 : 1,
            }}
            title="Drag to reorder · right-click to freeze"
          >
            <span
              style={{
                display: "block",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                // Leave a little breathing room before the resize handle
                // (Sandra, 2026-09-03: headers were overlapping when
                // columns were resized narrow) so an ellipsized label
                // never sits flush against the next column's edge.
                paddingRight: 10,
              }}
            >
              {c.label}
            </span>
            <span
              onMouseDown={(e) => startResize(c.key, e)}
              draggable={false}
              onDragStart={(e) => e.preventDefault()}
              style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 8, cursor: "col-resize", zIndex: 1 }}
            />
          </th>
          );
        })}
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
          <td
            className={`row-gutter-cell${frozenUpToIndex >= 0 ? " data-table-frozen-cell" : ""}`}
            style={{
              width: gutterWidth,
              minWidth: gutterWidth,
              maxWidth: gutterWidth,
              position: frozenUpToIndex >= 0 ? "sticky" : undefined,
              left: frozenUpToIndex >= 0 ? 0 : undefined,
              zIndex: frozenUpToIndex >= 0 ? 2 : undefined,
            }}
            onClick={(e) => e.stopPropagation()}
          >
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
                <input
                  type="checkbox"
                  className="row-checkbox"
                  checked={isSelected}
                  onChange={() => {}}
                  onClick={(e) => {
                    // Standard shift/ctrl multi-select gestures (Sandra,
                    // 2026-08-26). Shift-click selects the contiguous
                    // range between the last plain/ctrl click and this
                    // row, in the table's current sorted/grouped order --
                    // sortedRows is exactly that order, so no separate
                    // "visible keys" list is needed. Ctrl/Cmd-click is
                    // just this table's existing per-row toggle (a
                    // checkbox already only ever affects its own row), so
                    // it needs no special handling beyond not being
                    // treated as a range anchor reset oddly.
                    if (e.shiftKey && lastSelectedKeyRef.current && onSelectRange) {
                      const keys = sortedRows.map((r) => rowKey(r));
                      const from = keys.indexOf(lastSelectedKeyRef.current);
                      const to = keys.indexOf(key);
                      if (from !== -1 && to !== -1) {
                        const [start, end] = from < to ? [from, to] : [to, from];
                        onSelectRange(keys.slice(start, end + 1));
                        return;
                      }
                    }
                    lastSelectedKeyRef.current = key;
                    onToggleSelect?.(key);
                  }}
                />
              )}
            </div>
          </td>
        )}
        {visibleColumns.map((c) => {
          const frozenLeft = frozenLeftByKey[c.key];
          const isFrozen = frozenLeft !== undefined;
          const isLastFrozen = frozenUpToIndex >= 0 && c.key === visibleColumns[frozenUpToIndex]?.key;
          return (
          <td
            key={c.key}
            className={isFrozen ? "data-table-frozen-cell" : undefined}
            style={{
              position: isFrozen ? "sticky" : undefined,
              left: isFrozen ? frozenLeft : undefined,
              zIndex: isFrozen ? 1 : undefined,
              boxShadow: isLastFrozen ? "2px 0 6px -2px rgba(0,0,0,0.18)" : undefined,
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
          );
        })}
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
          // Bugfix (2026-08-26, Sandra: "Projects List -- Grouping has a
          // bug. Leading to a blank page"): allGroups() above pre-seeds
          // every canonical value (e.g. every Status option) as an empty
          // group even when zero current rows have that value -- normal
          // whenever a small dataset doesn't cover every possible value.
          // getTone(groupRows[0]) was called unconditionally, so any
          // empty group crashed the whole table (and the page, since
          // nothing caught it) on `p.status`-style property access
          // against `undefined`. Only compute a tone when the group
          // actually has a row to derive it from.
          const groupTone = groupRows.length > 0 ? activeGroupOption?.getTone?.(groupRows[0]) : undefined;
          const resolvedTone = resolveTone(groupTone);
          return (
            <Fragment key={`group_${groupName}`}>
              <tr className="data-table-group-row" onClick={() => toggleGroup(groupName)}>
                <td
                  colSpan={colSpanTotal}
                  style={{
                    fontWeight: 600,
                    color: resolvedTone?.text ?? "var(--navy)",
                    background: resolvedTone?.bg ?? "var(--bg)",
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

  const collapseAllButton =
    activeGroupOption && visibleGroupNames.length > 0 ? (
      <button
        onClick={toggleAllGroups}
        style={{
          fontSize: 11,
          fontWeight: 500,
          color: "var(--accent)",
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: "2px 4px",
          marginLeft: collapseAllContainer ? "auto" : undefined,
        }}
      >
        {allGroupsCollapsed ? "Expand all" : "Collapse all"}
      </button>
    ) : null;

  return (
    <div>
      {collapseAllButton &&
        (collapseAllContainer ? (
          createPortal(collapseAllButton, collapseAllContainer)
        ) : (
          <div style={{ display: "flex", justifyContent: "flex-end", padding: "0 2px 4px" }}>{collapseAllButton}</div>
        ))}
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
      {colContextMenu &&
        createPortal(
          <div
            ref={colContextMenuRef}
            className="toolbar-popover"
            style={{ position: "fixed", top: colContextMenu.y, left: colContextMenu.x, width: 190, padding: 4 }}
          >
            <button
              className="data-table-context-menu-item"
              onClick={() => {
                onViewChange({ frozenUpTo: colContextMenu.key });
                setColContextMenu(null);
              }}
            >
              <Pin size={12} />
              Freeze up to here
            </button>
            {view.frozenUpTo && (
              <button
                className="data-table-context-menu-item"
                onClick={() => {
                  onViewChange({ frozenUpTo: null });
                  setColContextMenu(null);
                }}
              >
                <PinOff size={12} />
                Unfreeze columns
              </button>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}
