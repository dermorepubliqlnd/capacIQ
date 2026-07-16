import { useState } from "react";
import { Plus, Pencil, Trash2 } from "lucide-react";
import type { TableView } from "../lib/tableTypes";

interface ViewTabsProps {
  views: TableView[];
  activeViewId: string;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}

// A row of Notion-style view tabs above a data table: click to switch views,
// double-click to rename, a small "x" to delete (when more than one view
// exists), and a trailing "+" to add a new named view.
export default function ViewTabs({ views, activeViewId, onSelect, onCreate, onRename, onDelete }: ViewTabsProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  function startRename(v: TableView) {
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
    <div style={{ display: "flex", alignItems: "center", gap: 2, borderBottom: "1px solid var(--border)", padding: "0 2px" }}>
      {views.map((v) => {
        const active = v.id === activeViewId;
        return (
          <div
            key={v.id}
            onClick={() => onSelect(v.id)}
            onDoubleClick={() => startRename(v)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "7px 10px",
              fontSize: 11.5,
              fontWeight: active ? 600 : 500,
              color: active ? "var(--navy)" : "var(--text-secondary)",
              borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
              cursor: "pointer",
              userSelect: "none",
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
                style={{ fontSize: 11.5, fontWeight: 600, padding: "1px 4px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", width: 100 }}
              />
            ) : (
              <>
                {v.name}
                <Pencil
                  size={10}
                  style={{ opacity: 0.4 }}
                  onClick={(e) => {
                    e.stopPropagation();
                    startRename(v);
                  }}
                />
                {views.length > 1 && (
                  <Trash2
                    size={10}
                    style={{ opacity: 0.4 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (window.confirm(`Delete the view "${v.name}"?`)) onDelete(v.id);
                    }}
                  />
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
