import { useEffect, useRef, useState } from "react";
import { Columns3 } from "lucide-react";
import type { ColumnDef, GroupOption } from "../lib/tableTypes";

interface ColumnsMenuProps<T> {
  columns: ColumnDef<T>[];
  hiddenColumns: string[];
  onToggleColumn: (key: string) => void;
  groupOptions?: GroupOption<T>[];
  groupBy: string | null;
  onGroupByChange?: (key: string | null) => void;
}

// Dropdown panel (Notion "Properties"-style) for showing/hiding columns and,
// if the table supports it, picking a group-by field.
export default function ColumnsMenu<T>({
  columns,
  hiddenColumns,
  onToggleColumn,
  groupOptions,
  groupBy,
  onGroupByChange,
}: ColumnsMenuProps<T>) {
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
        onClick={() => setOpen((v) => !v)}
        style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 10px", fontSize: 11.5, fontWeight: 500, color: "var(--text-secondary)", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", cursor: "pointer" }}
      >
        <Columns3 size={13} />
        Columns
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
            padding: 8,
            width: 200,
          }}
        >
          {groupOptions && groupOptions.length > 0 && (
            <div style={{ marginBottom: 8, paddingBottom: 8, borderBottom: "1px solid var(--border)" }}>
              <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3, color: "var(--muted)", marginBottom: 4 }}>
                Group by
              </div>
              <select
                value={groupBy ?? ""}
                onChange={(e) => onGroupByChange?.(e.target.value || null)}
                style={{ width: "100%", fontSize: 11.5, padding: "5px 6px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)" }}
              >
                <option value="">No grouping</option>
                {groupOptions.map((g) => (
                  <option key={g.key} value={g.key}>
                    {g.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3, color: "var(--muted)", marginBottom: 4 }}>
            Show / hide
          </div>
          {columns.map((c) => (
            <label key={c.key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, padding: "3px 2px", cursor: "pointer" }}>
              <input type="checkbox" checked={!hiddenColumns.includes(c.key)} onChange={() => onToggleColumn(c.key)} />
              {c.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
