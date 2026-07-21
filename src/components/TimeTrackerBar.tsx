import { useEffect, useState } from "react";
import { Clock, Square, AlertCircle } from "lucide-react";
import { useTimeTracking } from "../lib/TimeTrackingContext";
import ConfirmTimeEntryModal from "./ConfirmTimeEntryModal";

function elapsedLabel(startedAt: string, now: number): string {
  const secs = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// Sits at the bottom of every screen (mounted once in AppLayout) so a
// running timer stays visible while navigating anywhere else in the app --
// otherwise it'd be easy to forget a timer is running once you've clicked
// away from the Tasks table. Also surfaces a quiet reminder if there are
// unconfirmed entries waiting (stopped or auto-stopped, not yet locked
// in), since those don't block anything and could otherwise sit forgotten.
export default function TimeTrackerBar() {
  const { running, pendingConfirm, busy, requestStop, refresh, openConfirmModalFor, setOpenConfirmModalFor } = useTimeTracking();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  const modalEntry = pendingConfirm.find((e) => e.id === openConfirmModalFor) ?? null;

  if (!running && pendingConfirm.length === 0) return null;

  return (
    <>
      <div
        style={{
          position: "fixed",
          left: 208,
          right: 0,
          bottom: 0,
          zIndex: 40,
          background: "var(--navy-deep, var(--navy))",
          color: "#fff",
          padding: "8px 18px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 12.5,
          boxShadow: "0 -2px 8px rgba(0,0,0,0.12)",
        }}
      >
        {running ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Clock size={14} color="var(--teal, #4fd1c5)" />
            <span>
              Timing <strong>{running.task_name}</strong>
            </span>
            <span style={{ fontVariantNumeric: "tabular-nums", opacity: 0.85 }}>{elapsedLabel(running.started_at, now)}</span>
          </div>
        ) : (
          <div />
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {pendingConfirm.length > 0 && (
            <button
              onClick={() => setOpenConfirmModalFor(pendingConfirm[0].id)}
              style={{ display: "flex", alignItems: "center", gap: 5, background: "none", border: "none", color: "#ffd479", fontSize: 12, cursor: "pointer" }}
            >
              <AlertCircle size={13} />
              {pendingConfirm.length} unconfirmed {pendingConfirm.length === 1 ? "entry" : "entries"}
            </button>
          )}
          {running && (
            <button
              onClick={() => requestStop()}
              disabled={busy}
              style={{ display: "flex", alignItems: "center", gap: 5, background: "#fff", color: "var(--navy)", border: "none", borderRadius: "var(--radius-sm)", padding: "5px 12px", fontWeight: 600, fontSize: 12, cursor: "pointer" }}
            >
              <Square size={11} fill="var(--navy)" />
              Stop
            </button>
          )}
        </div>
      </div>
      {modalEntry && (
        <ConfirmTimeEntryModal
          entry={modalEntry}
          onClose={() => setOpenConfirmModalFor(null)}
          onDone={() => {
            setOpenConfirmModalFor(null);
            refresh();
          }}
        />
      )}
    </>
  );
}
