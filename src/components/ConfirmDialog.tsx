import { AlertTriangle } from "lucide-react";

interface ConfirmDialogProps {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

// Centered, in-app replacement for window.confirm — Notion/browser-native
// confirm() dialogs can't be styled or positioned and look out of place next
// to the rest of the app's UI, so every destructive action routes through
// this instead (see useConfirm.tsx for the hook that drives it).
export default function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,41,66,0.35)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 200,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--surface)",
          borderRadius: "var(--radius-md)",
          boxShadow: "0 12px 32px rgba(15,41,66,0.24)",
          padding: 20,
          width: 340,
          maxWidth: "calc(100vw - 32px)",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 14 }}>
          {danger && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, borderRadius: "50%", background: "var(--danger-bg)", color: "var(--danger-text)", flexShrink: 0 }}>
              <AlertTriangle size={15} />
            </div>
          )}
          <div>
            {title && <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--navy)", marginBottom: 4 }}>{title}</div>}
            <div style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>{message}</div>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            onClick={onCancel}
            style={{ fontSize: 12, fontWeight: 500, color: "var(--text-secondary)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "6px 12px", cursor: "pointer" }}
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "#fff",
              background: danger ? "var(--danger-text)" : "var(--accent)",
              border: "none",
              borderRadius: "var(--radius-sm)",
              padding: "6px 12px",
              cursor: "pointer",
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
