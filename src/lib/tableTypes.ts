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

export interface TableView {
  id: string;
  name: string;
  columnOrder: string[];
  hiddenColumns: string[];
  columnWidths: Record<string, number>;
  groupBy: string | null;
}

export type DefaultView = Omit<TableView, "id" | "name">;
