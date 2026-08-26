import { useState, type CSSProperties } from "react";
import Modal from "./Modal";
import { formatDate } from "../lib/formatDate";
import { REASON_CATEGORY_OPTIONS } from "./RequestExtensionModal";

// Start Date's own request+approval flow (2026-08-26, Sandra: "disable
// change of start date when baseline is locked... but what if there
// needs to be a change... cases maybe that we have decided to start but
// would have to move"). Mirrors RequestExtensionModal (Due Date's own,
// shipped 2026-07-17) field-for-field -- same reason-category list, same
// notes requirement -- but a Start Date can legitimately move EARLIER as
// well as later (a due-date extension only ever moves later), so this
// doesn't carry over that component's `newDate > current` validity rule.
interface RequestStartDateModalProps {
  taskName: string;
  currentStartDate: string | null;
  onClose: () => void;
  onSubmit: (newStartDate: string, reasonCategory: string, reasonNotes: string) => Promise<void> | void;
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

export default function RequestStartDateModal({ taskName, currentStartDate, onClose, onSubmit }: RequestStartDateModalProps) {
  const [newStartDate, setNewStartDate] = useState("");
  const [reasonCategory, setReasonCategory] = useState(REASON_CATEGORY_OPTIONS[0]);
  const [reasonNotes, setReasonNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const valid = !!newStartDate && newStartDate !== currentStartDate && reasonNotes.trim().length > 0;

  async function handleSubmit() {
    if (!valid) return;
    setSubmitting(true);
    await onSubmit(newStartDate, reasonCategory, reasonNotes.trim());
    setSubmitting(false);
  }

  return (
    <Modal title={`Request Start Date change — ${taskName}`} onClose={onClose} width={420}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
          Current Start date:{" "}
          <strong style={{ color: "var(--navy)" }}>{currentStartDate ? formatDate(currentStartDate) : "Not set"}</strong>. This goes
          to your project owner (or their manager if you're the owner) for approval -- the Start date only moves once it's approved.
        </div>
        <div>
          <div style={fieldLabelStyle}>New Start date</div>
          <input type="date" value={newStartDate} onChange={(e) => setNewStartDate(e.target.value)} style={fieldStyle} />
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
            placeholder="Briefly explain why this task's Start date needs to move"
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
