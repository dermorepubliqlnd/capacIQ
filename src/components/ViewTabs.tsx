import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { Plus, Pencil, Copy, Trash2, Table2, Kanban, Calendar, GanttChart, Search } from "lucide-react";
import type { GroupOption, TableView, ViewType } from "../lib/tableTypes";
import { VIEW_ICON_LIBRARY, VIEW_ICON_SECTIONS } from "../lib/viewIcons";

interface ViewTabsProps<T> {
  views: TableView[];
  activeViewId: string;
  rows: T[];
  groupOptions: GroupOption<T>[];
  onSelect: (id: string) => void;
  onCreate: (name: string, viewType?: ViewType, initialGroupBy?: string, initialHiddenColumns?: string[]) => void;
  // Field a new Board view should group by out of the box (e.g. "phase"
  // for Projects, "status" for Tasks) -- Board can't render without some
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
  // Sandra, 2026-09-03 ("when renaming views can we now push for icon
  // sets? ... allow to change colors too"): pass null to clear a view's
  // custom icon back to its viewType default.
  onIconChange: (id: string, icon: string | null) => void;
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
  onIconChange,
  onDuplicate,
  confirm,
}: ViewTabsProps<T>) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  // Sandra, 2026-09-03: the "..." dropdown's icon-swatch button swaps the
  // SAME already-open dropdown into a search + sectioned icon grid (plus
  // the existing color row) rather than opening a second portal -- one
  // less position-tracking popover to keep in sync with the trigger.
  const [iconPickerOpenId, setIconPickerOpenId] = useState<string | null>(null);
  const [iconSearch, setIconSearch] = useState("");
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addSearch, setAddSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  // These three dropdowns (per-tab "..." menu, "N more" overflow, and
  // Add-view) all used to render in-place with `position:absolute` inside
  // the trigger's own wrapper. That broke whenever a view-tabs bar sat
  // inside Projects.tsx's `.sticky-toolbar-cluster` (position:sticky +
  // z-index:20) -- the sticky ancestor forms its own stacking context, so
  // a locally-scoped z-index (even 30) only wins against siblings *inside*
  // that context, and loses to a later, unrelated sticky sibling elsewhere
  // on the page (e.g. the Tasks section's own toolbar) that ties at the
  // same z-index and wins the DOM-order tiebreak (Sandra, 2026-08-26:
  // "the view options part goes behind the tasks toolbar"). Fixed the same
  // way ViewSettingsMenu.tsx's IconPopoverButton already fixed this exact
  // bug for the Filter/Sort/Group/Properties popovers: portal to
  // document.body with `position:fixed`, positioned from the trigger's own
  // getBoundingClientRect() at click time (no scroll/resize tracking while
  // open, same tradeoff IconPopoverButton makes -- these are short-lived).
  const [menuPos, setMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [overflowPos, setOverflowPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [addPos, setAddPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const menuDropdownRef = useRef<HTMLDivElement>(null);
  const overflowDropdownRef = useRef<HTMLDivElement>(null);
  const addPopoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      // The dropdowns are portaled outside containerRef's DOM subtree now,
      // so they each need their own "did this click land inside me" check.
      if (containerRef.current?.contains(target)) return;
      if (menuDropdownRef.current?.contains(target)) return;
      if (overflowDropdownRef.current?.contains(target)) return;
      if (addPopoverRef.current?.contains(target)) return;
      setMenuOpenId(null);
      setIconPickerOpenId(null);
      setIconSearch("");
      setOverflowOpen(false);
      setAddOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function openPositionedMenu(e: ReactMouseEvent<HTMLElement>, setPos: (p: { top: number; left: number }) => void, width: number) {
    const rect = e.currentTarget.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    let left = rect.left;
    if (left + width > viewportWidth - 4) left = Math.max(4, viewportWidth - width - 4);
    setPos({ top: rect.bottom + 4, left });
  }

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
    // A view's own icon (v.icon, chosen from VIEW_ICON_LIBRARY) wins when
    // set; otherwise falls back to the old per-viewType default, exactly
    // as every view rendered before this feature existed.
    const Icon = (v.icon && VIEW_ICON_LIBRARY[v.icon]) || VIEW_TYPE_ICONS[v.viewType] || Table2;
    const iconQuery = iconSearch.trim().toLowerCase();
    const iconSections = iconQuery
      ? VIEW_ICON_SECTIONS.map((sec) => ({ ...sec, icons: sec.icons.filter((n) => n.toLowerCase().includes(iconQuery)) })).filter(
          (sec) => sec.icons.length > 0
        )
      : VIEW_ICON_SECTIONS;
    return (
      <div
        key={v.id}
        className={`view-tab${active ? " active" : ""}`}
        style={{ color: active ? color : undefined }}
        title={active ? "Click again for view options" : undefined}
        onClick={(e) => {
          // Sandra, 2026-09-03 ("remove the ellipsis... highlight the
          // active view... 1st click displays the view, 2nd click on the
          // active tab shows view settings"): the separate always-visible
          // "..." button is gone -- the tab itself is now the trigger.
          // Selecting an inactive tab just switches to it, same as
          // before; clicking a tab that's ALREADY active (this is the
          // Notion behavior she's describing) toggles the same
          // Rename/Duplicate/Color/Delete dropdown that used to live
          // behind the "..." icon.
          if (active) {
            if (menuOpenId === v.id) {
              setMenuOpenId(null);
            } else {
              openPositionedMenu(e, setMenuPos, 260);
              setMenuOpenId(v.id);
            }
          } else {
            onSelect(v.id);
            setMenuOpenId(null);
          }
        }}
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
            {menuOpenId === v.id &&
              createPortal(
              <div
                ref={menuDropdownRef}
                className="view-tab-dropdown"
                style={{
                  position: "fixed",
                  top: menuPos.top,
                  left: menuPos.left,
                  // Sandra, 2026-09-03 ("push for icon sets... same
                  // format as project categories... allow to change
                  // colors too"): the icon+color sub-view needs real room
                  // for a search box and a scrollable, sectioned grid
                  // (219 icons across 16 categories) -- the plain
                  // Rename/Duplicate/Delete list stays at its old compact
                  // width.
                  width: iconPickerOpenId === v.id ? 260 : 170,
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {iconPickerOpenId === v.id ? (
                  <>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                      <button
                        onClick={() => {
                          setIconPickerOpenId(null);
                          setIconSearch("");
                        }}
                        style={{ padding: "4px 6px", fontSize: 11, fontWeight: 600, color: "var(--muted)" }}
                      >
                        ← Back
                      </button>
                    </div>
                    <div style={{ position: "relative", marginBottom: 8 }}>
                      <Search size={12} style={{ position: "absolute", left: 7, top: "50%", transform: "translateY(-50%)", color: "var(--muted)" }} />
                      <input
                        autoFocus
                        placeholder="Search icons..."
                        value={iconSearch}
                        onChange={(e) => setIconSearch(e.target.value)}
                        onKeyDown={(e) => e.stopPropagation()}
                        style={{
                          width: "100%",
                          fontSize: 12,
                          padding: "5px 8px 5px 24px",
                          border: "1px solid var(--border)",
                          borderRadius: "var(--radius-sm)",
                          fontFamily: "inherit",
                        }}
                      />
                    </div>
                    <div style={{ maxHeight: 260, overflowY: "auto", paddingRight: 2 }}>
                      {iconSections.length === 0 && (
                        <div style={{ fontSize: 11.5, color: "var(--muted)", padding: "8px 4px" }}>No icons match "{iconSearch}"</div>
                      )}
                      {iconSections.map((section) => (
                        <div key={section.label} style={{ marginBottom: 8 }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 4 }}>
                            {section.label}
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
                            {section.icons.map((iconName) => {
                              const IconOption = VIEW_ICON_LIBRARY[iconName];
                              if (!IconOption) return null;
                              const selected = v.icon === iconName;
                              return (
                                <button
                                  key={`${section.label}_${iconName}`}
                                  onClick={() => onIconChange(v.id, iconName)}
                                  title={iconName}
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    width: 26,
                                    height: 26,
                                    padding: 0,
                                    borderRadius: "var(--radius-sm)",
                                    border: selected ? "2px solid var(--navy)" : "1px solid var(--border)",
                                    background: "none",
                                    cursor: "pointer",
                                  }}
                                >
                                  <IconOption size={13} color={color} />
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div style={{ fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.3, margin: "6px 0 4px" }}>
                      Color
                    </div>
                    <div style={{ display: "flex", gap: 4, padding: "0 2px 4px" }}>
                      {Object.entries(TAB_COLORS).map(([key, hex]) => (
                        <span
                          key={key}
                          onClick={() => onColorChange(v.id, key)}
                          title={key}
                          style={{
                            width: 16,
                            height: 16,
                            borderRadius: "50%",
                            background: hex,
                            cursor: "pointer",
                            border: v.color === key ? "2px solid var(--navy)" : "1px solid var(--border)",
                          }}
                        />
                      ))}
                    </div>
                    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
                      <button
                        onClick={() => setMenuOpenId(null)}
                        style={{ fontSize: 11, color: "var(--accent)", background: "none", border: "none", cursor: "pointer", fontWeight: 600, padding: "4px 6px" }}
                      >
                        Done
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <button onClick={() => startRename(v)}>
                      <Pencil size={12} />
                      Rename
                    </button>
                    <button onClick={() => setIconPickerOpenId(v.id)}>
                      <Icon size={12} color={color} />
                      Icon &amp; color
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
                  </>
                )}
              </div>,
              document.body
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
        <div
          className="view-tab"
          style={{ position: "relative" }}
          onClick={(e) => {
            if (overflowOpen) {
              setOverflowOpen(false);
            } else {
              openPositionedMenu(e, setOverflowPos, 160);
              setOverflowOpen(true);
            }
          }}
        >
          {overflow.length} more
          {overflowOpen &&
            createPortal(
            <div
              ref={overflowDropdownRef}
              className="view-tab-dropdown"
              style={{ position: "fixed", top: overflowPos.top, left: overflowPos.left, width: 160 }}
              onClick={(e) => e.stopPropagation()}
            >
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
            </div>,
            document.body
            )}
        </div>
      )}
      <div
        className="view-tab"
        style={{ position: "relative" }}
        onClick={(e) => {
          if (addOpen) {
            setAddOpen(false);
          } else {
            openPositionedMenu(e, setAddPos, 220);
            setAddOpen(true);
          }
        }}
      >
        <Plus size={12} style={{ color: "var(--muted)" }} />
        <span style={{ color: "var(--muted)" }}>Add view</span>
        {addOpen &&
          createPortal(
          <div
            ref={addPopoverRef}
            className="add-view-popover"
            style={{ position: "fixed", top: addPos.top, left: addPos.left }}
            onClick={(e) => e.stopPropagation()}
          >
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
          </div>,
          document.body
          )}
      </div>
    </div>
  );
}
