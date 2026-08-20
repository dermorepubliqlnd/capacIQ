import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MoreVertical, Pencil, ShieldCheck, ShieldOff, KeyRound, Trash2 } from "lucide-react";
import type { Person } from "../lib/useSession";

// Row-level "..." action menu for User Management (2026-08-20 redesign).
// Replaces the old always-visible row of separate Edit/Deactivate/Reset
// password/Delete buttons with a single menu exposing only the actions
// valid for this person's current state -- Give login XOR Reset password
// depending on auth_user_id, Deactivate XOR Reactivate depending on
// is_active. Every menu item just calls straight through to the same
// handlers Admin.tsx already had (confirm dialogs, self-guards, Edge
// Function calls, etc. all unchanged) -- this component only owns the
// open/closed + position state for the popover itself.
//
// Popover mechanics mirror the existing click-outside-to-close pattern
// used for the dependency picker in WbsPlanning.tsx: a transparent
// fixed-inset backdrop underneath a `position: fixed` panel, both
// portaled to document.body so they escape the table's stacking/overflow
// context.
const MENU_WIDTH = 190;

interface UserRowMenuProps {
  person: Person;
  busy: boolean;
  onEdit: () => void;
  onGiveLogin: () => void;
  onResetPassword: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
}

export default function UserRowMenu({ person, busy, onEdit, onGiveLogin, onResetPassword, onToggleActive, onDelete }: UserRowMenuProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  function toggleOpen() {
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

  function choose(fn: () => void) {
    setOpen(false);
    fn();
  }

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggleOpen}
        title="More actions"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--muted)",
          padding: 4,
          borderRadius: 4,
        }}
      >
        <MoreVertical size={16} />
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
              <MenuItem icon={<Pencil size={13} />} label="Edit user" onClick={() => choose(onEdit)} />
              {person.auth_user_id ? (
                <MenuItem
                  icon={<KeyRound size={13} />}
                  label="Reset password"
                  onClick={() => choose(onResetPassword)}
                  disabled={busy}
                />
              ) : (
                <MenuItem
                  icon={<KeyRound size={13} />}
                  label="Give login"
                  onClick={() => choose(onGiveLogin)}
                  disabled={busy}
                />
              )}
              <MenuItem
                icon={person.is_active ? <ShieldOff size={13} /> : <ShieldCheck size={13} />}
                label={person.is_active ? "Deactivate" : "Reactivate"}
                onClick={() => choose(onToggleActive)}
                tone={person.is_active ? "danger" : "success"}
              />
              <MenuItem
                icon={<Trash2 size={13} />}
                label="Delete"
                onClick={() => choose(onDelete)}
                disabled={busy}
                tone="danger"
              />
            </div>
          </>,
          document.body
        )}
    </>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  disabled,
  tone,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: "danger" | "success";
}) {
  const color = tone === "danger" ? "var(--danger-text)" : tone === "success" ? "var(--success-text)" : "var(--text)";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        textAlign: "left",
        background: "none",
        border: "none",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        color,
        fontSize: 12,
        padding: "6px 8px",
        borderRadius: 4,
      }}
      className="row-menu-item"
    >
      {icon}
      {label}
    </button>
  );
}
