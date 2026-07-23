import { useEffect, useRef, useState } from "react";
import { Plus, MoreHorizontal, Pencil, Copy, Trash2, Table2, Kanban, Calendar, GanttChart, Search } from "lucide-react";
import type { GroupOption, TableView, ViewType } from "../lib/tableTypes";

interface ViewTabsProps<T> {
  views: TableView[];
  activeViewId: string;
  rows: T[];
  groupOptions: GroupOption<T>[];
  onSelect: (id: string) => void;
  onCreate: (name: string, viewType?: ViewType, initialGroupBy?: string, initialHiddenColumns?: string[]) => void;
  // Field a new Board view should group by out of the box (e.g.
  // "project_status" / "status") -- Board can't render without some
  // grouping, so this seeds a sensible default the user is then free to
  // change via the Group-by picker.
  boardDefaultGroupBy?: string;
  // Column keys a new Timeline view should start with hidden (e.g. Category/
  // Effort/Timelines/Days Extended on Projects) -- mirrors boardDefaultGroupBy's
  // pattern above but for Timeline's curated default Properties set instead
  // of Board's required grouping field. Undefined means "fall back to
  // whatever the table's own default view has hidden" (createView's own
  // fallback), which is what Tasks' Timeline still does today.
  timelineDefaultHiddenColumns?: string[];
  // Same idea, for a brand-new Calendar view's starting Properties set.
  calendarDefaultHiddenColumns?: string[];
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onColorChange: (id: string, color: string) => void;
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

// One icon per view type -- Table/Board/Timeline/Calendar are all real,
// selectable layouts now (see VIEW_TYPE_TILES below).
const VIEW_TYPE_ICONS: Record<ViewType, typeof Table2> = {
  table: Table2,
  board: Kanban,
  calendar: Calendar,
  timeline: GanttChart,
};

// "Start from scratch" tiles shown in the Add-view picker, Notion-style.
// All four layouts are wired up to actually create a view now.
const VIEW_TYPE_TILES: { type: ViewType; label: string; enabled: boolean }[] = [
  { type: "table", label: "Table", enabled: true },
  { type: "board", label: "Board", enabled: true },
  { type: "timeline", label: "Timeline", enabled: true },
  { type: "calendar", label: "Calendar", enabled: true },
];

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
  boardDefaultGroupBy,
  timelineDefaultHiddenColumns,
  calendarDefaultHiddenColumns,
  onRename,
  onDelete,
  onColorChange,
  onDuplicate,
  confirm,
}: ViewTabsProps<T>) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addSearch, setAddSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setMenuOpenId(null);
        setOverflowOpen(false);
        setAddOpen(false);
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

  // Notion-style zero-friction create: no naming prompt, just add a new
  // view immediately with an auto-generated name the person can rename
  // later via the tab's own "⋯" menu.
  function handleCreateView(viewType: ViewType) {
    const base = viewType === "board" ? "New board" : viewType === "timeline" ? "New timeline" : viewType === "calendar" ? "New calendar" : "New view";
    const existingUntitled = views.filter((v) => new RegExp(`^${base}( \\d+)?$`).test(v.name)).length;
    const name = existingUntitled === 0 ? base : `${base} ${existingUntitled + 1}`;
    onCreate(
      name,
      viewType,
      viewType === "board" ? boardDefaultGroupBy : undefined,
      viewType === "timeline" ? timelineDefaultHiddenColumns : viewType === "calendar" ? calendarDefaultHiddenColumns : undefined
    );
    setAddOpen(false);
    setAddSearch("");
  }

  const activeIdx = views.findIndex((v) => v.id === activeViewId);
  const visible = activeIdx >= MAX_VISIBLE ? [...views.slice(0, MAX_VISIBLE - 1), views[activeIdx]] : views.slice(0, MAX_VISIBLE);
  const overflow = views.filter((v) => !visible.includes(v));
  const filteredViews = views.filter((v) => v.name.toLowerCase().includes(addSearch.trim().toLowerCase()));

  function renderTab(v: TableView) {
    const active = v.id === activeViewId;
    const color = TAB_COLORS[v.color] ?? TAB_COLORS.neutral;
    const Icon = VIEW_TYPE_ICONS[v.viewType] ?? Table2;
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
            <Icon size={12} className="view-tab-icon" style={{ color }} />
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
              {overflow.map((v) => {
                const Icon = VIEW_TYPE_ICONS[v.viewType] ?? Table2;
                return (
                  <button
                    key={v.id}
                    onClick={() => {
                      onSelect(v.id);
                      setOverflowOpen(false);
                    }}
                  >
                    <Icon size={12} />
                    {v.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      <div className="view-tab" style={{ position: "relative" }} onClick={() => setAddOpen((v) => !v)}>
        <Plus size={12} style={{ color: "var(--muted)" }} />
        <span style={{ color: "var(--muted)" }}>Add view</span>
        {addOpen && (
          <div className="add-view-popover" onClick={(e) => e.stopPropagation()}>
            <div className="add-view-search">
              <Search size={13} />
              <input
                autoFocus
                placeholder="Search for a view..."
                value={addSearch}
                onChange={(e) => setAddSearch(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>
            {filteredViews.length > 0 && (
              <div className="add-view-existing">
                {filteredViews.map((v) => {
                  const Icon = VIEW_TYPE_ICONS[v.viewType] ?? Table2;
                  return (
                    <button
                      key={v.id}
                      className="add-view-existing-item"
                      onClick={() => {
                        onSelect(v.id);
                        setAddOpen(false);
                        setAddSearch("");
                      }}
                    >
                      <Icon size={13} />
                      {v.name}
                      {v.id === activeViewId && <span className="add-view-current">Current</span>}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="add-view-scratch-label">Start from scratch</div>
            <div className="add-view-tiles">
              {VIEW_TYPE_TILES.map((tile) => {
                const Icon = VIEW_TYPE_ICONS[tile.type];
                return (
                  <button
                    key={tile.type}
                    className={`add-view-tile${tile.enabled ? "" : " disabled"}`}
                    disabled={!tile.enabled}
                    title={tile.enabled ? `New ${tile.label.toLowerCase()} view` : "Coming soon"}
                    onClick={tile.enabled ? () => handleCreateView(tile.type) : undefined}
                  >
                    <Icon size={18} />
                    <span>{tile.label}</span>
                    {!tile.enabled && <span className="add-view-soon">Soon</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
