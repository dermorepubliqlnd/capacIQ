import { useEffect, useRef } from "react";
import { Settings2, Eye, EyeOff, X, ArrowUp, ArrowDown, Plus, Trash2 } from "lucide-react";
import type { ColumnDef, GroupOption, SortOption, SortRule } from "../lib/tableTypes";

interface ViewSettingsMenuProps<T> {
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
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// One combined "View settings" panel (Group by + Property visibility),
// matching Notion's own view settings dropdown, instead of two separate
// toolbar buttons.
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
  open,
  onOpenChange,
}: ViewSettingsMenuProps<T>) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onOpenChange(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [onOpenChange]);

  const activeOption = groupOptions.find((g) => g.key === groupBy);
  const hasActiveConfig = Boolean(groupBy) || sorts.length > 0;
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
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => onOpenChange(!open)}
        title={hasActiveConfig ? "View settings (sort/group active)" : "View settings"}
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 26,
          height: 26,
          color: open || hasActiveConfig ? "var(--accent)" : "var(--text-secondary)",
          background: open || hasActiveConfig ? "#eaf1fb" : "transparent",
          border: `1px solid ${open || hasActiveConfig ? "var(--accent)" : "var(--border)"}`,
          borderRadius: "var(--radius-sm)",
          cursor: "pointer",
        }}
      >
        <Settings2 size={13} />
        {hasActiveConfig && (
          <span
            style={{
              position: "absolute",
              top: -3,
              right: -3,
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "var(--accent)",
              border: "1.5px solid var(--surface)",
            }}
          />
        )}
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            zIndex: 20,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)",
            boxShadow: "0 4px 16px rgba(15,41,66,0.12)",
            padding: 10,
            width: 260,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--navy)" }}>View settings</span>
            <button onClick={() => onOpenChange(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)" }}>
              <X size={13} />
            </button>
          </div>

          <div style={{ marginBottom: 10, paddingBottom: 10, borderBottom: "1px solid var(--border)" }}>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3, color: "var(--muted)", marginBottom: 4 }}>
              Group by
            </div>
            <select
              value={groupBy ?? ""}
              onChange={(e) => onGroupByChange(e.target.value || null)}
              style={{ width: "100%", fontSize: 11.5, padding: "5px 6px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", marginBottom: activeOption ? 8 : 0 }}
            >
              <option value="">No grouping</option>
              {groupOptions.map((g) => (
                <option key={g.key} value={g.key}>
                  {g.label}
                </option>
              ))}
            </select>

            {activeOption && groupValues.length > 0 && (
              <>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontSize: 10, color: "var(--muted)" }}>Groups</span>
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
          </div>

          <div style={{ marginBottom: 10, paddingBottom: 10, borderBottom: "1px solid var(--border)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3, color: "var(--muted)" }}>
                Sort
              </span>
              {availableToAdd.length > 0 && (
                <button
                  onClick={addSort}
                  style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 10.5, color: "var(--accent)", background: "none", border: "none", cursor: "pointer" }}
                >
                  <Plus size={11} />
                  Add sort
                </button>
              )}
            </div>
            {sorts.length === 0 && <div style={{ fontSize: 11, color: "var(--muted)" }}>No sorting applied</div>}
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
              <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>Rule 1 sorts first; the rest break ties in order.</div>
            )}
          </div>

          <div>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3, color: "var(--muted)", marginBottom: 4 }}>
              Property visibility
            </div>
            {columns.map((c) => (
              <label key={c.key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, padding: "3px 2px", cursor: "pointer" }}>
                <input type="checkbox" checked={!hiddenColumns.includes(c.key)} onChange={() => onToggleColumn(c.key)} />
                {c.label}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
