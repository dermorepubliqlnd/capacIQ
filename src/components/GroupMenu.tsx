import { useEffect, useRef, useState } from "react";
import { Rows3, Eye, EyeOff, X } from "lucide-react";
import type { GroupOption } from "../lib/tableTypes";

interface GroupMenuProps<T> {
  rows: T[];
  groupOptions: GroupOption<T>[];
  groupBy: string | null;
  hiddenGroups: string[];
  onGroupByChange: (key: string | null) => void;
  onHiddenGroupsChange: (hidden: string[]) => void;
}

// Notion-style "Group" settings panel: pick what to group by, then show/hide
// individual groups via an eye toggle (instead of a separate always-visible
// filter row). Replaces the old chip-based project filter.
export default function GroupMenu<T>({ rows, groupOptions, groupBy, hiddenGroups, onGroupByChange, onHiddenGroupsChange }: GroupMenuProps<T>) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const activeOption = groupOptions.find((g) => g.key === groupBy);
  const groupValues = activeOption
    ? Array.from(new Set(rows.map((r) => activeOption.getGroup(r)))).sort((a, b) => a.localeCompare(b))
    : [];

  function toggleGroup(name: string) {
    onHiddenGroupsChange(hiddenGroups.includes(name) ? hiddenGroups.filter((g) => g !== name) : [...hiddenGroups, name]);
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 10px", fontSize: 11.5, fontWeight: 500, color: "var(--text-secondary)", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", cursor: "pointer" }}
      >
        <Rows3 size={13} />
        {activeOption ? `Grouped: ${activeOption.label}` : "Group"}
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
            width: 220,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3, color: "var(--muted)" }}>Group by</span>
            <button onClick={() => setOpen(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)" }}>
              <X size={13} />
            </button>
          </div>
          <select
            value={groupBy ?? ""}
            onChange={(e) => onGroupByChange(e.target.value || null)}
            style={{ width: "100%", fontSize: 11.5, padding: "5px 6px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", marginBottom: activeOption ? 10 : 0 }}
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
                <span style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3, color: "var(--muted)" }}>Groups</span>
                <button
                  onClick={() => onHiddenGroupsChange(hiddenGroups.length === groupValues.length ? [] : groupValues)}
                  style={{ fontSize: 10.5, color: "var(--accent)", background: "none", border: "none", cursor: "pointer" }}
                >
                  {hiddenGroups.length === groupValues.length ? "Show all" : "Hide all"}
                </button>
              </div>
              <div style={{ maxHeight: 220, overflowY: "auto" }}>
                {groupValues.map((g) => {
                  const hidden = hiddenGroups.includes(g);
                  return (
                    <div
                      key={g}
                      onClick={() => toggleGroup(g)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 6,
                        padding: "4px 2px",
                        fontSize: 12,
                        color: hidden ? "var(--muted)" : "var(--text)",
                        cursor: "pointer",
                      }}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g}</span>
                      {hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
