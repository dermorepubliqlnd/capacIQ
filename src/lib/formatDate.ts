// Formats an ISO date string ("yyyy-mm-dd", or the date part of a full
// timestamp) as mm/dd/yyyy for display. Exists so every place a date is
// shown as plain text matches what a native <input type="date"> already
// renders in this locale -- before this, read-only/computed date cells
// leaked the raw ISO storage format ("2026-08-31") right next to editable
// cells showing "08/31/2026", which read as inconsistent side by side.
export function formatDate(value: string | null | undefined, emptyLabel = "—"): string {
  if (!value) return emptyLabel;
  const datePart = value.slice(0, 10);
  const [y, m, d] = datePart.split("-");
  if (!y || !m || !d) return value;
  return `${m}/${d}/${y}`;
}
