import { useState, type CSSProperties } from "react";
import Modal from "./Modal";

// Free-text in the DB (extension_requests.reason_category), but a fixed
// picker in the UI keeps the data usable for later reporting (e.g. "what's
// the #1 reason projects slip") instead of everyone typing their own
// phrasing.
export const REASON_CATEGORY_OPTIONS = [
  "Scope Change",
  "Dependency Delay",
  "Resource Constraint",
  "Stakeholder/SME Delay",
  "Technical Issue",
  "Other",
];

interface RequestExtensionModalProps {
  taskName: string;
  currentDueDate: string;
  onClose: () => void;
  onSubmit: (newDueDate: string, reasonCategory: string, reasonNotes: string) => Promise<void> | void;
}

const fieldLabelStyle: CSSProperties = { fontSize: 11, fontWeight: 600, marginBottom: 4, color: "var(--navy)" };
const fieldStyle: CSSProperties = {
  width: "100%",
  fontSize: 12.5,
  padding: "6px 8px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  boxSizing: "border-box",
};

export default function RequestExtensionModal({ taskName, currentDueDate, onClose, onSubmit }: RequestExtensionModalProps) {
  const [newDueDate, setNewDueDate] = useState("");
  const [reasonCategory, setReasonCategory] = useState(REASON_CATEGORY_OPTIONS[0]);
  const [reasonNotes, setReasonNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const valid = newDueDate > currentDueDate && reasonNotes.trim().length > 0;

  async function handleSubmit() {
    if (!valid) return;
    setSubmitting(true);
    await onSubmit(newDueDate, reasonCategory, reasonNotes.trim());
    setSubmitting(false);
  }

  return (
    <Modal title={`Request extension — ${taskName}`} onClose={onClose} width={420}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
          Current due date: <strong style={{ color: "var(--navy)" }}>{currentDueDate}</strong>. This goes to your project
          owner (or their manager if you're the owner) for approval -- the due date only updates once it's approved.
        </div>
        <div>
          <div style={fieldLabelStyle}>New due date</div>
          <input
            type="date"
            value={newDueDate}
            min={currentDueDate}
            onChange={(e) => setNewDueDate(e.target.value)}
            style={fieldStyle}
          />
        </div>
        <div>
          <div style={fieldLabelStyle}>Reason</div>
          <select value={reasonCategory} onChange={(e) => setReasonCategory(e.target.value)} style={fieldStyle}>
            {REASON_CATEGORY_OPTIONS.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </div>
        <div>
          <div style={fieldLabelStyle}>Notes</div>
          <textarea
            value={reasonNotes}
            onChange={(e) => setReasonNotes(e.target.value)}
            rows={3}
            placeholder="Briefly explain why this task needs more time"
            style={{ ...fieldStyle, resize: "vertical", fontFamily: "inherit" }}
          />
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 2 }}>
          <button
            onClick={onClose}
            style={{ fontSize: 12, padding: "6px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", background: "none", cursor: "pointer", color: "var(--text)" }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !valid}
            style={{
              fontSize: 12,
              padding: "6px 14px",
              border: "none",
              borderRadius: "var(--radius-sm)",
              background: "var(--accent)",
              color: "#fff",
              cursor: submitting || !valid ? "default" : "pointer",
              opacity: submitting || !valid ? 0.55 : 1,
            }}
          >
            {submitting ? "Submitting…" : "Submit request"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
