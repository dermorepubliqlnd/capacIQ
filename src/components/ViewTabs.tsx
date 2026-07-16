import { useEffect, useRef, useState } from "react";
import { Plus, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import type { TableView } from "../lib/tableTypes";

interface ViewTabsProps {
  views: TableView[];
  activeViewId: string;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}

// Notion-style view tabs above a data table: click to switch, a small "⋯"
// menu (visible on hover, or always on the active tab) opens Rename/Delete
// instead of cluttering every tab with permanent icons.
export default function ViewTabs({ views, activeViewId, onSelect, onCreate, onRename, onDelete }: ViewTabsProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setMenuOpenId(null);
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

  return (
    <div ref={containerRef} className="view-tabs">
      {views.map((v) => {
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
                style={{ fontSize: 11.5, fontWeight: 600, padding: "1px 4px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", width: 100 }}
              />
            ) : (
              <>
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
      })}
      <button
        onClick={handleCreate}
        title="New view"
        style={{ display: "flex", alignItems: "center", gap: 4, padding: "6px 8px", fontSize: 11, color: "var(--muted)", background: "none", border: "none", cursor: "pointer" }}
      >
        <Plus size={12} />
        View
      </button>
    </div>
  );
}
