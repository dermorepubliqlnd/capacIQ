import type { ReactNode } from "react";

export interface ColumnDef<T> {
  key: string;
  label: string;
  minWidth?: number;
  defaultWidth?: number;
  render: (row: T) => ReactNode;
}

export interface GroupOption<T> {
  key: string;
  label: string;
  getGroup: (row: T) => string;
  // Optional: tone of a representative row in the group, used to tint that
  // group's header row so it visually matches the pill color it's grouped
  // by (e.g. grouping by Status colors each header like its status pill).
  getTone?: (row: T) => string;
}

// Shared with the .status-pill classes in index.css so group headers and
// pills always agree on color for the same tone name.
export const TONE_STYLES: Record<string, { bg: string; text: string }> = {
  success: { bg: "var(--success-bg)", text: "var(--success-text)" },
  warning: { bg: "var(--warning-bg)", text: "var(--warning-text)" },
  danger: { bg: "var(--danger-bg)", text: "var(--danger-text)" },
  neutral: { bg: "var(--hover-bg)", text: "var(--muted)" },
  accent: { bg: "#eaf1fb", text: "var(--accent)" },
  purple: { bg: "#f3ecfa", text: "#7b4fb0" },
  pink: { bg: "#fdecf3", text: "#c1447e" },
};

export interface SortOption<T> {
  key: string;
  label: string;
  getValue: (row: T) => string | number | null;
}

export interface SortRule {
  key: string;
  direction: "asc" | "desc";
}

export function sortRows<T>(rows: T[], sorts: SortRule[], sortOptions: SortOption<T>[]): T[] {
  if (sorts.length === 0) return rows;
  const active = sorts.map((s) => ({ rule: s, option: sortOptions.find((o) => o.key === s.key) })).filter((x) => x.option);
  if (active.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const { rule, option } of active) {
      const av = option!.getValue(a);
      const bv = option!.getValue(b);
      let cmp = 0;
      if (av === null && bv === null) cmp = 0;
      else if (av === null) cmp = 1;
      else if (bv === null) cmp = -1;
      else if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
      else cmp = String(av).localeCompare(String(bv));
      if (rule.direction === "desc") cmp = -cmp;
      if (cmp !== 0) return cmp;
    }
    return 0;
  });
}

export interface TableView {
  id: string;
  name: string;
  columnOrder: string[];
  hiddenColumns: string[];
  columnWidths: Record<string, number>;
  groupBy: string | null;
  hiddenGroups: string[];
  color: string;
  showCount: boolean;
  sorts: SortRule[];
}

export type DefaultView = Omit<TableView, "id" | "name">;

export function widthOf<T>(col: ColumnDef<T>, view: TableView): number {
  return view.columnWidths[col.key] ?? col.defaultWidth ?? 140;
}

export function visibleOrderedColumns<T>(columns: ColumnDef<T>[], view: TableView): ColumnDef<T>[] {
  const known = columns.map((c) => c.key);
  const ordered = view.columnOrder.filter((k) => known.includes(k));
  const missing = known.filter((k) => !ordered.includes(k));
  return [...ordered, ...missing].filter((k) => !view.hiddenColumns.includes(k)).map((k) => columns.find((c) => c.key === k)!);
}
