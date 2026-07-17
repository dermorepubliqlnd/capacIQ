import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpDown, Layers, SlidersHorizontal, Eye, EyeOff, ArrowUp, ArrowDown, Plus, Trash2, X } from "lucide-react";
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
}

// A single borderless, Notion-style icon trigger + anchored popover. No box
// or border at rest -- just an icon that tints on hover, and gets a filled
// background + small dot while its config is active, matching Notion's own
// view toolbar (Sort / Filter / Properties as separate quick icons instead
// of one combined gear menu).
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
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        className={`toolbar-icon-btn${open || active ? " active" : ""}`}
        title={label}
        onClick={() => setOpen((v) => !v)}
      >
        {icon}
        {active && <span className="toolbar-icon-dot" />}
      </button>
      {open && (
        <div className="toolbar-popover" style={{ width }} onClick={(e) => e.stopPropagation()}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
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

// Three quick-access toolbar icons (Sort, Filter, Properties) replacing the
// old single combined "View settings" gear -- mirrors Notion's own view
// toolbar layout. Meant to be rendered inside a ".toolbar-actions" wrapper
// alongside any other per-page icon buttons (e.g. Task Effort colors).
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
}: ViewControlsProps<T>) {
  const activeOption = groupOptions.find((g) => g.key === groupBy);
  const groupValues = activeOption
    ? Array.from(new Set(rows.map((r) => activeOption.getGroup(r)))).sort((a, b) => a.localeCompare(b))
    : [];

  function toggleGroupVisible(name: string) {
    onHiddenGroupsChange(hiddenGroups.includes(name) ? hiddenGroups.filter((g) => g !== name) : [...hiddenGroups, name]);
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
              style={{ width: "100%", fontSize: 11.5, padding: "5px 6px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", marginBottom: activeOption ? 8 : 0 }}
            >
              <option value="">No filter</option>
              {groupOptions.map((g) => (
                <option key={g.key} value={g.key}>
                  {g.label}
                </option>
              ))}
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

      <IconPopoverButton icon={<SlidersHorizontal size={13} />} label="Properties" active={hiddenColumns.length > 0} width={220}>
        {(close) => (
          <>
            <PopoverHeader label="Properties" onClose={close} />
            {columns.map((c) => (
              <label key={c.key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, padding: "3px 2px", cursor: "pointer" }}>
                <input type="checkbox" checked={!hiddenColumns.includes(c.key)} onChange={() => onToggleColumn(c.key)} />
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
}: {
  groupOptions: GroupOption<T>[];
  groupBy: string | null;
  hiddenGroups: string[];
  onGroupByChange: (key: string | null) => void;
  onHiddenGroupsChange: (hidden: string[]) => void;
  sortOptions: SortOption<T>[];
  sorts: SortRule[];
  onSortsChange: (sorts: SortRule[]) => void;
}) {
  const activeOption = groupOptions.find((g) => g.key === groupBy);
  if (!activeOption && sorts.length === 0) return null;

  return (
    <div className="view-filter-pills">
      {activeOption && (
        <span className="filter-pill">
          Grouped by {activeOption.label}
          <button
            title="Clear grouping"
            onClick={() => {
              onGroupByChange(null);
              onHiddenGroupsChange([]);
            }}
          >
            <X size={10} />
          </button>
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
