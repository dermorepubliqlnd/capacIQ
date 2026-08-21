import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MoreVertical } from "lucide-react";

// Generic small "..." action menu for a single card (Board/Calendar/
// Timeline), same popover mechanics as UserRowMenu.tsx (portal to
// document.body, fixed-position backdrop, click-outside-to-close) but
// parameterized on a plain items array instead of Admin-specific props.
//
// Quality audit follow-on (2026-08-21, UX #5): delete/archive was only
// reachable from Table view's toolbar -- someone living in Board or
// Calendar view had no way to even discover it. This gives any card a
// lightweight menu without each view component needing to know what
// actions are valid for what it's rendering.
export interface CardActionMenuItem {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: "danger" | "success";
}

const MENU_WIDTH = 170;

export default function CardActionMenu({ items }: { items: CardActionMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  function toggleOpen(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (open) {
      setOpen(false);
      return;
    }
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) {
      const left = Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
      setPos({ top: rect.bottom + 4, left });
    }
    setOpen(true);
  }

  function choose(e: React.MouseEvent, fn: () => void) {
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
    fn();
  }

  return (
    <span onClick={(e) => e.stopPropagation()} draggable={false}>
      <button
        ref={btnRef}
        onClick={toggleOpen}
        onMouseDown={(e) => e.stopPropagation()}
        draggable={false}
        title="More actions"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--muted)",
          padding: 2,
          borderRadius: 4,
        }}
      >
        <MoreVertical size={14} />
      </button>

      {open &&
        pos &&
        createPortal(
          <>
            <div style={{ position: "fixed", inset: 0, zIndex: 200 }} onClick={() => setOpen(false)} />
            <div
              className="card"
              style={{
                position: "fixed",
                top: pos.top,
                left: pos.left,
                width: MENU_WIDTH,
                zIndex: 201,
                padding: 4,
                boxShadow: "0 4px 14px rgba(0,0,0,0.18)",
              }}
            >
              {items.map((item, i) => {
                const color = item.tone === "danger" ? "var(--danger-text)" : item.tone === "success" ? "var(--success-text)" : "var(--text)";
                return (
                  <button
                    key={i}
                    onClick={(e) => choose(e, item.onClick)}
                    disabled={item.disabled}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      width: "100%",
                      textAlign: "left",
                      background: "none",
                      border: "none",
                      cursor: item.disabled ? "default" : "pointer",
                      opacity: item.disabled ? 0.5 : 1,
                      color,
                      fontSize: 12,
                      padding: "6px 8px",
                      borderRadius: 4,
                    }}
                    className="row-menu-item"
                  >
                    {item.icon}
                    {item.label}
                  </button>
                );
              })}
            </div>
          </>,
          document.body
        )}
    </span>
  );
}
