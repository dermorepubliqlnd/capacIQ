import { useEffect, useRef, useState } from "react";
import { Plus, MoreHorizontal, Pencil, Trash2, Table2 } from "lucide-react";
import type { TableView } from "../lib/tableTypes";

interface ViewTabsProps {
  views: TableView[];
  activeViewId: string;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}

const MAX_VISIBLE = 6;

// Flat, icon + label view-tab bar (matches Notion's own view switcher: no
// boxes or borders, active view is just bolder/darker text). A small "⋯"
// menu (visible on hover) opens Rename/Delete instead of cluttering every
// tab with permanent icons; views beyond MAX_VISIBLE collapse into "N more".
export default function ViewTabs({ views, activeViewId, onSelect, onCreate, onRename, onDelete }: ViewTabsProps) {
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
  // Keep the active view within the visible set even if it'd otherwise overflow.
  const visible = activeIdx >= MAX_VISIBLE ? [...views.slice(0, MAX_VISIBLE - 1), views[activeIdx]] : views.slice(0, MAX_VISIBLE);
  const overflow = views.filter((v) => !visible.includes(v));

  function renderTab(v: TableView) {
    const active = v.id === activeViewId;
    return (
      <div key={v.id} className={`view-tab${active ? " active" : ""}`} onClick={() => onSelect(v.id)}>
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
            <Table2 size={12} className="view-tab-icon" />
            {v.name}
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
                {views.length > 1 && (
                  <button
                    className="danger"
                    onClick={() => {
                      setMenuOpenId(null);
                      if (window.confirm(`Delete the view "${v.name}"?`)) onDelete(v.id);
                    }}
                  >
                    <Trash2 size={12} />
                    Delete
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
