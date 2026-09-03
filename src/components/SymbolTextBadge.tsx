import { Circle, Rows3, Type as TypeIcon } from "lucide-react";

export type SymbolTextDisplay = "symbol" | "symbolText" | "text";

interface SymbolTextBadgeProps {
  // e.g. "↓" (Priority) or "△" (Complexity) -- see
  // PROJECT_PRIORITY_SYMBOLS/PROJECT_EFFORT_LEVEL_SYMBOLS in notionOptions.ts.
  symbol: string;
  // e.g. "Low" / "Level 1" -- the plain option name, no symbol baked in.
  text: string;
  tone: string;
  display: SymbolTextDisplay;
}

// Renders a Priority/Complexity value in whichever of the 3 display modes
// the view has chosen (see SymbolTextDisplayToggle below) -- mirrors
// ProgressCell.tsx's bar/number/ring pattern for Actual Progress, applied
// to any status-pill property that pairs a small directional/tier glyph
// with a text label. "symbol" shows just the glyph (title attr carries
// the full text so it's still readable on hover); "symbolText" is the
// original combined rendering everyone already sees today; "text" drops
// the glyph entirely.
export default function SymbolTextBadge({ symbol, text, tone, display }: SymbolTextBadgeProps) {
  if (!text) return <>—</>;
  const content = display === "symbol" ? symbol || text : display === "text" ? text : symbol ? `${symbol} ${text}` : text;
  return (
    <span className={`status-pill ${tone}`} title={display === "symbol" ? text : undefined}>
      {content}
    </span>
  );
}

// 2026-09-03 (Sandra: "there seems to be an alignment issue, it looks
// like it's not straight") -- lucide's "Shapes" icon (originally used
// for symbol-only mode) has extra whitespace baked into its own
// viewBox that makes it sit visibly lower than Rows3/Type inside the
// same fixed-size button, even though the button's own CSS centers
// all 3 identically. Swapped for "Circle", a simple icon that centers
// the same way Rows3/Type already do.
const DISPLAY_ICONS: Record<SymbolTextDisplay, typeof Circle> = {
  symbol: Circle,
  symbolText: Rows3,
  text: TypeIcon,
};
const DISPLAY_ORDER: SymbolTextDisplay[] = ["symbol", "symbolText", "text"];
const DISPLAY_HINT: Record<SymbolTextDisplay, string> = {
  symbol: "symbol only",
  symbolText: "symbol + text",
  text: "text only",
};

// Small header-embedded control that cycles symbol -> symbolText -> text
// on click, same interaction as ProgressDisplayToggle. Stops propagation
// so clicking it doesn't also trigger the column header's own
// drag-to-reorder.
export function SymbolTextDisplayToggle({ value, onChange }: { value: SymbolTextDisplay; onChange: (next: SymbolTextDisplay) => void }) {
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
      title={`Showing as: ${DISPLAY_HINT[value]}. Click to change.`}
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
