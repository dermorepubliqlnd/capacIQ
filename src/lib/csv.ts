// Small, dependency-free CSV parser -- handles quoted fields (commas,
// newlines, escaped "" inside quotes) since names/notes could plausibly
// contain a comma. Not a general RFC-4180 library, just enough for the
// User Management bulk-import CSV (a handful of short text/number columns).
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // Normalize line endings up front so \r\n and \r alone behave like \n.
  const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  // Final field/row (files don't always end with a trailing newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop fully-blank trailing rows (common when a spreadsheet app adds a
  // trailing newline).
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

/** Parses a CSV into header-keyed row objects. Header matching is
 * case-insensitive and trims whitespace, so "Employee ID", "employee id",
 * and " Employee ID " all resolve the same way. */
export function parseCsvToObjects(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const table = parseCsv(text);
  if (table.length === 0) return { headers: [], rows: [] };
  const headers = table[0].map((h) => h.trim());
  const rows = table.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = (r[i] ?? "").trim();
    });
    return obj;
  });
  return { headers, rows };
}

/** Finds a value in a parsed row object by trying a list of acceptable
 * header-name variants, case-insensitively. Lets the template be forgiving
 * of small header wording differences (e.g. "Capacity/Day" vs "Capacity
 * per Day") without silently dropping the column. */
export function getField(row: Record<string, string>, ...names: string[]): string {
  const keys = Object.keys(row);
  for (const name of names) {
    const key = keys.find((k) => k.toLowerCase() === name.toLowerCase());
    if (key) return row[key];
  }
  return "";
}

/** Builds a downloadable CSV string from header + row arrays -- used for
 * both the "Download template" button and could be reused for any future
 * CSV export. Quotes any field containing a comma, quote, or newline. */
export function toCsv(headers: string[], rows: (string | number)[][]): string {
  function escapeCell(v: string | number): string {
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }
  const lines = [headers.map(escapeCell).join(","), ...rows.map((r) => r.map(escapeCell).join(","))];
  return lines.join("\n");
}
