import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowUpDown, Layers, SlidersHorizontal, Filter, Eye, EyeOff, ArrowUp, ArrowDown, GripVertical, Plus, Trash2, X } from "lucide-react";
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
  // "board": a Kanban board can't render without columns, so "No filter"
  // (ungrouped) is disabled outright and any option that isn't
  // boardGroupable shows disabled with a "not available on Board" hint.
  // "timeline": swimlane sections are optional -- ungrouped stays a valid,
  // clearable choice (same as Table) -- but the option set is still
  // locked to the same boardGroupable-flagged fields, shown disabled with
  // a "not available on Timeline" hint instead. undefined: Table's own
  // grouped-accordion view, where every listed option is usable and
  // ungrouped is always allowed.
  groupMode?: "board" | "timeline";
  // Row-level Filter (a person multi-select + a status multi-select) --
  // unlike Sort/Group-by/Properties, this isn't view-rendering config:
  // it's applied to the shared row list *before* Table/Board/Timeline
  // ever see it, so the same filter holds no matter which view type is
  // active.
  //
  // `people` is the same list Projects.tsx already fetches once and reuses
  // for its Owner/Assignee dropdowns -- passed through here rather than
  // refetched, purely so the Filter popover's checklist and the pill's
  // name lookups stay in sync with whatever the rest of the page shows.
  people: { id: string; name: string }[];
  filterPersonIds: string[];
  onFilterPersonIdsChange: (ids: string[]) => void;
  statusOptions: string[];
  filterStatuses: string[];
  onFilterStatusesChange: (statuses: string[]) => void;
  // Some columns are structurally excluded from ever rendering as a
  // Timeline chip regardless of hiddenColumns (see
  // PROJECT_TIMELINE_EXCLUDED_KEYS in Projects.tsx -- e.g. Name is always
  // the row label, Actual Progress is always the Gantt bar's own fill,
  // Start/Due are shown via the bar's position, never as a chip). Without
  // this, their Eye/EyeOff toggle in the Properties popover looks fully
  // functional but silently does nothing when the active view is
  // Timeline -- Sandra caught this ("shows hide and show options but not
  // really doing anything"). Passed only when the active view is a
  // Timeline view; keyed by column key, value is the tooltip explaining
  // why it's locked and whether it should read as always-shown or
  // always-hidden.
  propertyLockInfo?: Record<string, { reason: string; forcedVisible: boolean }>;
  // Calendar view has no swimlane/group-by concept (Notion's own Calendar
  // doesn't support grouping either -- confirmed, see CalendarView.tsx),
  // so its toolbar drops the "Group by" icon entirely rather than showing
  // a control that can't do anything there. Filter/Sort/Properties are
  // unaffected -- Sandra: "only sorting and filtering allowed" was about
  // grouping specifically, she wants Properties (which lines show on a
  // calendar card) kept.
  hideGroupBy?: boolean;
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
  groupMode,
  people,
  filterPersonIds,
  onFilterPersonIdsChange,
  statusOptions,
  filterStatuses,
  onFilterStatusesChange,
  propertyLockInfo,
  hideGroupBy,
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

  // "me" plus every real person.id are just entries in the same array --
  // toggling either works the same way, which is what lets a lead check
  // "Me" and two direct reports at once.
  function toggleFilterPerson(id: string) {
    onFilterPersonIdsChange(filterPersonIds.includes(id) ? filterPersonIds.filter((p) => p !== id) : [...filterPersonIds, id]);
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
  // Drag-to-reorder for sort priority -- replaces the old up/down chevron
  // stepper with a grip handle, matching Notion's own reorder affordance
  // (Sandra, 2026-07-22: "can the sort hierarchy sorter be a grip bar
  // instead of an arrow up and down"). draggedSortIdx tracks which row's
  // drag is in progress; dropping onto another row splices it to that
  // position (an array move, not a swap, so dragging rule 1 down past
  // rules 2 and 3 lands it at position 3 in one drag, not just one slot).
  const [draggedSortIdx, setDraggedSortIdx] = useState<number | null>(null);
  function reorderSort(from: number, to: number) {
    if (from === to) return;
    const next = [...sorts];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onSortsChange(next);
  }

  return (
    <>
      <IconPopoverButton icon={<Filter size={13} />} label="Filter" active={filterPersonIds.length > 0 || filterStatuses.length > 0} width={220}>
        {(close) => (
          <>
            <PopoverHeader label="Filter" onClose={close} />
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3, color: "var(--muted)", marginBottom: 4 }}>
              Assigned to
            </div>
            <div style={{ maxHeight: 160, overflowY: "auto", marginBottom: 6 }}>
              {/* "Me" is pinned first and kept visually separate (its own
                  row plus a thin divider) from the rest of the people list
                  below it, since it's the quick common case (an individual
                  contributor filtering to their own work) while the person
                  checklist underneath is the supervisor/lead case (picking
                  one or more *other* specific people). Both live in the
                  same filterPersonIds array either way. */}
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, padding: "3px 2px", cursor: "pointer", fontWeight: 500 }}>
                <input type="checkbox" checked={filterPersonIds.includes("me")} onChange={() => toggleFilterPerson("me")} />
                Me
              </label>
              {people.length > 0 && <div style={{ height: 1, background: "var(--border)", margin: "4px 0" }} />}
              {people.map((p) => (
                <label key={p.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, padding: "3px 2px", cursor: "pointer" }}>
                  <input type="checkbox" checked={filterPersonIds.includes(p.id)} onChange={() => toggleFilterPerson(p.id)} />
                  {p.name}
                </label>
              ))}
            </div>
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
              const isDragging = draggedSortIdx === idx;
              return (
                <div
                  key={`${s.key}_${idx}`}
                  onDragOver={(e) => {
                    if (draggedSortIdx === null || draggedSortIdx === idx) return;
                    e.preventDefault();
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (draggedSortIdx === null) return;
                    reorderSort(draggedSortIdx, idx);
                    setDraggedSortIdx(null);
                  }}
                  style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, opacity: isDragging ? 0.4 : 1 }}
                >
                  {/* Grip handle: drag-to-reorder the sort priority, same
                      affordance as Notion's own rule reordering -- replaces
                      the old up/down chevron stepper (Sandra, 2026-07-22:
                      "can the sort hierarchy sorter be a grip bar instead
                      of an arrow up and down"). Single-rule lists don't
                      need a grip at all, since there's nothing to reorder
                      against. */}
                  {sorts.length > 1 ? (
                    <span
                      draggable
                      onDragStart={() => setDraggedSortIdx(idx)}
                      onDragEnd={() => setDraggedSortIdx(null)}
                      title="Drag to reorder priority"
                      style={{ display: "flex", alignItems: "center", cursor: "grab", color: "var(--text-secondary)", flexShrink: 0 }}
                    >
                      <GripVertical size={14} />
                    </span>
                  ) : (
                    <span style={{ width: 14, flexShrink: 0 }} />
                  )}
                  {/* Priority badge: a filled pill rather than plain "1."
                      text, so hierarchy (which rule applies first) reads
                      as its own distinct visual concept from the A-Z/Z-A
                      direction toggle next to it -- these two used to be
                      easy to mix up since both were bare up/down arrows
                      of nearly the same size. */}
                  <span
                    title="Sort priority -- rule 1 sorts first, the rest break ties in order"
                    style={{ fontSize: 10, fontWeight: 700, color: "var(--accent)", background: "#eaf1fb", borderRadius: "50%", width: 16, height: 16, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
                  >
                    {idx + 1}
                  </span>
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
                    title={s.direction === "asc" ? "Direction: Ascending -- click for Descending" : "Direction: Descending -- click for Ascending"}
                    style={{ display: "flex", alignItems: "center", background: "none", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", cursor: "pointer", padding: 4, color: "var(--text-secondary)" }}
                  >
                    {s.direction === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
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
              <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 6 }}>
                Numbered badge = priority order (rule 1 sorts first). Grip handle = drag to reorder priority. Arrow button = ascending/descending direction.
              </div>
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

      {!hideGroupBy && (
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
              <option value="" disabled={groupMode === "board"} title={groupMode === "board" ? "A board needs a property to group into columns" : undefined}>
                No grouping
              </option>
              {groupOptions.map((g) => {
                const disabled = Boolean(groupMode) && g.boardGroupable === false;
                const modeLabel = groupMode === "board" ? "Board" : "Timeline";
                return (
                  <option key={g.key} value={g.key} disabled={disabled} title={disabled ? `Not available for ${modeLabel} -- values aren't a fixed set of columns` : undefined}>
                    {g.label}
                    {disabled ? ` (not available on ${modeLabel})` : ""}
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
            {columns.map((c) => {
              const lock = propertyLockInfo?.[c.key];
              const locked = Boolean(c.alwaysVisible) || Boolean(lock);
              const visible = lock ? lock.forcedVisible : c.alwaysVisible ? true : !hiddenColumns.includes(c.key);
              const lockTooltip = lock?.reason ?? (c.alwaysVisible ? "Always shown -- this is a computed value, not a free-typed one" : undefined);
              return (
                <div
                  key={c.key}
                  onClick={() => !locked && onToggleColumn(c.key)}
                  title={lockTooltip}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 6,
                    fontSize: 12,
                    padding: "3px 2px",
                    cursor: locked ? "default" : "pointer",
                    color: locked ? "var(--muted)" : visible ? "var(--text)" : "var(--muted)",
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.plainLabel ?? c.label}</span>
                  {visible ? <Eye size={13} /> : <EyeOff size={13} />}
                </div>
              );
            })}
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
  groupMode,
  people,
  filterPersonIds,
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
  groupMode?: "board" | "timeline";
  people: { id: string; name: string }[];
  filterPersonIds: string[];
  filterStatuses: string[];
  onClearFilter: () => void;
}) {
  const activeOption = groupOptions.find((g) => g.key === groupBy);
  const hasFilter = filterPersonIds.length > 0 || filterStatuses.length > 0;
  if (!activeOption && sorts.length === 0 && !hasFilter) return null;

  const filterParts: string[] = [];
  if (filterPersonIds.length > 0) {
    // Resolve each id to a display name -- "me" always shows literally as
    // "Me" (the pill can't know who's looking without duplicating the
    // caller's own useSession() call), everything else is looked up by id
    // in the same `people` list the picker above uses.
    const names = filterPersonIds.map((id) => (id === "me" ? "Me" : people.find((p) => p.id === id)?.name ?? "Unknown"));
    filterParts.push(names.join(", "));
  }
  if (filterStatuses.length > 0) filterParts.push(`Status: ${filterStatuses.join(", ")}`);

  return (
    <div className="view-filter-pills">
      {hasFilter && (
        <span className="filter-pill">
          Filtered: {filterParts.join(" \u00b7 ")}
          <button title="Clear filter" onClick={onClearFilter}>
            <X size={11} />
          </button>
        </span>
      )}
      {activeOption && (
        <span className="filter-pill">
          Grouped by {activeOption.label}
          {groupMode !== "board" && (
            <button
              title="Clear grouping"
              onClick={() => {
                onGroupByChange(null);
                onHiddenGroupsChange([]);
              }}
            >
              <X size={11} />
            </button>
          )}
        </span>
      )}
      {activeOption && hiddenGroups.length > 0 && (
        <span className="filter-pill">
          {hiddenGroups.length} {activeOption.label.toLowerCase()} value{hiddenGroups.length === 1 ? "" : "s"} hidden
          <button title="Show all" onClick={() => onHiddenGroupsChange([])}>
            <X size={11} />
          </button>
        </span>
      )}
      {sorts.map((s, idx) => {
        const option = sortOptions.find((o) => o.key === s.key);
        return (
          <span className="filter-pill" key={`${s.key}_${idx}`}>
            Sorted by {option?.label ?? s.key}
            <button
              className="filter-pill-arrow-btn"
              title={s.direction === "asc" ? "Switch to descending" : "Switch to ascending"}
              onClick={() => onSortsChange(sorts.map((r, i) => (i === idx ? { ...r, direction: r.direction === "asc" ? "desc" : "asc" } : r)))}
            >
              {s.direction === "asc" ? "↑" : "↓"}
            </button>
            <button title="Remove sort" onClick={() => onSortsChange(sorts.filter((_, i) => i !== idx))}>
              <X size={11} />
            </button>
          </span>
        );
      })}
    </div>
  );
}
