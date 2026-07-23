import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { OptionGroup } from "../lib/notionOptions";
import { formatDate } from "../lib/formatDate";

interface BaseProps {
  editable: boolean;
  emptyLabel?: string;
}

interface InlineTextProps extends BaseProps {
  value: string;
  onCommit: (value: string) => void;
  bold?: boolean;
}

export function InlineText({ value, onCommit, editable, bold, emptyLabel = "—" }: InlineTextProps) {
  const [draft, setDraft] = useState(value);
  if (!editable) return <span style={bold ? { fontWeight: 600, color: "var(--navy)" } : undefined}>{value || emptyLabel}</span>;
  return (
    <input
      className="inline-cell"
      spellCheck={false}
      autoComplete="off"
      style={bold ? { fontWeight: 600, color: "var(--navy)" } : undefined}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setDraft(value)}
      onBlur={() => {
        if (draft !== value && draft.trim()) onCommit(draft.trim());
        else setDraft(value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

interface InlineSelectProps extends BaseProps {
  value: string;
  onCommit: (value: string) => void;
  options: string[] | OptionGroup[];
  allowEmpty?: boolean;
  renderReadOnly?: (value: string) => React.ReactNode;
  // Optional display-text mapper for each <option> in the edit dropdown
  // (e.g. Priority prefixing "Low" -> "↓ Low") -- the underlying stored
  // value/onCommit argument is always the raw option string, only the
  // visible label changes.
  labelFor?: (value: string) => string;
}

function isGrouped(options: string[] | OptionGroup[]): options is OptionGroup[] {
  return options.length > 0 && typeof options[0] !== "string";
}

export function InlineSelect({ value, onCommit, options, editable, allowEmpty, emptyLabel = "—", renderReadOnly, labelFor }: InlineSelectProps) {
  const [isEditing, setIsEditing] = useState(false);
  const selectRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (isEditing && selectRef.current) {
      selectRef.current.focus();
      // Progressive enhancement: open the native picker immediately on click
      // (Chrome 121+/similar). Falls back silently to a focused, unopened
      // select on browsers without showPicker() for <select>.
      const el = selectRef.current as HTMLSelectElement & { showPicker?: () => void };
      try {
        el.showPicker?.();
      } catch {
        // ignore — requires a user gesture in some browsers, focus is enough
      }
    }
  }, [isEditing]);

  if (!editable) return <>{renderReadOnly ? renderReadOnly(value) : value || emptyLabel}</>;

  if (!isEditing) {
    return (
      <span className="inline-select-trigger" onClick={() => setIsEditing(true)}>
        {renderReadOnly ? renderReadOnly(value) : value || emptyLabel}
      </span>
    );
  }

  const grouped = isGrouped(options);
  return (
    <select
      ref={selectRef}
      className="inline-cell"
      value={value}
      onChange={(e: ChangeEvent<HTMLSelectElement>) => {
        onCommit(e.target.value);
        setIsEditing(false);
      }}
      onBlur={() => setIsEditing(false)}
      onClick={(e) => e.stopPropagation()}
    >
      {allowEmpty && <option value="">{emptyLabel}</option>}
      {grouped
        ? (options as OptionGroup[]).map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.options.map((o) => (
                <option key={o} value={o}>
                  {labelFor ? labelFor(o) : o}
                </option>
              ))}
            </optgroup>
          ))
        : (options as string[]).map((o) => (
            <option key={o} value={o}>
              {labelFor ? labelFor(o) : o}
            </option>
          ))}
    </select>
  );
}

interface InlineDateProps extends BaseProps {
  value: string | null;
  onCommit: (value: string) => void;
}

export function InlineDate({ value, onCommit, editable, emptyLabel = "—" }: InlineDateProps) {
  if (!editable) return <>{formatDate(value, emptyLabel)}</>;
  return (
    <input
      className="inline-cell"
      type="date"
      value={value ?? ""}
      onChange={(e) => onCommit(e.target.value)}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

interface InlineNumberProps extends BaseProps {
  value: number | null;
  onCommit: (value: number | null) => void;
  step?: number;
}

export function InlineNumber({ value, onCommit, editable, step = 0.5, emptyLabel = "—" }: InlineNumberProps) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  if (!editable) return <>{value ?? emptyLabel}</>;
  return (
    <input
      className="inline-cell"
      type="number"
      step={step}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => setDraft(value === null ? "" : String(value))}
      onBlur={() => {
        const num = draft === "" ? null : Number(draft);
        if (num !== value) onCommit(num);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}
