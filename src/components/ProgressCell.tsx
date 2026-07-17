import { BarChart2, Hash, CircleDot } from "lucide-react";
import { TONE_STYLES } from "../lib/tableTypes";

export type ProgressDisplay = "bar" | "number" | "ring";

interface ProgressCellProps {
  // null = the project has no tasks (or none with effort set) to measure
  // progress from -- rendered as a dash rather than a misleading 0%.
  percent: number | null;
  tone: string;
  display: ProgressDisplay;
}

// Renders a project's Actual Progress in whichever of the 3 display modes
// the view has chosen (see ProgressDisplayToggle below), all driven by the
// same tone (color-banded by progressBand() in Projects.tsx) so switching
// modes never changes the color, only the shape.
export default function ProgressCell({ percent, tone, display }: ProgressCellProps) {
  const toneStyle = TONE_STYLES[tone] ?? TONE_STYLES.neutral;
  const value = percent ?? 0;
  const label = percent === null ? "—" : `${percent}%`;

  if (display === "number") {
    return (
      <span className="status-pill" style={{ background: toneStyle.bg, color: toneStyle.text }}>
        {label}
      </span>
    );
  }

  if (display === "ring") {
    const size = 20;
    const stroke = 2;
    const radius = (size - stroke) / 2;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference * (1 - value / 100);
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <svg width={size} height={size} style={{ transform: "rotate(-90deg)", flexShrink: 0 }}>
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--border)" strokeWidth={stroke} />
          {percent !== null && (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={toneStyle.text}
              strokeWidth={stroke}
              strokeDasharray={circumference}
              strokeDashoffset={offset}
              strokeLinecap="round"
            />
          )}
        </svg>
        <span style={{ fontSize: 11, fontWeight: 600, color: toneStyle.text }}>{label}</span>
      </div>
    );
  }

  // bar (default)
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", minWidth: 60 }}>
      <div style={{ width: 45, flexShrink: 0, height: 6, borderRadius: 3, background: "var(--border)", overflow: "hidden" }}>
        {percent !== null && <div style={{ width: `${value}%`, height: "100%", background: toneStyle.text, borderRadius: 3 }} />}
      </div>
      <span style={{ fontSize: 11, fontWeight: 600, color: toneStyle.text, flexShrink: 0, width: 30, textAlign: "right" }}>{label}</span>
    </div>
  );
}

const DISPLAY_ICONS: Record<ProgressDisplay, typeof BarChart2> = {
  bar: BarChart2,
  number: Hash,
  ring: CircleDot,
};
const DISPLAY_ORDER: ProgressDisplay[] = ["bar", "number", "ring"];

// Small header-embedded control that cycles bar -> number -> ring on
// click, mirroring Notion's per-property "Show as" setting without
// building a whole generic column-property-editor menu just for this one
// column. Stops propagation so clicking it doesn't also trigger the
// column header's own drag-to-reorder.
export function ProgressDisplayToggle({ value, onChange }: { value: ProgressDisplay; onChange: (next: ProgressDisplay) => void }) {
  const Icon = DISPLAY_ICONS[value];
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        const idx = DISPLAY_ORDER.indexOf(value);
        onChange(DISPLAY_ORDER[(idx + 1) % DISPLAY_ORDER.length]);
      }}
      onMouseDown={(e) => e.stopPropagation()}
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
      title={`Showing as: ${value}. Click to change.`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 16,
        height: 16,
        marginLeft: 4,
        padding: 0,
        border: "none",
        background: "none",
        color: "var(--muted)",
        cursor: "pointer",
        flexShrink: 0,
      }}
    >
      <Icon size={11} />
    </button>
  );
}
