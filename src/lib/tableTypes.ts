import type { ReactNode } from "react";

export interface ColumnDef<T> {
  key: string;
  // Usually a plain string, but a column can supply richer header content
  // (e.g. Actual Progress's inline bar/number/ring display-mode toggle) --
  // DataTable and the Properties checklist both just render this as a
  // child, so ReactNode works everywhere a string did.
  label: ReactNode;
  minWidth?: number;
  defaultWidth?: number;
  // Caps how far this column can be dragged wider — sized per column's
  // realistic max content (a name/title needs much more room than a date
  // or a short status word), so resizing can't blow a column out to an
  // unreasonable width.
  maxWidth?: number;
  render: (row: T) => ReactNode;
  // True for a column that must never be hidden via the Properties toggle
  // (e.g. Spent Hrs, once it became a computed rollup rather than a free-
  // typed number -- hiding it would make it look editable/removable when
  // it's really just a read-only derived total). The Properties popover
  // still lists it, checked and disabled, so it's clear it's intentional
  // rather than missing.
  alwaysVisible?: boolean;
}

export interface GroupOption<T> {
  key: string;
  label: string;
  getGroup: (row: T) => string;
  // Optional: tone of a representative row in the group, used to tint that
  // group's header row so it visually matches the pill color it's grouped
  // by (e.g. grouping by Status colors each header like its status pill).
  getTone?: (row: T) => string;
  // False for properties that can't sensibly become Kanban columns (free
  // text, dates, computed percentages) -- shown in the Group-by dropdown
  // but disabled/greyed rather than omitted, so users can see *why* a
  // property isn't offered instead of wondering where it went. Only
  // consulted when the dropdown is rendered in "board" mode; Table's own
  // grouped-accordion view ignores this and treats every listed option as
  // usable, since accordion sections don't have Board's fixed-column
  // constraint.
  boardGroupable?: boolean;
  // Optional: every group name that should render even with zero matching
  // rows right now (e.g. every project's name, so a brand-new project
  // with no tasks yet still gets a group section instead of silently not
  // appearing at all in Table's grouped-accordion view). Table-view only;
  // Board already renders one column per possible value some other way.
  allGroups?: () => string[];
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
  // Gold: Project Status "Development" needs its own distinct hue from
  // "warning" (used by Planning/Evaluation/Merged) to match Notion's
  // status-color palette (see project_capaciq_status_colors memory).
  gold: { bg: "#fdf6e3", text: "#a3790a" },
  // Light green: "Near Completion" (80-99%) band of the new Actual
  // Progress property -- a paler tint than "success" (used for both
  // "Done" status and 100% Completed) so the two remain visually
  // distinct at a glance.
  mint: { bg: "#eef8f2", text: "#3f9d6e" },
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

export type ViewType = "table" | "board" | "calendar" | "timeline";

export interface TableView {
  id: string;
  name: string;
  // Which layout this view renders as. Only "table" is actually built right
  // now -- Board/Calendar/Timeline exist as a forward-compatible field plus
  // placeholder tiles in the "Add view" picker (see ViewTabs.tsx) so people
  // can see what's coming without it being selectable yet.
  viewType: ViewType;
  columnOrder: string[];
  hiddenColumns: string[];
  columnWidths: Record<string, number>;
  groupBy: string | null;
  hiddenGroups: string[];
  color: string;
  showCount: boolean;
  sorts: SortRule[];
  // Per-view display mode for the Actual Progress property (bar with a
  // numeric label, a plain number pill, or a ring) -- optional so it
  // doesn't force a migration of every already-saved view; callers should
  // fall back to "bar" when reading an older view that predates this
  // field. See ProgressCell.tsx.
  progressDisplay?: "bar" | "number" | "ring";
  // Per-view Timeline settings -- both optional for the same reason as
  // progressDisplay above (older saved views predate Timeline and must
  // keep loading without a migration). Callers should fall back to
  // "month" / "range" when reading a view that predates these fields.
  // See TimelineView.tsx.
  timelineScale?: "day" | "week" | "month" | "quarter";
  timelineDateMode?: "range" | "start" | "due";
  // Row-level Filter (v1: "assigned to me" + a Status multi-select) --
  // optional for the same reason as progressDisplay/timelineScale above.
  // Undefined/false and undefined/empty both mean "no filter, show all",
  // matching how hiddenColumns/hiddenGroups empty arrays already mean
  // "nothing hidden" elsewhere in this file. Unlike Sort/Group-by/
  // Properties, this isn't rendering config -- callers apply it to the
  // shared row list before it's handed to whichever view (Table/Board/
  // Timeline) is active, so one filter setting covers all three.
  filterAssignedToMe?: boolean;
  filterStatuses?: string[];
}

export type DefaultView = Omit<TableView, "id" | "name">;

export function widthOf<T>(col: ColumnDef<T>, view: TableView): number {
  return view.columnWidths[col.key] ?? col.defaultWidth ?? 140;
}

export function visibleOrderedColumns<T>(columns: ColumnDef<T>[], view: TableView): ColumnDef<T>[] {
  const known = columns.map((c) => c.key);
  const ordered = view.columnOrder.filter((k) => known.includes(k));
  const missing = known.filter((k) => !ordered.includes(k));
  return [...ordered, ...missing]
    .filter((k) => {
      const col = columns.find((c) => c.key === k);
      return col?.alwaysVisible || !view.hiddenColumns.includes(k);
    })
    .map((k) => columns.find((c) => c.key === k)!);
}
