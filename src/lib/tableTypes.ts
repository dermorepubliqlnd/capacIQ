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
}

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
