import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowUpDown, Layers, SlidersHorizontal, Filter, Eye, EyeOff, ArrowUp, ArrowDown, Plus, Trash2, X } from "lucide-react";
import type { ColumnDef, GroupOption, SortOption, SortRule } from "../lib/tableTypes";

interface ViewControlsProps<T> {
  rows: T[];
  columns: ColumnDef<T>[];
  hiddenColumns: string[];
  onToggleColumn: (key: string) => void;
  groupOptions: GroupOption<T>[];
  groupBy: string | null;
  hiddenGroups: string[];
  onGroupByChange: (key: string | null) => void;
  onHiddenGroupsChange: (hidden: string[]) => void;
  showCount: boolean;
  onShowCountChange: (value: boolean) => void;
  sortOptions: SortOption<T>[];
  sorts: SortRule[];
  onSortsChange: (sorts: SortRule[]) => void;
  // True on Board views: a Kanban board can't render without columns, so
  // "No filter" (ungrouped) is disabled here even though grouping is
  // otherwise free to be any boardGroupable field -- unlike the old v1
  // behavior, the field itself is no longer locked to Status.
  isBoard?: boolean;
  // True on Timeline views: a Gantt row list has no use for grouping in
  // this v1, so the whole Group-by control is disabled (greyed out with
  // a tooltip) rather than just constrained like Board's isBoard above.
  groupByDisabled?: boolean;
  // Row-level Filter (assigned-to-me + status multi-select) -- unlike
  // Sort/Group-by/Properties, this isn't view-rendering config: it's
  // applied to the shared row list *before* Table/Board/Timeline ever
  // see it, so the same filter holds no matter which view type is active.
  filterAssignedToMe: boolean;
  onFilterAssignedToMeChange: (value: boolean) => void;
  statusOptions: string[];
  filterStatuses: string[];
  onFilterStatusesChange: (statuses: string[]) => void;
}

// A single borderless, Notion-style icon trigger + anchored popover. No box
// or border at rest -- just an icon that tints on hover, and gets a filled
// background + small dot while its config is active, matching Notion's own
// view toolbar (Sort / Filter / Properties as separate quick icons instead
// of one combined gear menu).
//
// The popover itself is portaled to document.body and positioned with
// `position: fixed` from the trigger button's own bounding rect, rather
// than rendered in-place with `position: absolute` inside a `position:
// relative` wrapper. The in-place approach silently breaks whenever the
// trigger sits inside a `position: sticky` ancestor (e.g. the Projects
// page's `.sticky-toolbar-cluster`): the sticky ancestor establishes its
// own stacking context, so the popover's z-index only gets compared
// against siblings *within* that context and can't paint above unrelated
// later DOM content (this is exactly what caused the Properties popover to
// render clipped under the Tasks table below it). Portaling to
// document.body escapes that stacking context entirely.
function IconPopoverButton({
  icon,
  label,
  active,
  width = 240,
  children,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  width?: number;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      // The popover is portaled outside triggerRef's DOM subtree, so the
      // old single `ref.current.contains(...)` check no longer covers it --
      // a click has to miss *both* the trigger and the portaled popover to
      // count as "outside".
      if (triggerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  // Recompute position whenever the popover opens. Anchored to the
  // trigger's bottom-left by default, right-aligned to the trigger's right
  // edge (matching the old in-place `right: 0` look), and flipped back
  // toward the left edge of the viewport if that would overflow off
  // either side. Doesn't track scroll/resize while open -- not needed for
  // this pass since these are short-lived toolbar popovers.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    let left = rect.right - width;
    if (left < 4) left = Math.max(4, rect.left);
    if (left + width > viewportWidth - 4) left = Math.max(4, viewportWidth - width - 4);
    setPos({ top: rect.bottom + 4, left });
  }, [open, width]);

  return (
    <>
      <button
        ref={triggerRef}
        className={`toolbar-icon-btn${open || active ? " active" : ""}`}
        title={label}
        onClick={() => setOpen((v) => !v)}
      >
        {icon}
        {active && <span className="toolbar-icon-dot" />}
      </button>
      {open &&
        createPortal(
          <div
            ref={popoverRef}
            className="toolbar-popover"
            style={{ top: pos.top, left: pos.left, width }}
            onClick={(e) => e.stopPropagation()}
          >
            {children(() => setOpen(false))}
          </div>,
          document.body
        )}
    </>
  );
}

function PopoverHeader({ label, onClose }: { label: string; onClose: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
      <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--navy)" }}>{label}</span>
      <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", display: "flex" }}>
        <X size={13} />
      </button>
    </div>
  );
}

// Four quick-access toolbar icons (Filter, Sort, Group by, Properties)
// mirroring Notion's own view toolbar layout. Meant to be rendered inside a
// ".toolbar-actions" wrapper alongside any other per-page icon buttons
// (e.g. Task Effort colors).
export default function ViewSettingsMenu<T>({
  rows,
  columns,
  hiddenColumns,
  onToggleColumn,
  groupOptions,
  groupBy,
  hiddenGroups,
  onGroupByChange,
  onHiddenGroupsChange,
  showCount,
  onShowCountChange,
  sortOptions,
  sorts,
  onSortsChange,
  isBoard,
  groupByDisabled,
  filterAssignedToMe,
  onFilterAssignedToMeChange,
  statusOptions,
  filterStatuses,
  onFilterStatusesChange,
}: ViewControlsProps<T>) {
  const activeOption = groupOptions.find((g) => g.key === groupBy);
  const groupValues = activeOption
    ? Array.from(new Set(rows.map((r) => activeOption.getGroup(r)))).sort((a, b) => a.localeCompare(b))
    : [];

  function toggleGroupVisible(name: string) {
    onHiddenGroupsChange(hiddenGroups.includes(name) ? hiddenGroups.filter((g) => g !== name) : [...hiddenGroups, name]);
  }

  function toggleFilterStatus(value: string) {
    onFilterStatusesChange(filterStatuses.includes(value) ? filterStatuses.filter((s) => s !== value) : [...filterStatuses, value]);
  }

  const usedKeys = new Set(sorts.map((s) => s.key));
  const availableToAdd = sortOptions.filter((o) => !usedKeys.has(o.key));

  function addSort() {
    if (availableToAdd.length === 0) return;
    onSortsChange([...sorts, { key: availableToAdd[0].key, direction: "asc" }]);
  }
  function updateSort(idx: number, patch: Partial<SortRule>) {
    onSortsChange(sorts.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  }
  function removeSort(idx: number) {
    onSortsChange(sorts.filter((_, i) => i !== idx));
  }
  function moveSort(idx: number, dir: -1 | 1) {
    const next = [...sorts];
    const target = idx + dir;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    onSortsChange(next);
  }

  return (
    <>
      <IconPopoverButton icon={<Filter size={13} />} label="Filter" active={filterAssignedToMe || filterStatuses.length > 0} width={200}>
        {(close) => (
          <>
            <PopoverHeader label="Filter" onClose={close} />
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, padding: "3px 2px", cursor: "pointer", marginBottom: 6 }}>
              <input type="checkbox" checked={filterAssignedToMe} onChange={(e) => onFilterAssignedToMeChange(e.target.checked)} />
              Assigned to me
            </label>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3, color: "var(--muted)", marginBottom: 4 }}>
              Status
            </div>
            <div style={{ maxHeight: 160, overflowY: "auto" }}>
              {statusOptions.map((s) => (
                <label key={s} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, padding: "3px 2px", cursor: "pointer" }}>
                  <input type="checkbox" checked={filterStatuses.includes(s)} onChange={() => toggleFilterStatus(s)} />
                  {s}
                </label>
              ))}
            </div>
          </>
        )}
      </IconPopoverButton>

      <IconPopoverButton icon={<ArrowUpDown size={13} />} label="Sort" active={sorts.length > 0}>
        {(close) => (
          <>
            <PopoverHeader label="Sort" onClose={close} />
            {sorts.length === 0 && <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>No sorting applied</div>}
            {sorts.map((s, idx) => {
              const option = sortOptions.find((o) => o.key === s.key);
              return (
                <div key={`${s.key}_${idx}`} style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
                  <span style={{ fontSize: 10, color: "var(--muted)", width: 12 }}>{idx + 1}.</span>
                  <select
                    value={s.key}
                    onChange={(e) => updateSort(idx, { key: e.target.value })}
                    style={{ flex: 1, fontSize: 11.5, padding: "4px 4px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}
                  >
                    <option value={s.key}>{option?.label ?? s.key}</option>
                    {availableToAdd.map((o) => (
                      <option key={o.key} value={o.key}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => updateSort(idx, { direction: s.direction === "asc" ? "desc" : "asc" })}
                    title={s.direction === "asc" ? "Ascending" : "Descending"}
                    style={{ display: "flex", alignItems: "center", background: "none", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", cursor: "pointer", padding: 4, color: "var(--text-secondary)" }}
                  >
                    {s.direction === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
                  </button>
                  <button
                    onClick={() => moveSort(idx, -1)}
                    disabled={idx === 0}
                    title="Move up (higher priority)"
                    style={{ display: "flex", alignItems: "center", background: "none", border: "none", cursor: idx === 0 ? "default" : "pointer", padding: 2, color: idx === 0 ? "var(--border)" : "var(--muted)" }}
                  >
                    <ArrowUp size={11} />
                  </button>
                  <button
                    onClick={() => moveSort(idx, 1)}
                    disabled={idx === sorts.length - 1}
                    title="Move down (lower priority)"
                    style={{ display: "flex", alignItems: "center", background: "none", border: "none", cursor: idx === sorts.length - 1 ? "default" : "pointer", padding: 2, color: idx === sorts.length - 1 ? "var(--border)" : "var(--muted)" }}
                  >
                    <ArrowDown size={11} />
                  </button>
                  <button
                    onClick={() => removeSort(idx)}
                    title="Remove sort"
                    style={{ display: "flex", alignItems: "center", background: "none", border: "none", cursor: "pointer", padding: 2, color: "var(--muted)" }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })}
            {sorts.length > 1 && (
              <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 6 }}>Rule 1 sorts first; the rest break ties in order.</div>
            )}
            {availableToAdd.length > 0 && (
              <button
                onClick={addSort}
                style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--accent)", background: "none", border: "none", cursor: "pointer", padding: "4px 0 0" }}
              >
                <Plus size={12} />
                Add sort
              </button>
            )}
          </>
        )}
      </IconPopoverButton>

      {groupByDisabled ? (
        <button
          className="toolbar-icon-btn"
          disabled
          title="Group-by isn't available for Timeline views"
          style={{ opacity: 0.4, cursor: "not-allowed" }}
        >
          <Layers size={13} />
        </button>
      ) : (
      <IconPopoverButton icon={<Layers size={13} />} label="Group by" active={Boolean(groupBy)}>
        {(close) => (
          <>
            <PopoverHeader label="Group by" onClose={close} />
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3, color: "var(--muted)", marginBottom: 4 }}>
              Group by
            </div>
            <select
              value={groupBy ?? ""}
              onChange={(e) => onGroupByChange(e.target.value || null)}
              style={{
                width: "100%",
                fontSize: 11.5,
                padding: "5px 6px",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm)",
                marginBottom: activeOption ? 8 : 0,
              }}
            >
              <option value="" disabled={isBoard} title={isBoard ? "A board needs a property to group into columns" : undefined}>
                No filter
              </option>
              {groupOptions.map((g) => {
                const disabled = isBoard && g.boardGroupable === false;
                return (
                  <option key={g.key} value={g.key} disabled={disabled} title={disabled ? "Not available for Board -- values aren't a fixed set of columns" : undefined}>
                    {g.label}
                    {disabled ? " (not available on Board)" : ""}
                  </option>
                );
              })}
            </select>

            {activeOption && groupValues.length > 0 && (
              <>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 10, color: "var(--muted)" }}>Show</span>
                  <button
                    onClick={() => onHiddenGroupsChange(hiddenGroups.length === groupValues.length ? [] : groupValues)}
                    style={{ fontSize: 10.5, color: "var(--accent)", background: "none", border: "none", cursor: "pointer" }}
                  >
                    {hiddenGroups.length === groupValues.length ? "Show all" : "Hide all"}
                  </button>
                </div>
                <div style={{ maxHeight: 140, overflowY: "auto" }}>
                  {groupValues.map((g) => {
                    const hidden = hiddenGroups.includes(g);
                    return (
                      <div
                        key={g}
                        onClick={() => toggleGroupVisible(g)}
                        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, padding: "3px 2px", fontSize: 12, color: hidden ? "var(--muted)" : "var(--text)", cursor: "pointer" }}
                      >
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g}</span>
                        {hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginTop: 6, cursor: "pointer" }}>
              <input type="checkbox" checked={showCount} onChange={(e) => onShowCountChange(e.target.checked)} />
              Show count in this view's tab
            </label>
          </>
        )}
      </IconPopoverButton>
      )}

      <IconPopoverButton icon={<SlidersHorizontal size={13} />} label="Properties" active={hiddenColumns.length > 0} width={220}>
        {(close) => (
          <>
            <PopoverHeader label="Properties" onClose={close} />
            {columns.map((c) => (
              <label
                key={c.key}
                title={c.alwaysVisible ? "Always shown -- this is a computed value, not a free-typed one" : undefined}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 12,
                  padding: "3px 2px",
                  cursor: c.alwaysVisible ? "default" : "pointer",
                  color: c.alwaysVisible ? "var(--muted)" : undefined,
                }}
              >
                <input
                  type="checkbox"
                  checked={c.alwaysVisible ? true : !hiddenColumns.includes(c.key)}
                  disabled={c.alwaysVisible}
                  onChange={() => !c.alwaysVisible && onToggleColumn(c.key)}
                />
                {c.label}
              </label>
            ))}
          </>
        )}
      </IconPopoverButton>
    </>
  );
}

// Active sort/filter shown as dismissible pills under the view tabs, like
// Notion's own filter-pill row. Only renders when there's something active.
export function ViewFilterPills<T>({
  groupOptions,
  groupBy,
  hiddenGroups,
  onGroupByChange,
  onHiddenGroupsChange,
  sortOptions,
  sorts,
  onSortsChange,
  isBoard,
  groupByDisabled,
  filterAssignedToMe,
  filterStatuses,
  onClearFilter,
}: {
  groupOptions: GroupOption<T>[];
  groupBy: string | null;
  hiddenGroups: string[];
  onGroupByChange: (key: string | null) => void;
  onHiddenGroupsChange: (hidden: string[]) => void;
  sortOptions: SortOption<T>[];
  sorts: SortRule[];
  onSortsChange: (sorts: SortRule[]) => void;
  isBoard?: boolean;
  groupByDisabled?: boolean;
  filterAssignedToMe: boolean;
  filterStatuses: string[];
  onClearFilter: () => void;
}) {
  const activeOption = groupByDisabled ? undefined : groupOptions.find((g) => g.key === groupBy);
  const hasFilter = filterAssignedToMe || filterStatuses.length > 0;
  if (!activeOption && sorts.length === 0 && !hasFilter) return null;

  const filterParts: string[] = [];
  if (filterAssignedToMe) filterParts.push("Assigned to me");
  if (filterStatuses.length > 0) filterParts.push(`Status: ${filterStatuses.join(", ")}`);

  return (
    <div className="view-filter-pills">
      {hasFilter && (
        <span className="filter-pill">
          Filtered: {filterParts.join(", ")}
          <button title="Clear filter" onClick={onClearFilter}>
            <X size={10} />
          </button>
        </span>
      )}
      {activeOption && (
        <span className="filter-pill">
          Grouped by {activeOption.label}
          {!isBoard && (
            <button
              title="Clear grouping"
              onClick={() => {
                onGroupByChange(null);
                onHiddenGroupsChange([]);
              }}
            >
              <X size={10} />
            </button>
          )}
        </span>
      )}
      {activeOption && hiddenGroups.length > 0 && (
        <span className="filter-pill">
          {hiddenGroups.length} {activeOption.label.toLowerCase()} value{hiddenGroups.length === 1 ? "" : "s"} hidden
          <button title="Show all" onClick={() => onHiddenGroupsChange([])}>
            <X size={10} />
          </button>
        </span>
      )}
      {sorts.map((s, idx) => {
        const option = sortOptions.find((o) => o.key === s.key);
        return (
          <span className="filter-pill" key={`${s.key}_${idx}`}>
            Sorted by {option?.label ?? s.key} {s.direction === "asc" ? "↑" : "↓"}
            <button title="Remove sort" onClick={() => onSortsChange(sorts.filter((_, i) => i !== idx))}>
              <X size={10} />
            </button>
          </span>
        );
      })}
    </div>
  );
}
