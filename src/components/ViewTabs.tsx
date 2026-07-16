import { useEffect, useRef, useState } from "react";
import { Plus, MoreHorizontal, Pencil, SlidersHorizontal, Copy, Trash2, Table2 } from "lucide-react";
import type { GroupOption, TableView } from "../lib/tableTypes";

interface ViewTabsProps<T> {
  views: TableView[];
  activeViewId: string;
  rows: T[];
  groupOptions: GroupOption<T>[];
  onSelect: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onColorChange: (id: string, color: string) => void;
  onEditView: (id: string) => void;
  onDuplicate: (id: string) => void;
  confirm: (options: { title?: string; message: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
}

const MAX_VISIBLE = 6;

export const TAB_COLORS: Record<string, string> = {
  neutral: "var(--navy)",
  accent: "var(--accent)",
  success: "var(--success-text)",
  warning: "var(--warning-text)",
  danger: "var(--danger-text)",
  purple: "#7b4fb0",
  pink: "#c1447e",
};

// Count of rows still visible under a given view's own grouping settings
// (its groupBy + hiddenGroups), independent of whichever view is active —
// each view remembers its own configuration, so this can be computed for
// every tab, not just the selected one.
function visibleCountFor<T>(view: TableView, rows: T[], groupOptions: GroupOption<T>[]): number {
  const option = groupOptions.find((g) => g.key === view.groupBy);
  if (!option) return rows.length;
  return rows.filter((r) => !view.hiddenGroups.includes(option.getGroup(r) || "—")).length;
}

// Flat, icon + label view-tab bar (matches Notion's own view switcher). A
// small "⋯" menu (visible on hover) opens Rename/Color/Delete instead of
// cluttering every tab with permanent icons; views beyond MAX_VISIBLE
// collapse into "N more". Optional per-view count badge (toggled per view
// in View Settings) and per-view color tint.
export default function ViewTabs<T>({
  views,
  activeViewId,
  rows,
  groupOptions,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onColorChange,
  onEditView,
  onDuplicate,
  confirm,
}: ViewTabsProps<T>) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setMenuOpenId(null);
        setOverflowOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function startRename(v: TableView) {
    setMenuOpenId(null);
    setEditingId(v.id);
    setEditValue(v.name);
  }

  function commitRename() {
    if (editingId && editValue.trim()) onRename(editingId, editValue.trim());
    setEditingId(null);
  }

  function handleCreate() {
    const name = window.prompt("Name this view:", "New view");
    if (name && name.trim()) onCreate(name.trim());
  }

  const activeIdx = views.findIndex((v) => v.id === activeViewId);
  const visible = activeIdx >= MAX_VISIBLE ? [...views.slice(0, MAX_VISIBLE - 1), views[activeIdx]] : views.slice(0, MAX_VISIBLE);
  const overflow = views.filter((v) => !visible.includes(v));

  function renderTab(v: TableView) {
    const active = v.id === activeViewId;
    const color = TAB_COLORS[v.color] ?? TAB_COLORS.neutral;
    return (
      <div
        key={v.id}
        className={`view-tab${active ? " active" : ""}`}
        style={{ color: active ? color : undefined }}
        onClick={() => onSelect(v.id)}
      >
        {editingId === v.id ? (
          <input
            autoFocus
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") setEditingId(null);
            }}
            onClick={(e) => e.stopPropagation()}
            style={{ fontSize: 12, fontWeight: 600, padding: "1px 4px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", width: 100 }}
          />
        ) : (
          <>
            <Table2 size={12} className="view-tab-icon" style={{ color }} />
            {v.name}
            {v.showCount && <span className="view-tab-count">{visibleCountFor(v, rows, groupOptions)}</span>}
            <button
              className={`view-tab-menu-btn${menuOpenId === v.id ? " menu-open" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpenId(menuOpenId === v.id ? null : v.id);
              }}
              title="View options"
            >
              <MoreHorizontal size={13} />
            </button>
            {menuOpenId === v.id && (
              <div className="view-tab-dropdown" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => startRename(v)}>
                  <Pencil size={12} />
                  Rename
                </button>
                <button
                  onClick={() => {
                    setMenuOpenId(null);
                    onEditView(v.id);
                  }}
                >
                  <SlidersHorizontal size={12} />
                  Edit view
                </button>
                <button
                  onClick={() => {
                    setMenuOpenId(null);
                    onDuplicate(v.id);
                  }}
                >
                  <Copy size={12} />
                  Duplicate view
                </button>
                <div style={{ display: "flex", gap: 4, padding: "6px 6px 4px" }}>
                  {Object.entries(TAB_COLORS).map(([key, hex]) => (
                    <span
                      key={key}
                      onClick={() => {
                        onColorChange(v.id, key);
                        setMenuOpenId(null);
                      }}
                      title={key}
                      style={{
                        width: 14,
                        height: 14,
                        borderRadius: "50%",
                        background: hex,
                        cursor: "pointer",
                        border: v.color === key ? "2px solid var(--navy)" : "1px solid var(--border)",
                      }}
                    />
                  ))}
                </div>
                {views.length > 1 && (
                  <button
                    className="danger"
                    onClick={async () => {
                      setMenuOpenId(null);
                      const ok = await confirm({
                        title: "Delete view",
                        message: `Delete the view "${v.name}"? This can't be undone.`,
                        confirmLabel: "Delete view",
                        danger: true,
                      });
                      if (ok) onDelete(v.id);
                    }}
                  >
                    <Trash2 size={12} />
                    Delete view
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="view-tabs">
      {visible.map(renderTab)}
      {overflow.length > 0 && (
        <div className="view-tab" style={{ position: "relative" }} onClick={() => setOverflowOpen((v) => !v)}>
          {overflow.length} more
          {overflowOpen && (
            <div className="view-tab-dropdown" style={{ width: 160 }} onClick={(e) => e.stopPropagation()}>
              {overflow.map((v) => (
                <button
                  key={v.id}
                  onClick={() => {
                    onSelect(v.id);
                    setOverflowOpen(false);
                  }}
                >
                  <Table2 size={12} />
                  {v.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="view-tab" onClick={handleCreate} style={{ color: "var(--muted)" }}>
        <Plus size={12} />
        Add view
      </div>
    </div>
  );
}
