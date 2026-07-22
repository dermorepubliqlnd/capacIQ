import { AlertTriangle } from "lucide-react";
import { Fragment } from "react";

interface ConfirmDialogProps {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  // When true, renders as a plain OK-only notice (no Cancel button, no
  // danger styling implied) -- used for validation/error messages that
  // used to be window.alert(), so they match the app's own dialog style.
  hideCancel?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

// Splits a plain-text message into paragraphs, rendering any contiguous
// run of "- " prefixed lines as a real <ul><li> list instead of relying on
// literal "\n"s -- those collapse under normal CSS white-space and used to
// run every bullet together on one line (e.g. the pre-lock missing-fields
// summary). Non-bullet lines render as their own paragraph.
function renderMessage(message: string) {
  const lines = message.split("\n");
  const blocks: { type: "text" | "list"; lines: string[] }[] = [];
  for (const line of lines) {
    const isBullet = line.startsWith("- ");
    const last = blocks[blocks.length - 1];
    if (line.trim() === "") {
      blocks.push({ type: "text", lines: [""] });
      continue;
    }
    if (isBullet && last?.type === "list") {
      last.lines.push(line.slice(2));
    } else if (isBullet) {
      blocks.push({ type: "list", lines: [line.slice(2)] });
    } else if (!isBullet && last?.type === "text") {
      last.lines.push(line);
    } else {
      blocks.push({ type: "text", lines: [line] });
    }
  }
  return blocks.map((block, i) => {
    if (block.type === "list") {
      return (
        <ul key={i} style={{ margin: "4px 0", paddingLeft: 18 }}>
          {block.lines.map((l, j) => (
            <li key={j} style={{ marginBottom: 2 }}>
              {l}
            </li>
          ))}
        </ul>
      );
    }
    return (
      <Fragment key={i}>
        {block.lines.map((l, j) => (
          <div key={j}>{l || "\u00A0"}</div>
        ))}
      </Fragment>
    );
  });
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
  hideCancel = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <div
      onClick={hideCancel ? onConfirm : onCancel}
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
            <div style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>{renderMessage(message)}</div>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {!hideCancel && (
            <button
              onClick={onCancel}
              style={{ fontSize: 12, fontWeight: 500, color: "var(--text-secondary)", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "6px 12px", cursor: "pointer" }}
            >
              {cancelLabel}
            </button>
          )}
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
