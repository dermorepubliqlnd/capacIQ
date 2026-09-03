import { useRef } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Search, X } from "lucide-react";

// Phase 11 (2026-08-21): searchable multi-select for the WBS Utilization
// snapshot's "select which people to show" control (Sandra). Same portal
// mechanics as CardActionMenu.tsx (fixed-position panel, click-outside
// backdrop) but parameterized for a checklist + search box instead of a
// list of actions.
export interface UtilPersonFilterPerson {
  id: string;
  name: string;
}

interface Props {
  people: UtilPersonFilterPerson[];
  // null = no filter applied (show everyone) -- matches the button's
  // "All people" resting label.
  selected: Set<string> | null;
  onChange: (next: Set<string> | null) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  search: string;
  setSearch: (v: string) => void;
}

const PANEL_WIDTH = 240;

export default function UtilPersonFilterButton({ people, selected, onChange, open, setOpen, search, setSearch }: Props) {
  const btnRef = useRef<HTMLButtonElement>(null);

  const label = selected === null ? "All team members" : selected.size === 0 ? "No team members" : `${selected.size} of ${people.length} team members`;

  function toggle(id: string) {
    const base = selected ?? new Set(people.map((p) => p.id));
    const next = new Set(base);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  }

  const filtered = people.filter((p) => p.name.toLowerCase().includes(search.trim().toLowerCase()));

  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button
        ref={btnRef}
        onClick={() => setOpen(!open)}
        className={`timeline-segmented-btn${selected !== null ? " active" : ""}`}
        style={{ borderRadius: "var(--radius-sm)", border: "1px solid var(--border)", display: "inline-flex", alignItems: "center", gap: 4 }}
        title="Choose which team members appear in the snapshot"
      >
        {label}
        <ChevronDown size={12} />
      </button>

      {open &&
        createPortal(
          <>
            <div style={{ position: "fixed", inset: 0, zIndex: 200 }} onClick={() => setOpen(false)} />
            <div
              className="card"
              style={{
                position: "absolute",
                top: (btnRef.current?.getBoundingClientRect().bottom ?? 0) + window.scrollY + 4,
                left: btnRef.current?.getBoundingClientRect().left ?? 0,
                width: PANEL_WIDTH,
                maxHeight: 320,
                display: "flex",
                flexDirection: "column",
                zIndex: 201,
                padding: 8,
                boxShadow: "0 4px 14px rgba(0,0,0,0.18)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                <span style={{ display: "inline-flex", color: "var(--muted)" }}>
                  <Search size={13} />
                </span>
                <input
                  autoFocus
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search team members..."
                  style={{ flex: 1, fontSize: 12, border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "4px 6px" }}
                />
              </div>
              <div style={{ display: "flex", gap: 8, marginBottom: 6, fontSize: 11 }}>
                <button
                  onClick={() => onChange(null)}
                  style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", padding: 0, fontWeight: 600 }}
                >
                  Select all
                </button>
                <button
                  onClick={() => onChange(new Set())}
                  style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", padding: 0, fontWeight: 600 }}
                >
                  Clear
                </button>
                {search && (
                  <button
                    onClick={() => setSearch("")}
                    style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--muted)", cursor: "pointer", padding: 0, display: "inline-flex" }}
                    title="Clear search"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
              <div style={{ overflowY: "auto" }}>
                {filtered.length === 0 && <div style={{ fontSize: 11.5, color: "var(--muted)", padding: "6px 2px" }}>No matches.</div>}
                {filtered.map((p) => {
                  const checked = selected === null || selected.has(p.id);
                  return (
                    <label
                      key={p.id}
                      style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 4px", fontSize: 12, cursor: "pointer", borderRadius: 4 }}
                      className="row-menu-item"
                    >
                      <input type="checkbox" checked={checked} onChange={() => toggle(p.id)} />
                      {p.name}
                    </label>
                  );
                })}
              </div>
            </div>
          </>,
          document.body
        )}
    </span>
  );
}
