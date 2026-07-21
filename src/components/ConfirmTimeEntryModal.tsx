import { useState } from "react";
import Modal from "./Modal";
import { confirmTimeEntry, formatDuration } from "../lib/timeTracking";

// The one edit-once step between "timer stopped" and "this time entry is
// permanently locked in". Shown automatically the moment a stop or an
// idle auto-stop produces a pending_confirm row (see TimeTrackingContext).
// After Confirm, the entry can only ever change again via a Full Access
// correction (see the Time Tracking log page) -- never a normal edit.

function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ConfirmTimeEntryModal({
  entry,
  onDone,
  onClose,
}: {
  entry: { id: string; task_name: string; started_at: string; ended_at: string; duration_minutes: number; auto_stopped: boolean };
  onDone: () => void;
  onClose: () => void;
}) {
  const [startedAt, setStartedAt] = useState(toLocalInputValue(entry.started_at));
  const [endedAt, setEndedAt] = useState(toLocalInputValue(entry.ended_at));
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const previewMinutes = Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 60000);

  async function handleConfirm() {
    setSaving(true);
    setError(null);
    const res = await confirmTimeEntry(entry.id, {
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      notes: notes.trim() || undefined,
    });
    setSaving(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    onDone();
  }

  return (
    <Modal title="Confirm time entry" onClose={onClose}>
      <div style={{ fontSize: 12.5 }}>
        {entry.auto_stopped && (
          <div className="status-pill warning" style={{ marginBottom: 10, display: "inline-block" }}>
            Auto-stopped after being idle -- please check these times
          </div>
        )}
        <p style={{ margin: "0 0 12px", color: "var(--muted)" }}>
          Timer on <strong style={{ color: "var(--navy)" }}>{entry.task_name}</strong>. You can adjust the start/end time once, before this locks
          in.
        </p>

        <label style={{ display: "block", marginBottom: 8 }}>
          <span style={{ display: "block", fontSize: 11, color: "var(--muted)", marginBottom: 3 }}>Start</span>
          <input
            type="datetime-local"
            value={startedAt}
            onChange={(e) => setStartedAt(e.target.value)}
            style={{ width: "100%", fontSize: 12, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", boxSizing: "border-box" }}
          />
        </label>
        <label style={{ display: "block", marginBottom: 8 }}>
          <span style={{ display: "block", fontSize: 11, color: "var(--muted)", marginBottom: 3 }}>End</span>
          <input
            type="datetime-local"
            value={endedAt}
            onChange={(e) => setEndedAt(e.target.value)}
            style={{ width: "100%", fontSize: 12, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", boxSizing: "border-box" }}
          />
        </label>
        <label style={{ display: "block", marginBottom: 10 }}>
          <span style={{ display: "block", fontSize: 11, color: "var(--muted)", marginBottom: 3 }}>Note (optional)</span>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. forgot to stop for lunch"
            style={{ width: "100%", fontSize: 12, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", boxSizing: "border-box" }}
          />
        </label>

        <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy)", marginBottom: 12 }}>
          Total: {formatDuration(previewMinutes > 0 ? previewMinutes : entry.duration_minutes)}
        </div>

        {error && <div style={{ color: "var(--danger-text)", fontSize: 11.5, marginBottom: 10 }}>{error}</div>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            disabled={saving}
            style={{ fontSize: 12, fontWeight: 600, color: "var(--muted)", background: "none", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", padding: "7px 14px", cursor: "pointer" }}
          >
            Review later
          </button>
          <button
            onClick={handleConfirm}
            disabled={saving || previewMinutes <= 0}
            style={{ fontSize: 12, fontWeight: 600, color: "#fff", background: "var(--accent)", border: "none", borderRadius: "var(--radius-sm)", padding: "7px 14px", cursor: "pointer" }}
          >
            {saving ? "Confirming…" : "Confirm -- lock it in"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
