import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, CornerDownRight, ChevronRight, ChevronDown, ArchiveRestore, Trash2, Feather, Weight, BicepsFlexed, CalendarClock, CheckCircle2, Lock, Unlock, X, RotateCcw } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useSession } from "../lib/useSession";
import { useTableViews } from "../lib/useTableViews";
import DataTable from "../components/DataTable";
import BoardView, { type BoardColumnDef } from "../components/BoardView";
import TimelineView, { TimelineControls } from "../components/TimelineView";
import CalendarView from "../components/CalendarView";
import ViewTabs from "../components/ViewTabs";
import ViewSettingsMenu, { ViewFilterPills } from "../components/ViewSettingsMenu";
import Modal from "../components/Modal";
import RequestExtensionModal from "../components/RequestExtensionModal";
import { useConfirm } from "../lib/useConfirm";
import { InlineText, InlineSelect, InlineDate, InlineNumber } from "../components/InlineCell";
import ProgressCell, { ProgressDisplayToggle } from "../components/ProgressCell";
import type { ColumnDef, GroupOption, SortOption } from "../lib/tableTypes";
import { sortRows, sortRowsHierarchical, visibleOrderedColumns, resolveFilterPersonIds } from "../lib/tableTypes";
import { formatDate } from "../lib/formatDate";
import { rollupHoursFor, ownHoursFor, formatHours, type TimeEntryRow } from "../lib/timeTracking";
import { useTimeTracking } from "../lib/TimeTrackingContext";
import { Play, Square } from "lucide-react";
import {
  PROJECT_CATEGORY_OPTIONS,
  PROJECT_CATEGORY_TONES,
  PROJECT_EFFORT_LEVEL_OPTIONS,
  PROJECT_EFFORT_LEVEL_TONES,
  PROJECT_PRIORITY_OPTIONS,
  PROJECT_STATUS_GROUPED,
  PROJECT_STATUS_OPTIONS,
  PROJECT_STATUS_TONES,
  TASK_STATUS_GROUPED,
  TASK_STATUS_OPTIONS,
  PROJECT_CATEGORY_ICONS,
  DEFAULT_PROJECT_ICON,
  TASK_EFFORT_OPTIONS,
  TASK_EFFORT_POINTS,
  TASK_EFFORT_DEFAULT_TONES,
  statusGroupOf,
} from "../lib/notionOptions";

interface PersonOption {
  id: string;
  name: string;
}

interface ProjectRow {
  id: string;
  name: string;
  owner_id: string | null;
  category: string | null;
  priority: "Low" | "Medium" | "High" | null;
  project_status: string | null;
  effort_level: string | null;
  start_date: string | null;
  end_date: string | null;
  is_archived: boolean;
  archived_at: string | null;
  sort_order: number | null;
  timelines_locked: boolean;
  original_start_date: string | null;
  original_due_date: string | null;
}

interface TaskRow {
  id: string;
  project_id: string;
  parent_task_id: string | null;
  name: string;
  status: string | null;
  assignee_id: string | null;
  start_date: string | null;
  original_due_date: string;
  current_due_date: string;
  estimated_hours: number | null;
  time_spent_hours: number | null;
  // Self-reported by the assignee the moment status flips to Done --
  // distinct from validated_completion_date below, which is the owner/
  // manager's independent confirmation. See [[project_capaciq_extension_requests]].
  submitted_on: string | null;
  submitted_by: string | null;
  validated_completion_date: string | null;
  validated_by: string | null;
  effort: string | null;
  is_archived: boolean;
  archived_at: string | null;
  sort_order: number | null;
}

// Lightweight projection of extension_requests, fetched alongside
// projects/tasks so the Due Date Ext. column can show live status
// without a second round-trip. Ordered by created_at desc when fetched,
// so the first match per task_id is always the most recent request.
interface ExtensionRequestLite {
  id: string;
  task_id: string;
  status: "Pending" | "Approved" | "Rejected";
  requested_new_due_date: string;
  reason_category: string;
  reason_notes: string;
  decided_at: string | null;
  decision_notes: string | null;
  created_at: string;
}

type TaskWithDepth = TaskRow & { _depth: number };

const PROJECT_COLUMN_ORDER = ["name", "owner", "priority", "project_status", "health", "actual_progress", "estimated_hours", "time_spent_hours", "hours_variance", "hours_variance_pct", "category", "effort_level", "start_date", "end_date", "timelines_locked"];

// Default hidden-columns set for a brand-new Projects Timeline view (see
// timelineDefaultHiddenColumns on ViewTabs / initialHiddenColumns on
// createView) -- per Sandra's curated Timeline-chip spec, Category/Effort/
// Timelines(lock state)/Days Extended start hidden but stay available to
// turn on via Properties; Status/Owner/Priority/Health start visible.
const PROJECT_TIMELINE_DEFAULT_HIDDEN_COLUMNS = ["category", "effort_level", "timelines_locked", "days_extended", "estimated_hours", "time_spent_hours", "hours_variance", "hours_variance_pct"];
// Same idea for Tasks Timeline: "Days +/-" (Sandra: a signed day-count is
// redundant once you can already see a bar's length/position on the
// chart), Hrs Variance/%/Est./Spent (effort-tracking detail, not
// scheduling), Validated (a completion-approval flag, not a date signal),
// and Project (redundant with the swimlane header while the default
// grouping is "by Project" -- worth re-showing if grouping changes).
// All still available via Properties, just not cluttering a fresh
// Timeline view by default.
const TASK_TIMELINE_DEFAULT_HIDDEN_COLUMNS = ["project", "timing_variance_days", "estimated_hours", "time_spent_hours", "hours_variance", "hours_variance_pct", "validated_completion_date"];
// Task Calendar cards are much denser than a Timeline row -- Sandra asked
// specifically for Project/Effort/Assignee to show by default ("main
// focal point should be the task" -- Name is always the card's title
// regardless), everything else starts hidden but stays available via
// Properties. Unlike Timeline, Project stays visible here since Calendar
// has no swimlane/group-by-project header to make it redundant (Notion's
// own Calendar view doesn't support grouping either -- confirmed with
// Sandra, not building it).
const TASK_CALENDAR_DEFAULT_HIDDEN_COLUMNS = ["status", "timing", "due_date_ext", "validated_completion_date", "estimated_hours", "time_spent_hours", "timing_variance_days", "hours_variance", "hours_variance_pct"];
const TASK_COLUMN_ORDER = ["name", "project", "assignee", "status", "effort", "start_date", "current_due_date", "due_date_ext", "validated_completion_date", "estimated_hours", "time_spent_hours"];

// "Fun, not corporate" icons for Task Effort (Sandra's request) — a light
// feather for quick work, a weight plate for a moderate lift, and a flexed
// bicep for the heavy stuff. Colors are NOT hardcoded to these icons; the
// tone comes from task_effort_colors (DB-driven, Sandra can recolor each
// level herself) so the icon always inherits the pill's own darker tone
// via currentColor.
const TASK_EFFORT_ICON: Record<string, typeof Feather> = {
  Light: Feather,
  Moderate: Weight,
  Heavy: BicepsFlexed,
};

// A calendar day counts as a working day if it isn't a weekend and isn't
// in the Holiday calendar (Legal PH Holiday / Local Holiday / Internal
// Time Off -- all three block company-wide, per HolidayCalendar.tsx).
// Note this table is company-wide non-working days, not individual PTO --
// there's no per-person leave tracking in CapacIQ today, so an individual
// out on personal leave still counts as a working day for this formula.
function isWorkingDay(date: Date, holidayDates: Set<string>): boolean {
  const day = date.getDay();
  if (day === 0 || day === 6) return false;
  return !holidayDates.has(toDateKey(date));
}

function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Inclusive count of working days between two dates (start and end both
// count if they themselves are working days). Returns 0 if end < start.
function countWorkingDays(start: Date, end: Date, holidayDates: Set<string>): number {
  if (end < start) return 0;
  let count = 0;
  const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  while (cur <= last) {
    if (isWorkingDay(cur, holidayDates)) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// "Mark as Done?" suggestion dismissals (see healthOf's rule 1 below and
// project_capaciq_view_types memory): when actual progress hits 100% we
// SUGGEST closing the project out rather than auto-flipping project_status,
// so a PM/owner keeps control of exactly when a project is formally done.
// Dismissals are per-person, stored in localStorage (same convention as
// useTableViews.ts) -- not persisted server-side since this is just a UI
// nudge, not data. A dismissal is intentionally NOT permanent: if progress
// later drops below 100% (e.g. a new task is added) and climbs back to
// 100%, the suggestion re-earns the right to show again (see the
// pruning effect near the dismissedDoneSuggestions state below).
const DISMISSED_DONE_SUGGESTIONS_PREFIX = "capaciq_dismissed_done_suggestions";

function loadDismissedDoneSuggestions(storageKey: string): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const parsed = JSON.parse(raw) as string[];
      if (Array.isArray(parsed)) return new Set(parsed);
    }
  } catch {
    // ignore corrupt storage, fall through to empty
  }
  return new Set();
}

// Project Health compares actual weighted task progress against how far
// along the project *should* be, given how much of its working-day
// timeline has elapsed. Rules (in order -- first match wins):
//   0. Manually marked Done/Canceled/Merged -- echo that status verbatim
//      at neutral tone. A closed-out project never gets second-guessed by
//      the formula below (confirmed with Sandra 2026-07-17: a project
//      cancelled at 30% actual progress should read "Canceled", not
//      "Off track").
//   1. Actual progress is 100% -- Completed (green), regardless of dates.
//   2. Missing start or due date -- Health Unavailable (gray): rules 3-6
//      all need both dates to mean anything.
//   3. Today is before the start date -- Not Started (gray).
//   4. Due date has passed (and progress isn't 100%, already ruled out
//      above) -- Overdue (red). Checked before the expected-vs-actual
//      comparison since "expected" would otherwise just cap at 100% and
//      double-count the same lateness as "Off track".
//   5. No applicable tasks (actual progress is null, e.g. no task has
//      effort set) -- Health Unavailable (gray): nothing to compare
//      against expected progress.
//   6. Compare actual vs. expected progress (expected = working days
//      elapsed / total working days in the project's window, both
//      excluding weekends and Holiday-calendar dates): within 10 points
//      behind (or ahead) is On track (green), 11-20 points behind is At
//      risk (yellow), more than 20 points behind is Off track (red).
function healthOf(
  p: ProjectRow,
  allTasks: TaskRow[],
  holidayDates: Set<string>
): { label: string; tone: "success" | "warning" | "danger" | "neutral" } {
  const group = statusGroupOf(PROJECT_STATUS_GROUPED, p.project_status);
  if (group === "complete") return { label: p.project_status ?? "Completed", tone: "neutral" };

  const actual = actualProgress(p.id, allTasks);
  if (actual === 100) return { label: "Completed", tone: "success" };

  if (!p.start_date || !p.end_date) return { label: "Health unavailable", tone: "neutral" };

  const today = new Date();
  const start = parseLocalDate(p.start_date);
  const due = parseLocalDate(p.end_date);

  if (today < start) return { label: "Not started", tone: "neutral" };
  if (today > due) return { label: "Overdue", tone: "danger" };
  if (actual === null) return { label: "Health unavailable", tone: "neutral" };

  const totalWorkingDays = countWorkingDays(start, due, holidayDates);
  if (totalWorkingDays === 0) return { label: "Health unavailable", tone: "neutral" };
  const elapsedWorkingDays = countWorkingDays(start, today < due ? today : due, holidayDates);
  const expected = Math.min(100, Math.max(0, (elapsedWorkingDays / totalWorkingDays) * 100));

  const pointsBehind = expected - actual;
  if (pointsBehind <= 10) return { label: "On track", tone: "success" };
  if (pointsBehind <= 20) return { label: "At risk", tone: "warning" };
  return { label: "Off track", tone: "danger" };
}

// Actual Progress: a weighted completion percentage across a project's own
// (non-archived) tasks. Each task contributes its effort points (Light
// 0.5 / Moderate 1 / Heavy 2) as a "weight", multiplied by a completion
// factor based on its status (Not Started 0% / In Progress 50% / Done
// 100%) -- so a project with a few big Done tasks and many small
// Not-Started ones reads differently than raw task-count-complete would.
// Tasks with no effort set contribute zero weight to both sides of the
// ratio (in effect excluded, same as CapacIQ has no distinct "Cancelled"
// task status to exclude -- see project_capaciq_actual_progress memory).
// Returns null (not 0) when the project has no tasks, or none of them
// have effort set, so callers can render a distinct "No tasks" state
// instead of a misleading 0%.
const TASK_COMPLETION_FACTOR: Record<string, number> = {
  "Not Started": 0,
  "In Progress": 0.5,
  Done: 1,
};

function actualProgress(projectId: string, allTasks: TaskRow[]): number | null {
  const projectTasks = allTasks.filter((t) => t.project_id === projectId);
  if (projectTasks.length === 0) return null;
  let numerator = 0;
  let denominator = 0;
  for (const t of projectTasks) {
    const weight = t.effort ? TASK_EFFORT_POINTS[t.effort] ?? 0 : 0;
    if (weight === 0) continue;
    const factor = TASK_COMPLETION_FACTOR[t.status ?? ""] ?? 0;
    numerator += weight * factor;
    denominator += weight;
  }
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 100);
}

// Same 5-band read as Health (worst/least-done first) -- "No tasks" sorts
// alongside "Not started" since neither represents measurable progress.
function progressBand(percent: number | null): { label: string; tone: string } {
  if (percent === null) return { label: "No tasks", tone: "neutral" };
  if (percent === 0) return { label: "Not started", tone: "neutral" };
  if (percent < 40) return { label: "Early progress", tone: "danger" };
  if (percent < 80) return { label: "In progress", tone: "warning" };
  if (percent < 100) return { label: "Near completion", tone: "mint" };
  return { label: "Completed", tone: "success" };
}

// Severity order for sorting by Health: worst first (Overdue), then Due
// soon, On track, and finally completed projects' own status label.
function healthRank(label: string): number {
  if (label === "Overdue") return 0;
  if (label === "Off track") return 1;
  if (label === "At risk") return 2;
  if (label === "Not started") return 3;
  if (label === "On track") return 4;
  if (label === "Completed") return 5;
  if (label === "Health unavailable") return 6;
  return 7; // manually-echoed status labels (Canceled/Merged/etc.)
}

// Same worst-first idea as healthRank, for Tasks' analogous computed
// "Timing" column (Overdue/Due soon/On track while open, Late/On time once
// complete).
function timingRank(label: string): number {
  if (label === "Overdue") return 0;
  if (label === "Late") return 1;
  if (label === "Due soon") return 2;
  if (label === "On track") return 3;
  if (label === "Pending") return 4;
  if (label === "On time") return 5;
  if (label === "Early") return 6;
  return 7;
}

function priorityTone(priority: string | null): "success" | "warning" | "danger" | "neutral" {
  if (priority === "High") return "danger";
  if (priority === "Medium") return "warning";
  if (priority === "Low") return "success";
  return "neutral";
}

function statusTone(group: "to_do" | "in_progress" | "complete" | null): "success" | "warning" | "danger" | "neutral" {
  if (group === "complete") return "success";
  if (group === "in_progress") return "warning";
  return "neutral";
}

// Board view (v1) always groups by Status specifically -- it doesn't yet
// generalize to grouping by any field the way Table view's "Group by" does.
// Every exact status value gets its own column (not just the 3 To-do/In
// Progress/Complete buckets), matching Table view's Status pill exactly so
// dropping a card into a column sets an unambiguous, real status value.
// clusterLabel groups adjacent columns under one small section label so an
// 11-wide Projects board still reads with some structure.
const PROJECT_BOARD_COLUMNS: BoardColumnDef[] = PROJECT_STATUS_GROUPED.flatMap((group) =>
  group.options.map((value) => ({
    value,
    label: value,
    clusterLabel: group.label,
    tone: PROJECT_STATUS_TONES[value] ?? "neutral",
  }))
);

const TASK_BOARD_COLUMNS: BoardColumnDef[] = TASK_STATUS_GROUPED.flatMap((group) =>
  group.options.map((value) => ({
    value,
    label: value,
    clusterLabel: group.label,
    tone: statusTone(statusGroupOf(TASK_STATUS_GROUPED, value)),
  }))
);

// Task's computed "Timing" property is a small closed set (unlike the old
// Health formula, which could echo an open-ended literal status string) --
// so unlike Health, Timing is a reasonable Board grouping. Read-only: it's
// fully derived from dates/status, nothing to write back when a card is
// dragged.
const TASK_TIMING_BOARD_COLUMNS: BoardColumnDef[] = [
  { value: "Overdue", label: "Overdue", tone: "danger" },
  { value: "Due soon", label: "Due soon", tone: "warning" },
  { value: "On track", label: "On track", tone: "success" },
  { value: "Late", label: "Late", tone: "danger" },
  { value: "On time", label: "On time", tone: "success" },
  { value: "Early", label: "Early", tone: "success" },
  { value: "Pending", label: "Pending", tone: "neutral" },
];

// Board can group by any of these fields (their values form a fixed,
// enumerable set of Kanban columns); anything else (free text, dates,
// computed percentages) is marked boardGroupable: false on the relevant
// GroupOption instead and falls back to this list's first/default entry.
const PROJECT_BOARD_GROUPABLE_KEYS = ["project_status", "priority", "category", "effort_level", "owner", "timelines_locked"];
const TASK_BOARD_GROUPABLE_KEYS = ["status", "assignee", "effort", "project", "timing", "due_date_ext"];

function resolveBoardGroupBy(groupBy: string | null, groupableKeys: string[], fallback: string): string {
  return groupBy && groupableKeys.includes(groupBy) ? groupBy : fallback;
}

// Same idea as resolveBoardGroupBy above, but for Timeline: unlike Board
// (which can't render without a grouping and always falls back to a
// default field), a flat Timeline row list is a perfectly normal default
// state, so an unrecognized/unset groupBy resolves to null (ungrouped)
// rather than a forced fallback field.
function resolveTimelineGroupBy(groupBy: string | null, groupableKeys: string[]): string | null {
  return groupBy && groupableKeys.includes(groupBy) ? groupBy : null;
}

// Supabase date columns come back as plain "YYYY-MM-DD" strings. Passing
// that straight to `new Date(...)` parses it as UTC midnight, which in any
// timezone behind UTC silently rolls it back a calendar day (a task due
// "today" would parse as "yesterday" and read as overdue). Parsing the
// pieces directly as LOCAL date components avoids that shift entirely.
function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

// Whole-calendar-day difference (ignores time-of-day) so "due today" never
// reads as overdue — a day only counts as passed once the clock actually
// rolls into the next calendar date.
function calendarDaysBetween(a: Date, b: Date): number {
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const db = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((da.getTime() - db.getTime()) / (1000 * 60 * 60 * 24));
}

// The actual completion moment for Timing purposes: prefer the owner/
// manager-validated date once it exists (the authoritative record), but
// fall back to the assignee's own submitted_on stamp (set automatically
// the moment status flips to Done) rather than assuming On time by
// default. That old default silently hid genuinely late completions that
// simply hadn't been through Validate yet -- Sandra's report, 2026-07-21.
function actualCompletionDateOf(t: TaskRow): string | null {
  return t.validated_completion_date ?? t.submitted_on;
}

function timingOf(t: TaskRow): { label: string; tone: "success" | "warning" | "danger" | "neutral" } {
  const group = statusGroupOf(TASK_STATUS_GROUPED, t.status);
  const due = parseLocalDate(t.current_due_date);
  if (group === "complete") {
    const actualDateStr = actualCompletionDateOf(t);
    if (!actualDateStr) return { label: "Pending", tone: "neutral" };
    const days = calendarDaysBetween(parseLocalDate(actualDateStr.slice(0, 10)), due);
    if (days > 0) return { label: "Late", tone: "danger" };
    if (days < 0) return { label: "Early", tone: "success" };
    return { label: "On time", tone: "success" };
  }
  const daysLeft = calendarDaysBetween(due, new Date());
  if (daysLeft < 0) return { label: "Overdue", tone: "danger" };
  if (daysLeft <= 3) return { label: "Due soon", tone: "warning" };
  return { label: "On track", tone: "success" };
}

// Signed +/- days variance vs the due date -- positive means completed
// that many days late, negative means that many days early. null when
// there's no actual completion date to compare yet (task isn't Done, or
// Done but neither validated nor submitted -- shouldn't happen in
// practice since submitted_on is stamped automatically).
function timingVarianceDays(t: TaskRow): number | null {
  const group = statusGroupOf(TASK_STATUS_GROUPED, t.status);
  if (group !== "complete") return null;
  const actualDateStr = actualCompletionDateOf(t);
  if (!actualDateStr) return null;
  const due = parseLocalDate(t.current_due_date);
  return calendarDaysBetween(parseLocalDate(actualDateStr.slice(0, 10)), due);
}

// Est. vs Actual hours variance -- null when there's no estimate to
// compare against (can't meaningfully say "over/under budget" without
// one). Returned as both a signed hour delta and a completion percent
// (actual/estimated) so callers can render either the number or the
// ProgressCell visual off one calculation.
function hoursVarianceOf(t: TaskRow, spentHours: number): { hours: number; percent: number } | null {
  if (!t.estimated_hours) return null;
  return {
    hours: Math.round((spentHours - t.estimated_hours) * 100) / 100,
    percent: Math.round((spentHours / t.estimated_hours) * 100),
  };
}

function hoursVarianceTone(percent: number | null): "success" | "warning" | "danger" | "neutral" {
  if (percent === null) return "neutral";
  if (percent <= 100) return "success";
  if (percent <= 125) return "warning";
  return "danger";
}

// Project-level rollup of Estimated/Spent hours, mirroring the Task-level
// Est. hrs / Spent hrs / Hrs Variance / Hrs Variance % columns (Sandra,
// 2026-07-22: "roll up total estimated hours and spent hours... show same
// variances as how it's done in task level"). "Days +/-" is deliberately
// NOT rolled up here -- it's a signed day count vs one specific due date,
// which doesn't have a meaningful "sum" the way hours do; flagged to
// Sandra as an open question rather than guessed at.
//
// Estimated Hours is a flat, independently-set field on every task row
// (top-level or sub-task, no rollup relationship between them), so summing
// it across every task in the project is safe and complete on its own.
function projectEstimatedHoursTotal(projectId: string, allTasks: TaskRow[]): number | null {
  const withEstimate = allTasks.filter((t) => t.project_id === projectId && !t.is_archived && t.estimated_hours !== null && t.estimated_hours !== undefined);
  if (withEstimate.length === 0) return null;
  return Math.round(withEstimate.reduce((sum, t) => sum + (t.estimated_hours ?? 0), 0) * 100) / 100;
}

// Spent Hours can't be summed via spentHoursFor(taskId) the same way --
// that function already rolls a parent task's own entries together with
// its direct children's, so calling it once per task and summing the
// results would double-count any task whose parent is also being summed
// in the same loop. ownHoursFor only counts a task's own direct entries
// (no rollup), so summing it over every task in the project -- parent and
// child alike -- gives the true total exactly once, regardless of nesting
// depth.
function projectSpentHoursTotal(projectId: string, allTasks: TaskRow[], entries: TimeEntryRow[]): number {
  const projectTasks = allTasks.filter((t) => t.project_id === projectId && !t.is_archived);
  return Math.round(projectTasks.reduce((sum, t) => sum + ownHoursFor(entries, t.id), 0) * 100) / 100;
}

// Same shape as hoursVarianceOf, just fed project-level totals instead of
// one task's own estimated_hours/spentHours.
function projectHoursVarianceOf(estimatedTotal: number | null, spentTotal: number): { hours: number; percent: number } | null {
  if (!estimatedTotal) return null;
  return {
    hours: Math.round((spentTotal - estimatedTotal) * 100) / 100,
    percent: Math.round((spentTotal / estimatedTotal) * 100),
  };
}

function buildTaskTree(list: TaskRow[]): TaskWithDepth[] {
  const byParent = new Map<string, TaskRow[]>();
  list.forEach((t) => {
    const key = t.parent_task_id ?? "root";
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(t);
  });
  const result: TaskWithDepth[] = [];
  function walk(parentKey: string, depth: number) {
    (byParent.get(parentKey) ?? []).forEach((t) => {
      result.push({ ...t, _depth: depth });
      walk(t.id, depth + 1);
    });
  }
  walk("root", 0);
  return result;
}

// Small anchored dropdown for the bulk-action bar's field pickers (e.g.
// "Priority" -> Low/Medium/High). Deliberately minimal -- reuses the same
// .view-tab-dropdown look as other menus in this file rather than
// introducing a new visual style.
function FieldPickerButton({ label, options, onPick }: { label: string; options: string[]; onPick: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="bulk-bar-field-btn" onClick={() => setOpen((v) => !v)}>
        {label}
      </button>
      {open && (
        <div className="view-tab-dropdown" style={{ width: 170 }}>
          {options.map((o) => (
            <button
              key={o}
              onClick={() => {
                onPick(o);
                setOpen(false);
              }}
            >
              {o}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Notion-style fractional positioning: given the full ordered list (with
// each row's current sort_order) and a drag from `draggedId` onto
// `targetId`, returns the sort_order value that places the dragged row
// immediately before the target -- the midpoint between the target's
// previous neighbor and the target itself, so no other row needs to be
// renumbered.
// Measures the rendered height of a sticky "toolbar cluster" (view tabs +
// Sort/Group/Properties icons + filter pills + bulk-action bar). Currently
// only used to size the ref for the sticky cluster wrapper itself -- a
// true sticky column-header row (on top of the cluster) was attempted and
// reverted (see feedback_capaciq_sticky_header_attempt memory) because the
// table's own horizontal-scroll wrapper div silently becomes a vertical
// scroll container too (overflow-x/-y axis coupling), which broke
// position:sticky on the <thead> -- it stuck at the wrong offset and
// overlapped body rows instead of tracking real page scroll.
function useStickyOffset<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      setHeight(entries[0].contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, height] as const;
}

function reorderedSortValue(list: { id: string; sort_order: number | null }[], draggedId: string, targetId: string): number | null {
  const filtered = list.filter((r) => r.id !== draggedId);
  const idx = filtered.findIndex((r) => r.id === targetId);
  if (idx === -1) return null;
  const target = filtered[idx];
  const before = filtered[idx - 1];
  const afterVal = target.sort_order ?? (idx + 1) * 1000;
  const beforeVal = before ? before.sort_order ?? 0 : afterVal - 1000;
  return (beforeVal + afterVal) / 2;
}

// Tasks are always hard-deleted, never soft-archived-then-purged the way
// Projects are (see [[project_capaciq_archive_semantics]]) -- but
// extension_requests rows reference task_id with no ON DELETE CASCADE, so
// deleting a task that ever had a due-date extension request (approved,
// rejected, or pending) hits a foreign key violation: "update or delete on
// table "tasks" violates foreign key constraint
// "extension_requests_task_id_fkey"". Surfaced to Sandra 2026-07-22 via a
// raw Postgres error in a bulk-delete's alert() -- she noticed it
// correlated with having a sort applied, but the real trigger is simpler:
// sorting/grouping is often exactly how she finds and multi-selects a
// batch of tasks that share some trait (like extension history) worth
// cleaning up together, so sorted bulk-deletes are just more likely to
// include a task that has one. Every hard-delete path for tasks needs its
// dependent extension_requests rows cleared first -- centralized here so
// a future delete call site can't forget it and reintroduce the bug.
async function deleteTasksAndDependents(ids: string[]): Promise<{ error: string | null }> {
  if (ids.length === 0) return { error: null };
  const { error: extError } = await supabase.from("extension_requests").delete().in("task_id", ids);
  if (extError) return { error: extError.message };
  const { error } = await supabase.from("tasks").delete().in("id", ids);
  return { error: error?.message ?? null };
}

export default function Projects() {
  const { person: me } = useSession();
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [people, setPeople] = useState<PersonOption[]>([]);
  const [timeEntries, setTimeEntries] = useState<TimeEntryRow[]>([]);
  const { running, busy: timerBusy, start: startTaskTimer, requestStop: stopRunningTimer, version: timeTrackingVersion } = useTimeTracking();
  // Non-working dates (Legal PH Holiday / Local Holiday / Internal Time
  // Off, from the Holiday calendar module) -- fed into Health's expected-
  // progress calculation so "working days elapsed" excludes them the same
  // way the Day Planner already does. Stored as "YYYY-MM-DD" strings.
  const [holidayDates, setHolidayDates] = useState<Set<string>>(new Set());

  const dismissedDoneSuggestionsKey = `${DISMISSED_DONE_SUGGESTIONS_PREFIX}_${me?.id ?? "anon"}`;
  const [dismissedDoneSuggestions, setDismissedDoneSuggestions] = useState<Set<string>>(() =>
    loadDismissedDoneSuggestions(dismissedDoneSuggestionsKey)
  );

  // Re-load from localStorage if the signed-in person changes (mirrors
  // useTableViews.ts's storageKey-keyed reload pattern).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setDismissedDoneSuggestions(loadDismissedDoneSuggestions(dismissedDoneSuggestionsKey));
  }, [dismissedDoneSuggestionsKey]);

  useEffect(() => {
    localStorage.setItem(dismissedDoneSuggestionsKey, JSON.stringify(Array.from(dismissedDoneSuggestions)));
  }, [dismissedDoneSuggestions, dismissedDoneSuggestionsKey]);

  // A dismissal only "sticks" while progress stays at 100. If a project's
  // actual progress drops back below 100 (e.g. a new task got added) the
  // dismissal is cleared, so the suggestion can surface again next time it
  // genuinely re-hits 100%.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setDismissedDoneSuggestions((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set(prev);
      for (const id of prev) {
        if (actualProgress(id, tasks) !== 100) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [tasks]);
  const [extensionRequests, setExtensionRequests] = useState<ExtensionRequestLite[]>([]);
  const [loading, setLoading] = useState(true);
  // See loadAll() below -- only gates the *first* load's placeholder.
  const hasLoadedOnce = useRef(false);

  const [collapsedParents, setCollapsedParents] = useState<string[]>([]);
  const { confirm, alert, dialog: confirmDialog } = useConfirm();

  const [extensionTask, setExtensionTask] = useState<TaskWithDepth | null>(null);
  const [extensionProject, setExtensionProject] = useState<ProjectRow | null>(null);
  const [extDetailTask, setExtDetailTask] = useState<TaskWithDepth | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archivedProjects, setArchivedProjects] = useState<ProjectRow[]>([]);
  const [archivedTasks, setArchivedTasks] = useState<TaskRow[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);

  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);

  const [projectClusterRef, projectClusterHeight] = useStickyOffset<HTMLDivElement>();
  const [taskClusterRef, taskClusterHeight] = useStickyOffset<HTMLDivElement>();

  const isFullAccess = me?.access_level === "full";
  const ARCHIVE_RETENTION_DAYS = 30;

  // Best-effort purge: anything archived more than 30 days ago gets
  // permanently deleted the next time someone with delete rights (the
  // project's owner or Full Access) loads this page. There's no server-side
  // cron for this, so it relies on the app being opened regularly.
  async function purgeExpiredArchives() {
    const cutoff = new Date(Date.now() - ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    // Fetch ids first rather than a direct filtered .delete() -- expired
    // tasks need their extension_requests rows cleared first too (see
    // deleteTasksAndDependents above), which needs a concrete id list to
    // target.
    const { data: expiredTasks } = await supabase.from("tasks").select("id").eq("is_archived", true).lt("archived_at", cutoff);
    await deleteTasksAndDependents((expiredTasks ?? []).map((t) => t.id));
    await supabase.from("projects").delete().eq("is_archived", true).lt("archived_at", cutoff);
  }

  async function loadAll() {
    setLoading(true);
    purgeExpiredArchives();
    const [{ data: projectData }, { data: taskData }, { data: peopleData }, { data: holidayData }, { data: extReqData }, { data: timeEntryData }] = await Promise.all([
      supabase.from("projects").select("*").eq("is_archived", false).order("sort_order"),
      supabase.from("tasks").select("*").eq("is_archived", false).order("sort_order"),
      supabase.from("people").select("id,name").eq("is_active", true).order("name"),
      supabase.from("holidays").select("date"),
      supabase
        .from("extension_requests")
        .select("id,task_id,status,requested_new_due_date,reason_category,reason_notes,decided_at,decision_notes,created_at")
        .order("created_at", { ascending: false }),
      // Only confirmed/approved/legacy entries actually count toward Spent
      // Hrs (see rollupHoursFor) -- fetching just those keeps this list
      // small instead of pulling every running/pending/rejected row too.
      supabase.from("time_entries").select("*").in("status", ["confirmed", "approved"]),
    ]);
    const nextProjects = (projectData as ProjectRow[]) ?? [];
    const nextTasks = (taskData as TaskRow[]) ?? [];
    setProjects(nextProjects);
    setTasks(nextTasks);
    setPeople((peopleData as PersonOption[]) ?? []);
    setHolidayDates(new Set(((holidayData as { date: string }[]) ?? []).map((h) => h.date)));
    setExtensionRequests((extReqData as ExtensionRequestLite[]) ?? []);
    setTimeEntries((timeEntryData as TimeEntryRow[]) ?? []);
    // Drop any selection for rows that no longer exist in the fresh load
    // (e.g. after a bulk delete) so the bulk-action bar doesn't linger.
    const projectIds = new Set(nextProjects.map((p) => p.id));
    const taskIds = new Set(nextTasks.map((t) => t.id));
    setSelectedProjectIds((prev) => prev.filter((id) => projectIds.has(id)));
    setSelectedTaskIds((prev) => prev.filter((id) => taskIds.has(id)));
    setLoading(false);
    hasLoadedOnce.current = true;
  }

  async function loadArchived() {
    setArchivedLoading(true);
    const [{ data: projectData }, { data: taskData }] = await Promise.all([
      supabase.from("projects").select("*").eq("is_archived", true).order("archived_at", { ascending: false }),
      supabase.from("tasks").select("*").eq("is_archived", true).order("archived_at", { ascending: false }),
    ]);
    setArchivedProjects((projectData as ProjectRow[]) ?? []);
    setArchivedTasks((taskData as TaskRow[]) ?? []);
    setArchivedLoading(false);
  }

  useEffect(() => {
    loadAll();
  }, []);

  // A confirmed time entry (or a Full Access correction) can change what
  // Spent Hrs should show for a task -- but both happen from outside this
  // page (the tracker bar's confirm modal, or the Time Tracking log), so
  // this page has no other way to learn about it. Re-running loadAll on
  // every version bump keeps the rollup accurate without a full reload.
  useEffect(() => {
    if (timeTrackingVersion > 0) loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeTrackingVersion]);

  const ownerName = (id: string | null) => people.find((p) => p.id === id)?.name ?? "—";
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "—";
  const taskName = (id: string | null) => tasks.find((t) => t.id === id)?.name ?? "—";
  const isProjectOwner = (projectId: string) => projects.find((p) => p.id === projectId)?.owner_id === me?.id;
  const canEditProject = (p: ProjectRow) => isFullAccess || p.owner_id === me?.id;

  // Should we show the "Mark as Done?" suggestion chip for this project?
  // Deliberately a suggestion, not an auto-set of project_status -- see the
  // dismissal-helper comment above for why.
  function shouldSuggestDone(p: ProjectRow): boolean {
    if (statusGroupOf(PROJECT_STATUS_GROUPED, p.project_status) === "complete") return false;
    if (dismissedDoneSuggestions.has(p.id)) return false;
    return actualProgress(p.id, tasks) === 100;
  }

  function dismissDoneSuggestion(projectId: string) {
    setDismissedDoneSuggestions((prev) => {
      if (prev.has(projectId)) return prev;
      return new Set(prev).add(projectId);
    });
  }
  const canManageTasksIn = (projectId: string) => isFullAccess || isProjectOwner(projectId);
  const canEditTask = (t: TaskRow) => canManageTasksIn(t.project_id) || t.assignee_id === me?.id;
  // Once a task's completion has been validated (owner/manager's
  // independent sign-off, see the "Validated" column below), its editable
  // fields freeze -- Assignee, Status, Effort, Estimated Hours, and
  // Start/Due -- so nothing can silently drift out of sync with a record
  // that's already been signed off (Sandra, 2026-07-22: "if it's validated
  // then it can't be modified any more"). Reopening (clearing the
  // validation and unlocking these fields again) is a deliberate, visible
  // action restricted to Full Access only -- see the Reopen button in the
  // validated_completion_date column.
  const isTaskLocked = (t: TaskRow) => Boolean(t.validated_completion_date);
  const canCreateProject = isFullAccess;
  const canCreateTask = isFullAccess || projects.some((p) => p.owner_id === me?.id);
  // Scoping-phase due-date editing: a project's timelines are freely
  // editable (by owner/Full Access/assignee, same as canEditTask) until
  // explicitly locked. Locking re-stamps original_due_date = current_due_date
  // for every task in the project, then the DB trigger takes over exactly
  // as before. See [[project_capaciq_extension_requests]].
  const isProjectLocked = (projectId: string) => projects.find((p) => p.id === projectId)?.timelines_locked ?? false;

  // Project start/due are computed from their own tasks while a project
  // is still in Scoping -- earliest task start, latest task due -- rather
  // than a manually-typed guess. This mirrors the parent/sub-task rollup
  // below at one level up: project contains tasks the same way a parent
  // task contains sub-tasks, so the same "min start, max due" rule applies
  // at both levels. Once Locked, this stops mattering: start_date/end_date
  // become the frozen envelope, only movable via an approved Project
  // Extension Request (see decide_project_extension_request).
  function projectDatesFromTasks(projectId: string): { start: string | null; end: string | null } | null {
    const relevant = tasks.filter((t) => t.project_id === projectId && !t.is_archived && (t.start_date || t.current_due_date));
    if (relevant.length === 0) return null;
    const starts = relevant.map((t) => t.start_date).filter((d): d is string => !!d);
    const ends = relevant.map((t) => t.current_due_date).filter((d): d is string => !!d);
    return {
      start: starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : null,
      end: ends.length ? ends.reduce((a, b) => (a > b ? a : b)) : null,
    };
  }

  // Keeps a Scoping-phase project's start_date/end_date in sync with its
  // own tasks live, so opening the project shows an accurate plan instead
  // of a stale manual guess. Stops entirely once Locked -- the DB's own
  // projects_date_lock trigger would reject the write anyway, but this
  // effect just doesn't attempt it in the first place.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    projects.forEach((p) => {
      if (p.timelines_locked) return;
      const computed = projectDatesFromTasks(p.id);
      if (!computed) return;
      const patch: Partial<ProjectRow> = {};
      if (computed.start && computed.start !== p.start_date) patch.start_date = computed.start;
      if (computed.end && computed.end !== p.end_date) patch.end_date = computed.end;
      if (Object.keys(patch).length > 0) updateProject(p.id, patch);
    });
  }, [tasks]);

  // Same rollup, one level down: a parent task's own start/due are
  // computed from its sub-tasks' dates the same way a project's are
  // computed from its tasks. A task with no sub-tasks is unaffected
  // (behaves as a normal leaf task).
  // Spent Hrs stopped being a free-typed number the moment Time Tracking
  // shipped -- it's now a pure rollup of confirmed/approved/legacy
  // time_entries, same "own + every descendant's total" shape as the
  // date rollups below but summed instead of min/maxed. No write-back
  // needed (nothing else in the app reads tasks.time_spent_hours), so
  // this is display-only -- unlike the date rollups, there's no matching
  // useEffect syncing it into a DB column.
  function spentHoursFor(taskId: string): number {
    return rollupHoursFor(taskId, timeEntries, (id) => tasks.filter((t) => t.parent_task_id === id).map((t) => t.id));
  }

  function taskDatesFromSubtasks(parentId: string): { start: string | null; end: string | null } | null {
    const children = tasks.filter((t) => t.parent_task_id === parentId && !t.is_archived);
    if (children.length === 0) return null;
    const starts = children.map((t) => t.start_date).filter((d): d is string => !!d);
    const ends = children.map((t) => t.current_due_date).filter((d): d is string => !!d);
    return {
      start: starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : null,
      end: ends.length ? ends.reduce((a, b) => (a > b ? a : b)) : null,
    };
  }

  // Mirrors the project-level sync effect above, one level down: while
  // the project is unlocked, a parent task's own start/due stay synced to
  // its sub-tasks' dates. Skips tasks with no sub-tasks entirely (leaf
  // tasks are unaffected) and stops once the project locks (the due-date
  // lock trigger would reject the write anyway).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    tasks
      .filter((t) => t.parent_task_id === null)
      .forEach((parent) => {
        if (isProjectLocked(parent.project_id)) return;
        const computed = taskDatesFromSubtasks(parent.id);
        if (!computed) return;
        const patch: Partial<TaskRow> = {};
        if (computed.start && computed.start !== parent.start_date) patch.start_date = computed.start;
        if (computed.end && computed.end !== parent.current_due_date) {
          patch.current_due_date = computed.end;
          patch.original_due_date = computed.end;
        }
        if (Object.keys(patch).length > 0) updateTask(parent.id, patch);
      });
  }, [tasks]);

  // Due Date Ext. property: reflects the most recent extension_requests
  // row for a task, but only while its project is locked -- while a
  // project is still in Scoping, dates are freely editable and extension
  // tracking doesn't apply yet, so the pill always reads "No Extension"
  // there even if an older request exists from a previous locked period.
  // Sandra confirmed this behavior explicitly (2026-07-17).
  const taskExtensionRequests = (taskId: string) => extensionRequests.filter((r) => r.task_id === taskId);
  const latestExtensionRequest = (taskId: string) => taskExtensionRequests(taskId)[0] ?? null; // already ordered created_at desc

  function dueDateExtStatus(t: TaskRow): { label: string; tone: string } {
    if (!isProjectLocked(t.project_id)) return { label: "No Extension", tone: "neutral" };
    const latest = latestExtensionRequest(t.id);
    if (!latest) return { label: "No Extension", tone: "neutral" };
    if (latest.status === "Pending") return { label: "Requested", tone: "purple" };
    if (latest.status === "Rejected") return { label: "Rejected", tone: "danger" };
    return { label: "Extended", tone: "gold" };
  }

  // Pre-lock completeness gate: locking freezes whatever's in the plan as
  // the committed baseline, so a task missing effort/dates/assignee at
  // that moment stays invisible to Actual Progress/Health forever (or
  // until someone notices and fixes it well after the fact). Blocking the
  // lock action itself catches this at the one moment it's cheap to fix.
  // Full Access can still override, since there are legitimate edge cases
  // (e.g. a genuinely zero-effort placeholder task), but it's not the
  // default path.
  // Required before locking: a real task name (not the "Untitled task"
  // placeholder), Start date, Due date, Effort level, Estimated hours.
  // Assignee is deliberately NOT required -- a task can be scoped before
  // anyone's been assigned to it (confirmed with Sandra 2026-07-21;
  // shared/multi-person assignment is a separate, parked idea -- see
  // [[project_capaciq_time_tracking]]).
  function incompleteTasksFor(projectId: string): { task: TaskRow; missing: string[] }[] {
    return tasks
      .filter((t) => t.project_id === projectId && !t.is_archived)
      .map((t) => {
        const missing: string[] = [];
        if (!t.name || !t.name.trim()) missing.push("Task name");
        if (!t.start_date) missing.push("Start date");
        if (!t.current_due_date) missing.push("Due date");
        if (!t.effort) missing.push("Effort");
        if (t.estimated_hours === null || t.estimated_hours === undefined) missing.push("Estimated hours");
        return { task: t, missing };
      })
      .filter((x) => x.missing.length > 0);
  }

  // Aggregated by column rather than per-task prose -- easier to scan at
  // a glance than restating every task's name and its own missing-field
  // list (Sandra's feedback 2026-07-21: "just bullets of column names
  // with missing data").
  function missingFieldSummary(incomplete: { task: TaskRow; missing: string[] }[]): string {
    const counts = new Map<string, number>();
    for (const x of incomplete) {
      for (const field of x.missing) {
        counts.set(field, (counts.get(field) ?? 0) + 1);
      }
    }
    const order = ["Task name", "Start date", "Due date", "Effort", "Estimated hours"];
    return order
      .filter((field) => counts.has(field))
      .map((field) => `- ${field}: ${counts.get(field)} task${counts.get(field)! > 1 ? "s" : ""}`)
      .join("\n");
  }

  async function lockProjectTimelines(p: ProjectRow, locked: boolean) {
    const verb = locked ? "Lock" : "Unlock";

    if (locked) {
      const incomplete = incompleteTasksFor(p.id);
      if (incomplete.length > 0) {
        const summary = missingFieldSummary(incomplete);
        if (!isFullAccess) {
          alert(`Can't lock yet -- ${incomplete.length} task(s) are missing required info:\n\n${summary}`);
          return;
        }
        if (!(await confirm(`${incomplete.length} task(s) are missing required info and would be locked incomplete:\n\n${summary}\n\nFull Access override: lock anyway?`))) return;
      }
    }

    if (!locked && !isFullAccess) {
      // Owner self-service unlock only applies to a project still in
      // Scoping. Once truly Locked, the DB itself now refuses a direct
      // owner-initiated unlock (see the projects_date_lock/
      // set_project_timelines_locked governance added 2026-07-21) -- the
      // only path from here is an approved Project Extension Request.
      alert(
        'This project\'s timelines are locked. Ask your manager or Full Access to unlock it, or file a "Request timeline change" once that\'s available from the Extension Requests page.'
      );
      return;
    }

    const detail = locked
      ? "This freezes every task's current due date as the committed baseline. After this, due dates can only change via an approved Extension Request."
      : "This re-opens every task's due date for free editing during planning, until locked again.";
    if (!(await confirm(`${verb} timelines for "${p.name}"?\n\n${detail}`))) return;
    const { error } = await supabase.rpc("set_project_timelines_locked", { p_project_id: p.id, p_locked: locked });
    if (error) {
      alert(`Couldn't ${verb.toLowerCase()} timelines: ${error.message}`);
      return;
    }
    loadAll();
  }

  async function updateProject(id: string, patch: Partial<ProjectRow>) {
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
    const { error } = await supabase.from("projects").update(patch).eq("id", id);
    if (error) {
      alert(`Couldn't save: ${error.message}`);
      loadAll();
    }
  }

  async function updateTask(id: string, patch: Partial<TaskRow>) {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    const { error } = await supabase.from("tasks").update(patch).eq("id", id);
    if (error) {
      alert(`Couldn't save: ${error.message}`);
      loadAll();
    }
  }

  // current_due_date is DB-locked (see the tasks_due_date_lock trigger) --
  // this is the only path that ever changes it, going through
  // extension_requests so there's always an approval trail. Submitting
  // just creates a Pending row; the date itself doesn't move until the
  // project owner (or their manager, if the owner is the requester) or
  // Full Access approves it on the Extension Requests page.
  async function submitExtensionRequest(task: TaskWithDepth, newDueDate: string, reasonCategory: string, reasonNotes: string) {
    const { error } = await supabase.from("extension_requests").insert({
      task_id: task.id,
      requested_by: me?.id,
      requested_new_due_date: newDueDate,
      reason_category: reasonCategory,
      reason_notes: reasonNotes,
    });
    if (error) {
      await alert(`Couldn't submit extension request: ${error.message}`);
      return;
    }
    setExtensionTask(null);
    await alert("Extension request submitted -- you'll see it reflected once it's decided.");
  }

  async function submitProjectExtensionRequest(project: ProjectRow, newDueDate: string, reasonCategory: string, reasonNotes: string) {
    const { error } = await supabase.from("extension_requests").insert({
      project_id: project.id,
      requested_by: me?.id,
      requested_new_due_date: newDueDate,
      reason_category: reasonCategory,
      reason_notes: reasonNotes,
    });
    if (error) {
      await alert(`Couldn't submit timeline change request: ${error.message}`);
      return;
    }
    setExtensionProject(null);
    await alert(
      "Timeline change request submitted -- it goes to your manager (or Full Access) for approval. The project's due date only moves once it's approved."
    );
  }

  async function restoreProject(id: string) {
    const { error } = await supabase.from("projects").update({ is_archived: false, archived_at: null }).eq("id", id);
    if (error) {
      alert(`Couldn't restore: ${error.message}`);
      return;
    }
    await supabase.from("tasks").update({ is_archived: false, archived_at: null }).eq("project_id", id);
    loadArchived();
    loadAll();
  }

  async function deleteProjectPermanently(p: ProjectRow) {
    const ok = await confirm({
      title: "Delete permanently",
      message: `Permanently delete "${p.name}"? This can't be undone.`,
      confirmLabel: "Delete permanently",
      danger: true,
    });
    if (!ok) return;
    const projectTaskIds = [...tasks, ...archivedTasks].filter((t) => t.project_id === p.id).map((t) => t.id);
    await deleteTasksAndDependents(projectTaskIds);
    const { error } = await supabase.from("projects").delete().eq("id", p.id);
    if (error) {
      alert(`Couldn't delete: ${error.message}`);
      return;
    }
    loadArchived();
  }

  async function bulkUpdateProjects(patch: Partial<ProjectRow>) {
    const ids = selectedProjectIds;
    if (ids.length === 0) return;
    setProjects((prev) => prev.map((p) => (ids.includes(p.id) ? { ...p, ...patch } : p)));
    const { error } = await supabase.from("projects").update(patch).in("id", ids);
    if (error) {
      alert(`Couldn't update: ${error.message}`);
      loadAll();
    }
  }

  async function bulkDeleteProjects() {
    const ids = selectedProjectIds;
    if (ids.length === 0) return;
    const childTaskCount = tasks.filter((t) => ids.includes(t.project_id)).length;
    const ok = await confirm({
      title: "Delete projects",
      message:
        childTaskCount > 0
          ? `Delete ${ids.length} project${ids.length > 1 ? "s" : ""}? This will also archive ${childTaskCount} task${childTaskCount > 1 ? "s" : ""} in them. Everything can be restored within ${ARCHIVE_RETENTION_DAYS} days unless permanently deleted.`
          : `Delete ${ids.length} project${ids.length > 1 ? "s" : ""}? They'll be archived and can be restored within ${ARCHIVE_RETENTION_DAYS} days unless permanently deleted.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    const now = new Date().toISOString();
    const { error } = await supabase.from("projects").update({ is_archived: true, archived_at: now }).in("id", ids);
    if (error) {
      alert(`Couldn't delete: ${error.message}`);
      return;
    }
    await supabase.from("tasks").update({ is_archived: true, archived_at: now }).in("project_id", ids);
    setSelectedProjectIds([]);
    loadAll();
  }

  async function reorderProjects(draggedId: string, targetId: string) {
    if (projectViews.activeView.sorts.length > 0) {
      const ok = await confirm({
        title: "Clear sort to reorder",
        message: "This view is currently sorted. Dragging to reorder will clear that sort so your manual order can show. Continue?",
        confirmLabel: "Clear sort & reorder",
      });
      if (!ok) return;
      projectViews.updateActiveView({ sorts: [] });
    }
    const newVal = reorderedSortValue(projects.map((p) => ({ id: p.id, sort_order: p.sort_order })), draggedId, targetId);
    if (newVal == null) return;
    setProjects((prev) => prev.map((p) => (p.id === draggedId ? { ...p, sort_order: newVal } : p)).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)));
    const { error } = await supabase.from("projects").update({ sort_order: newVal }).eq("id", draggedId);
    if (error) {
      alert(`Couldn't reorder: ${error.message}`);
      loadAll();
    }
  }

  function toggleProjectSelectAll(keys: string[]) {
    setSelectedProjectIds((prev) => (keys.every((k) => prev.includes(k)) ? prev.filter((k) => !keys.includes(k)) : Array.from(new Set([...prev, ...keys]))));
  }

  // Tasks are never archived on their own -- only projects get the 30-day
  // archive/restore treatment (a task can still end up briefly archived as
  // a side effect of its parent project being deleted, see bulkDeleteProjects
  // above). Deleting a task is always via checkbox selection + the bulk
  // Delete button (bulkDeleteTasks below) -- there's no separate per-row
  // delete affordance since selecting one row already surfaces Delete.
  async function restoreTask(id: string) {
    const { error } = await supabase.from("tasks").update({ is_archived: false, archived_at: null }).eq("id", id);
    if (error) {
      alert(`Couldn't restore: ${error.message}`);
      return;
    }
    loadArchived();
    loadAll();
  }

  async function deleteTaskPermanently(t: TaskRow) {
    const ok = await confirm({
      title: "Delete permanently",
      message: `Permanently delete "${t.name}"? This can't be undone.`,
      confirmLabel: "Delete permanently",
      danger: true,
    });
    if (!ok) return;
    const { error } = await deleteTasksAndDependents([t.id]);
    if (error) {
      alert(`Couldn't delete: ${error}`);
      return;
    }
    loadArchived();
  }

  async function bulkUpdateTasks(patch: Partial<TaskRow>) {
    const ids = selectedTaskIds;
    if (ids.length === 0) return;
    setTasks((prev) => prev.map((t) => (ids.includes(t.id) ? { ...t, ...patch } : t)));
    const { error } = await supabase.from("tasks").update(patch).in("id", ids);
    if (error) {
      alert(`Couldn't update: ${error.message}`);
      loadAll();
    }
  }

  async function bulkDeleteTasks() {
    const ids = selectedTaskIds;
    if (ids.length === 0) return;
    const childIds = tasks.filter((t) => t.parent_task_id && ids.includes(t.parent_task_id)).map((t) => t.id);
    const allIds = Array.from(new Set([...ids, ...childIds]));
    const ok = await confirm({
      title: "Delete tasks",
      message: `Delete ${ids.length} task${ids.length > 1 ? "s" : ""}${childIds.length ? ` (and ${childIds.length} sub-task${childIds.length > 1 ? "s" : ""})` : ""}? This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    const { error } = await deleteTasksAndDependents(allIds);
    if (error) {
      alert(`Couldn't delete: ${error}`);
      return;
    }
    setSelectedTaskIds([]);
    loadAll();
  }

  async function reorderTasks(draggedId: string, targetId: string) {
    if (taskViews.activeView.sorts.length > 0) {
      const ok = await confirm({
        title: "Clear sort to reorder",
        message: "This view is currently sorted. Dragging to reorder will clear that sort so your manual order can show. Continue?",
        confirmLabel: "Clear sort & reorder",
      });
      if (!ok) return;
      taskViews.updateActiveView({ sorts: [] });
    }
    const newVal = reorderedSortValue(tasks.map((t) => ({ id: t.id, sort_order: t.sort_order })), draggedId, targetId);
    if (newVal == null) return;
    setTasks((prev) => prev.map((t) => (t.id === draggedId ? { ...t, sort_order: newVal } : t)).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)));
    const { error } = await supabase.from("tasks").update({ sort_order: newVal }).eq("id", draggedId);
    if (error) {
      alert(`Couldn't reorder: ${error.message}`);
      loadAll();
    }
  }

  function toggleTaskSelectAll(keys: string[]) {
    setSelectedTaskIds((prev) => (keys.every((k) => prev.includes(k)) ? prev.filter((k) => !keys.includes(k)) : Array.from(new Set([...prev, ...keys]))));
  }

  const projectViews = useTableViews("projects", me?.id, {
    viewType: "table",
    columnOrder: PROJECT_COLUMN_ORDER,
    hiddenColumns: [],
    columnWidths: {},
    groupBy: null,
    hiddenGroups: [],
    color: "neutral",
    showCount: false,
    sorts: [],
    progressDisplay: "bar",
  });

  // Row-level Filter applied upstream of sort/group/render so it covers
  // Table, Board, and Timeline alike -- the person filter reuses the same
  // owner_id identity check as canEditProject/isProjectOwner above, just
  // extended from a single "is it me" boolean to a multi-select ("me"
  // and/or specific people, e.g. a supervisor checking a couple of direct
  // reports at once). resolveFilterPersonIds() folds in the old
  // filterAssignedToMe boolean for views saved before this field existed.
  // An empty filterStatuses (or it being unset on older saved views) means
  // "no filter", matching hiddenColumns/hiddenGroups' own empty-means-
  // nothing-hidden convention.
  const filteredProjects = useMemo(() => {
    const view = projectViews.activeView;
    let out = projects;
    const personIds = resolveFilterPersonIds(view);
    if (personIds.length > 0) {
      out = out.filter((p) => personIds.some((id) => (id === "me" ? p.owner_id === me?.id : p.owner_id === id)));
    }
    if (view.filterStatuses && view.filterStatuses.length > 0) {
      const statuses = view.filterStatuses;
      out = out.filter((p) => statuses.includes(p.project_status ?? ""));
    }
    return out;
  }, [projects, projectViews.activeView, me?.id]);

  const projectColumns: ColumnDef<ProjectRow>[] = useMemo(
    () => [
      {
        key: "name",
        label: "Project",
        defaultWidth: 260,
        minWidth: 160,
        maxWidth: 420,
        render: (p) => {
          const icon = p.category ? PROJECT_CATEGORY_ICONS[p.category] ?? DEFAULT_PROJECT_ICON : DEFAULT_PROJECT_ICON;
          return (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className={`project-icon-badge ${icon.tone}`}>{icon.emoji}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <InlineText value={p.name} editable={canEditProject(p)} bold onCommit={(v) => updateProject(p.id, { name: v })} />
              </div>
            </div>
          );
        },
      },
      {
        key: "owner",
        label: "Owner",
        defaultWidth: 150,
        maxWidth: 220,
        render: (p) => (
          <InlineSelect
            value={p.owner_id ?? ""}
            editable={canEditProject(p)}
            allowEmpty
            emptyLabel="— none —"
            options={people.map((x) => x.name)}
            renderReadOnly={() => ownerName(p.owner_id)}
            onCommit={(v) => {
              const person = people.find((x) => x.name === v);
              updateProject(p.id, { owner_id: person?.id ?? null });
            }}
          />
        ),
      },
      {
        key: "priority",
        label: "Priority",
        defaultWidth: 100,
        maxWidth: 130,
        render: (p) => (
          <InlineSelect
            value={p.priority ?? ""}
            editable={canEditProject(p)}
            options={PROJECT_PRIORITY_OPTIONS}
            renderReadOnly={() => (p.priority ? <span className={`status-pill ${priorityTone(p.priority)}`}>{p.priority}</span> : "—")}
            onCommit={(v) => updateProject(p.id, { priority: v as ProjectRow["priority"] })}
          />
        ),
      },
      {
        key: "project_status",
        label: "Status",
        defaultWidth: 140,
        maxWidth: 200,
        render: (p) => (
          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
            <InlineSelect
              value={p.project_status ?? ""}
              editable={canEditProject(p)}
              allowEmpty
              options={PROJECT_STATUS_GROUPED}
              renderReadOnly={() =>
                p.project_status ? (
                  <span className={`status-pill ${PROJECT_STATUS_TONES[p.project_status ?? ""] ?? "neutral"}`}>{p.project_status}</span>
                ) : (
                  "—"
                )
              }
              onCommit={(v) => updateProject(p.id, { project_status: v || null })}
            />
            {shouldSuggestDone(p) && canEditProject(p) && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    updateProject(p.id, { project_status: "Done" });
                  }}
                  title="Mark as Done"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    color: "var(--success-text)",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    padding: 0,
                  }}
                >
                  <CheckCircle2 size={14} />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    dismissDoneSuggestion(p.id);
                  }}
                  title="Dismiss"
                  style={{ display: "flex", alignItems: "center", color: "var(--muted)", background: "none", border: "none", cursor: "pointer", padding: 0 }}
                >
                  <X size={11} />
                </button>
              </span>
            )}
          </div>
        ),
      },
      {
        key: "health",
        label: "Health",
        defaultWidth: 120,
        maxWidth: 150,
        render: (p) => {
          const h = healthOf(p, tasks, holidayDates);
          return <span className={`status-pill ${h.tone}`}>{h.label}</span>;
        },
      },
      {
        key: "actual_progress",
        label: (
          <span style={{ display: "inline-flex", alignItems: "center" }}>
            Actual Progress
            <ProgressDisplayToggle
              value={projectViews.activeView.progressDisplay ?? "bar"}
              onChange={(v) => projectViews.updateActiveView({ progressDisplay: v })}
            />
          </span>
        ),
        // The bar/number/ring toggle above belongs in the real column
        // header, not the Properties show/hide popover (it's a display
        // switch, not a name) -- plainLabel gives that popover a
        // text-only fallback so it doesn't render the icon as a stray
        // glyph next to a checklist row (Sandra, 2026-07-22).
        plainLabel: "Actual Progress",
        defaultWidth: 170,
        minWidth: 120,
        render: (p) => {
          const percent = actualProgress(p.id, tasks);
          const band = progressBand(percent);
          return <ProgressCell percent={percent} tone={band.tone} display={projectViews.activeView.progressDisplay ?? "bar"} />;
        },
      },
      {
        key: "estimated_hours",
        label: "Est. hrs",
        defaultWidth: 90,
        maxWidth: 120,
        render: (p) => {
          const total = projectEstimatedHoursTotal(p.id, tasks);
          return <span style={{ fontVariantNumeric: "tabular-nums" }}>{total === null ? "—" : formatHours(total)}</span>;
        },
      },
      {
        key: "time_spent_hours",
        label: "Spent hrs",
        defaultWidth: 100,
        maxWidth: 130,
        render: (p) => {
          const total = projectSpentHoursTotal(p.id, tasks, timeEntries);
          return <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatHours(total)}</span>;
        },
      },
      {
        key: "hours_variance",
        label: "Hrs Variance",
        defaultWidth: 100,
        maxWidth: 130,
        render: (p) => {
          const estimated = projectEstimatedHoursTotal(p.id, tasks);
          const spent = projectSpentHoursTotal(p.id, tasks, timeEntries);
          const variance = projectHoursVarianceOf(estimated, spent);
          if (!variance) return <span style={{ color: "var(--muted)" }}>—</span>;
          const tone = hoursVarianceTone(variance.percent);
          const sign = variance.hours > 0 ? "+" : "";
          return <span className={`status-pill ${tone}`}>{sign}{variance.hours}h</span>;
        },
      },
      {
        key: "hours_variance_pct",
        label: "Hrs Variance %",
        defaultWidth: 120,
        maxWidth: 150,
        render: (p) => {
          const estimated = projectEstimatedHoursTotal(p.id, tasks);
          const spent = projectSpentHoursTotal(p.id, tasks, timeEntries);
          const variance = projectHoursVarianceOf(estimated, spent);
          const tone = hoursVarianceTone(variance?.percent ?? null);
          return <ProgressCell percent={variance?.percent ?? null} tone={tone} display="bar" />;
        },
      },
      {
        key: "category",
        label: "Category",
        defaultWidth: 190,
        maxWidth: 260,
        render: (p) => (
          <InlineSelect
            value={p.category ?? ""}
            editable={canEditProject(p)}
            allowEmpty
            options={PROJECT_CATEGORY_OPTIONS}
            renderReadOnly={() =>
              p.category ? <span className={`status-pill ${PROJECT_CATEGORY_TONES[p.category] ?? "neutral"}`}>{p.category}</span> : "—"
            }
            onCommit={(v) => updateProject(p.id, { category: v || null })}
          />
        ),
      },
      {
        key: "effort_level",
        label: "Effort",
        defaultWidth: 100,
        maxWidth: 130,
        render: (p) => (
          <InlineSelect
            value={p.effort_level ?? ""}
            editable={canEditProject(p)}
            allowEmpty
            options={PROJECT_EFFORT_LEVEL_OPTIONS}
            renderReadOnly={() =>
              p.effort_level ? <span className={`status-pill ${PROJECT_EFFORT_LEVEL_TONES[p.effort_level] ?? "neutral"}`}>{p.effort_level}</span> : "—"
            }
            onCommit={(v) => updateProject(p.id, { effort_level: v || null })}
          />
        ),
      },
      {
        key: "start_date",
        label: "Start",
        defaultWidth: 110,
        maxWidth: 140,
        render: (p) => {
          const computed = projectDatesFromTasks(p.id);
          const editable = canEditProject(p) && !p.timelines_locked && !computed;
          return (
            <span title={computed ? "Computed from this project's own tasks (earliest task start)" : undefined}>
              <InlineDate
                value={p.start_date}
                editable={editable}
                onCommit={(v) => {
                  if (v && p.end_date && v > p.end_date) {
                    alert("Start date can't be after the due date.");
                    return;
                  }
                  updateProject(p.id, { start_date: v || null });
                }}
              />
            </span>
          );
        },
      },
      {
        key: "end_date",
        label: "Due",
        defaultWidth: 110,
        maxWidth: 140,
        render: (p) => {
          const computed = projectDatesFromTasks(p.id);
          const editable = canEditProject(p) && !p.timelines_locked && !computed;
          return (
            <span title={computed ? "Computed from this project's own tasks (latest task due date)" : undefined}>
              <InlineDate
                value={p.end_date}
                editable={editable}
                onCommit={(v) => {
                  if (v && p.start_date && v < p.start_date) {
                    alert("Due date can't be before the start date.");
                    return;
                  }
                  updateProject(p.id, { end_date: v || null });
                }}
              />
            </span>
          );
        },
      },
      {
        key: "timelines_locked",
        label: "Timelines",
        defaultWidth: 130,
        maxWidth: 160,
        render: (p) => (
          <button
            onClick={() => {
              if (!canEditProject(p)) return;
              // Locked + not Full Access: there's no self-service unlock
              // any more (see set_project_timelines_locked's governance
              // change) -- clicking opens a Request Timeline Change
              // instead of a bare toggle.
              if (p.timelines_locked && !isFullAccess) {
                setExtensionProject(p);
                return;
              }
              lockProjectTimelines(p, !p.timelines_locked);
            }}
            disabled={!canEditProject(p)}
            title={
              canEditProject(p)
                ? p.timelines_locked
                  ? isFullAccess
                    ? "Timelines locked -- click to unlock (Full Access override)"
                    : "Timelines locked -- click to request a timeline change (goes to your manager for approval)"
                  : "Timelines unlocked (scoping) -- click to lock and require Extension Requests"
                : p.timelines_locked
                ? "Timelines locked"
                : "Timelines unlocked (scoping)"
            }
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 8px",
              fontSize: 11,
              fontWeight: 500,
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border)",
              background: p.timelines_locked ? "var(--surface)" : "var(--surface-hover, var(--surface))",
              color: p.timelines_locked ? "var(--text-secondary)" : "#9A6B00",
              cursor: canEditProject(p) ? "pointer" : "default",
            }}
          >
            {p.timelines_locked ? <Lock size={11} /> : <Unlock size={11} />}
            {p.timelines_locked ? "Locked" : "Scoping"}
          </button>
        ),
      },
      {
        key: "days_extended",
        label: "Days Extended",
        defaultWidth: 120,
        maxWidth: 150,
        // Cumulative drift from the baseline stamped at Lock time -- only
        // ever moves via an approved Project Extension Request afterward
        // (decide_project_extension_request), same shape as tasks' own
        // Due Date Ext. drift. Blank until the project has actually been
        // locked at least once (no baseline yet to compare against).
        render: (p) => {
          if (!p.original_due_date || !p.end_date) return <span style={{ color: "var(--muted)", fontSize: 11.5 }}>—</span>;
          const days = Math.round((new Date(p.end_date).getTime() - new Date(p.original_due_date).getTime()) / 86400000);
          if (days <= 0) return <span style={{ color: "var(--muted)", fontSize: 11.5 }}>0 days</span>;
          return <span className="status-pill gold">+{days} day{days === 1 ? "" : "s"}</span>;
        },
      },
    ],
    [people, projects, me, tasks, holidayDates, projectViews.activeView.progressDisplay]
  );

  // Board-view card body: picks a handful of the same column render()
  // functions Table view already uses (bold name, owner picker, priority
  // pill, due date) so a card is editable exactly like a row is -- no
  // separate card-editing UI to build or keep in sync.
  function renderProjectCard(p: ProjectRow) {
    const hidden = projectViews.activeView.hiddenColumns;
    const find = (key: string) => projectColumns.find((c) => c.key === key);
    return (
      <>
        {!hidden.includes("name") && <div>{find("name")?.render(p)}</div>}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {!hidden.includes("priority") && find("priority")?.render(p)}
          {!hidden.includes("owner") && find("owner")?.render(p)}
        </div>
        {!hidden.includes("end_date") && <div>{find("end_date")?.render(p)}</div>}
        {!hidden.includes("actual_progress") && <div>{find("actual_progress")?.render(p)}</div>}
      </>
    );
  }

  // Labels here are kept identical to each column's own header text
  // (e.g. "Project" not "Name", "Start"/"Due" not "Start date"/"Due date")
  // so the Sort/Group-by pickers read as the same fields people see in the
  // table, and every column that makes sense to sort or group by is listed
  // -- previously Owner and Effort were missing from Sort, silently making
  // some columns impossible to sort on.
  const projectGroupOptions: GroupOption<ProjectRow>[] = [
    {
      key: "project_status",
      label: "Status",
      getGroup: (p) => p.project_status ?? "No status",
      getTone: (p) => PROJECT_STATUS_TONES[p.project_status ?? ""] ?? "neutral",
    },
    {
      key: "priority",
      label: "Priority",
      getGroup: (p) => p.priority ?? "No priority",
      getTone: (p) => priorityTone(p.priority),
    },
    { key: "owner", label: "Owner", getGroup: (p) => ownerName(p.owner_id) },
    {
      key: "category",
      label: "Category",
      getGroup: (p) => p.category ?? "Uncategorized",
      getTone: (p) => PROJECT_CATEGORY_TONES[p.category ?? ""] ?? "neutral",
    },
    {
      key: "effort_level",
      label: "Effort",
      getGroup: (p) => p.effort_level ?? "No effort set",
      getTone: (p) => PROJECT_EFFORT_LEVEL_TONES[p.effort_level ?? ""] ?? "neutral",
    },
    {
      key: "health",
      label: "Health",
      getGroup: (p) => healthOf(p, tasks, holidayDates).label,
      getTone: (p) => healthOf(p, tasks, holidayDates).tone,
    },
    {
      key: "timelines_locked",
      label: "Timelines",
      getGroup: (p) => (p.timelines_locked ? "Locked" : "Scoping"),
      getTone: (p) => (p.timelines_locked ? "neutral" : "warning"),
    },
  ];

  // Board's own Group-by list: every project property, in roughly column
  // order, so people can see the full set of properties and understand
  // *why* some are greyed out (Name/dates/Actual Progress aren't a fixed
  // set of values a Kanban column can represent) rather than wondering why
  // they're missing. Kept separate from projectGroupOptions above so
  // Table view's own Group-by dropdown is completely unaffected.
  const projectBoardGroupOptions: GroupOption<ProjectRow>[] = [
    { key: "name", label: "Project", getGroup: () => "", boardGroupable: false },
    { key: "owner", label: "Owner", getGroup: (p) => ownerName(p.owner_id), boardGroupable: true },
    {
      key: "priority",
      label: "Priority",
      getGroup: (p) => p.priority ?? "No priority",
      getTone: (p) => priorityTone(p.priority),
      boardGroupable: true,
    },
    {
      key: "project_status",
      label: "Status",
      getGroup: (p) => p.project_status ?? "No status",
      getTone: (p) => PROJECT_STATUS_TONES[p.project_status ?? ""] ?? "neutral",
      boardGroupable: true,
    },
    {
      key: "health",
      label: "Health",
      getGroup: (p) => healthOf(p, tasks, holidayDates).label,
      getTone: (p) => healthOf(p, tasks, holidayDates).tone,
      boardGroupable: false,
    },
    { key: "actual_progress", label: "Actual Progress", getGroup: () => "", boardGroupable: false },
    {
      key: "category",
      label: "Category",
      getGroup: (p) => p.category ?? "Uncategorized",
      getTone: (p) => PROJECT_CATEGORY_TONES[p.category ?? ""] ?? "neutral",
      boardGroupable: true,
    },
    {
      key: "effort_level",
      label: "Effort",
      getGroup: (p) => p.effort_level ?? "No effort set",
      getTone: (p) => PROJECT_EFFORT_LEVEL_TONES[p.effort_level ?? ""] ?? "neutral",
      boardGroupable: true,
    },
    { key: "start_date", label: "Start", getGroup: () => "", boardGroupable: false },
    { key: "end_date", label: "Due", getGroup: () => "", boardGroupable: false },
    {
      key: "timelines_locked",
      label: "Timelines",
      getGroup: (p) => (p.timelines_locked ? "Locked" : "Scoping"),
      getTone: (p) => (p.timelines_locked ? "neutral" : "warning"),
      boardGroupable: true,
    },
  ];

  // Computes Board's actual columns/getValue/drag-write-handler for
  // whichever field is currently grouped by. Status keeps the existing
  // 11-exact-value, clustered PROJECT_BOARD_COLUMNS; Priority/Category/
  // Effort reuse their own enum option lists; Owner is built from the live
  // people list (value = person id, so drag-drop writes back an
  // unambiguous id rather than a display name).
  const TIMELINES_BOARD_COLUMNS: BoardColumnDef[] = [
    { value: "scoping", label: "Scoping", tone: "warning" },
    { value: "locked", label: "Locked", tone: "neutral" },
  ];

  function getProjectBoardColumns(groupBy: string): BoardColumnDef[] {
    if (groupBy === "priority") return PROJECT_PRIORITY_OPTIONS.map((v) => ({ value: v, label: v, tone: priorityTone(v) }));
    if (groupBy === "category") return PROJECT_CATEGORY_OPTIONS.map((v) => ({ value: v, label: v, tone: PROJECT_CATEGORY_TONES[v] ?? "neutral" }));
    if (groupBy === "effort_level")
      return PROJECT_EFFORT_LEVEL_OPTIONS.map((v) => ({ value: v, label: v, tone: PROJECT_EFFORT_LEVEL_TONES[v] ?? "neutral" }));
    if (groupBy === "owner") return people.map((person) => ({ value: person.id, label: person.name, tone: "neutral" }));
    if (groupBy === "timelines_locked") return TIMELINES_BOARD_COLUMNS;
    return PROJECT_BOARD_COLUMNS;
  }

  function getProjectBoardValue(p: ProjectRow, groupBy: string): string | null {
    if (groupBy === "priority") return p.priority;
    if (groupBy === "category") return p.category;
    if (groupBy === "effort_level") return p.effort_level;
    if (groupBy === "owner") return p.owner_id;
    if (groupBy === "timelines_locked") return p.timelines_locked ? "locked" : "scoping";
    return p.project_status;
  }

  function getProjectBoardMoveHandler(groupBy: string): ((p: ProjectRow, newValue: string) => void) | undefined {
    if (groupBy === "priority") return (p, v) => updateProject(p.id, { priority: (v || null) as ProjectRow["priority"] });
    if (groupBy === "category") return (p, v) => updateProject(p.id, { category: v || null });
    if (groupBy === "effort_level") return (p, v) => updateProject(p.id, { effort_level: v || null });
    if (groupBy === "owner") return (p, v) => updateProject(p.id, { owner_id: v || null });
    if (groupBy === "timelines_locked") return undefined; // drag-drop locking skips the confirm/reset ceremony -- use the Timelines column button instead
    return (p, v) => updateProject(p.id, { project_status: v || null });
  }

  const projectSortOptions: SortOption<ProjectRow>[] = [
    { key: "name", label: "Project", getValue: (p) => p.name ?? "" },
    { key: "owner", label: "Owner", getValue: (p) => ownerName(p.owner_id) },
    { key: "priority", label: "Priority", getValue: (p) => PROJECT_PRIORITY_OPTIONS.indexOf(p.priority ?? "") },
    { key: "project_status", label: "Status", getValue: (p) => p.project_status ?? "" },
    { key: "category", label: "Category", getValue: (p) => p.category ?? "" },
    { key: "effort_level", label: "Effort", getValue: (p) => PROJECT_EFFORT_LEVEL_OPTIONS.indexOf(p.effort_level ?? "") },
    { key: "start_date", label: "Start", getValue: (p) => (p.start_date ? new Date(p.start_date).getTime() : null) },
    { key: "end_date", label: "Due", getValue: (p) => (p.end_date ? new Date(p.end_date).getTime() : null) },
    { key: "health", label: "Health", getValue: (p) => healthRank(healthOf(p, tasks, holidayDates).label) },
    { key: "actual_progress", label: "Actual Progress", getValue: (p) => actualProgress(p.id, tasks) ?? -1 },
    { key: "estimated_hours", label: "Est. hrs", getValue: (p) => projectEstimatedHoursTotal(p.id, tasks) ?? -1 },
    { key: "time_spent_hours", label: "Spent hrs", getValue: (p) => projectSpentHoursTotal(p.id, tasks, timeEntries) },
    {
      key: "hours_variance",
      label: "Hrs Variance",
      getValue: (p) => projectHoursVarianceOf(projectEstimatedHoursTotal(p.id, tasks), projectSpentHoursTotal(p.id, tasks, timeEntries))?.hours ?? -Infinity,
    },
    {
      key: "hours_variance_pct",
      label: "Hrs Variance %",
      getValue: (p) => projectHoursVarianceOf(projectEstimatedHoursTotal(p.id, tasks), projectSpentHoursTotal(p.id, tasks, timeEntries))?.percent ?? -1,
    },
    { key: "timelines_locked", label: "Timelines", getValue: (p) => (p.timelines_locked ? 1 : 0) },
  ];

  async function createBlankProject() {
    const { error } = await supabase.from("projects").insert({ name: "Untitled", sort_order: Date.now() });
    if (error) {
      alert(`Couldn't create project: ${error.message}`);
      return;
    }
    loadAll();
  }

  const visibleTasks = useMemo(
    () => buildTaskTree(tasks).filter((t) => !(t.parent_task_id && collapsedParents.includes(t.parent_task_id))),
    [tasks, collapsedParents]
  );
  const hasChildren = (taskId: string) => tasks.some((t) => t.parent_task_id === taskId);

  // Instant creation like createBlankTask/createBlankProject, instead of a
  // blocking window.prompt() — inherits the parent's due date and is
  // immediately editable inline via the normal Name cell.
  async function addSubtask(parent: TaskWithDepth) {
    if (parent._depth > 0) return; // only 2 layers total: parent + 1 sub-task level
    const { error } = await supabase.from("tasks").insert({
      project_id: parent.project_id,
      parent_task_id: parent.id,
      name: "Untitled sub-task",
      status: "Not Started",
      original_due_date: parent.current_due_date,
      current_due_date: parent.current_due_date,
      sort_order: Date.now(),
    });
    if (error) {
      alert(`Couldn't add subtask: ${error.message}`);
      return;
    }
    loadAll();
  }

  const taskColumns: ColumnDef<TaskWithDepth>[] = useMemo(
    () => [
      {
        key: "name",
        label: "Task",
        defaultWidth: 300,
        minWidth: 180,
        maxWidth: 480,
        render: (t) => {
          const children = t._depth === 0 && hasChildren(t.id);
          const collapsed = children && collapsedParents.includes(t.id);
          return (
            <div className={`task-name-cell${t._depth > 0 ? " is-subtask" : ""}`} style={{ paddingLeft: t._depth * 16 }}>
              {t._depth > 0 && <CornerDownRight size={12} className="subtask-connector" />}
              {children ? (
                <button
                  className="task-collapse-toggle"
                  onClick={() => setCollapsedParents((prev) => (collapsed ? prev.filter((id) => id !== t.id) : [...prev, t.id]))}
                  title={collapsed ? "Expand sub-tasks" : "Collapse sub-tasks"}
                >
                  {collapsed ? <ChevronRight size={20} /> : <ChevronDown size={20} />}
                </button>
              ) : (
                t._depth === 0 && <span className="task-collapse-spacer" />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                {/* Bold marks a parent task; sub-tasks render at normal
                    weight so the hierarchy reads visually, not just via
                    indentation + the connector glyph. */}
                <InlineText value={t.name} editable={canEditTask(t)} bold={t._depth === 0} onCommit={(v) => updateTask(t.id, { name: v })} />
              </div>
              {t._depth === 0 && canManageTasksIn(t.project_id) && (
                <button className="add-subtask-btn" onClick={() => addSubtask(t)} title="Add sub-task">
                  <Plus size={16} />
                </button>
              )}
            </div>
          );
        },
      },
      {
        key: "project",
        label: "Project",
        defaultWidth: 180,
        maxWidth: 260,
        render: (t) => (
          <InlineSelect
            value={projectName(t.project_id)}
            editable={canEditTask(t)}
            options={projects.map((p) => p.name)}
            onCommit={(v) => {
              const proj = projects.find((p) => p.name === v);
              if (proj) updateTask(t.id, { project_id: proj.id });
            }}
          />
        ),
      },
      {
        key: "assignee",
        label: "Assignee",
        defaultWidth: 150,
        maxWidth: 220,
        render: (t) => (
          <InlineSelect
            value={t.assignee_id ? ownerName(t.assignee_id) : ""}
            editable={canEditTask(t) && !isTaskLocked(t)}
            allowEmpty
            emptyLabel="— none —"
            options={people.map((x) => x.name)}
            renderReadOnly={() => ownerName(t.assignee_id)}
            onCommit={(v) => {
              const person = people.find((x) => x.name === v);
              updateTask(t.id, { assignee_id: person?.id ?? null });
            }}
          />
        ),
      },
      {
        key: "status",
        label: "Status",
        defaultWidth: 140,
        maxWidth: 200,
        render: (t) => (
          <InlineSelect
            value={t.status ?? ""}
            editable={canEditTask(t) && !isTaskLocked(t)}
            allowEmpty
            options={TASK_STATUS_GROUPED}
            renderReadOnly={() =>
              t.status ? <span className={`status-pill ${statusTone(statusGroupOf(TASK_STATUS_GROUPED, t.status))}`}>{t.status}</span> : "—"
            }
            onCommit={(v) => {
              // Flipping to Done stamps the assignee's own self-reported
              // completion moment -- separate from validated_completion_date,
              // which is the project owner/manager's independent check (see
              // the Validated column below). Moving *off* Done clears the
              // stamp so a task that's reopened doesn't keep a stale
              // "submitted" record.
              if (v === "Done") {
                updateTask(t.id, { status: v, submitted_on: new Date().toISOString(), submitted_by: me?.id ?? null });
              } else {
                updateTask(t.id, { status: v || null, submitted_on: null, submitted_by: null });
              }
            }}
          />
        ),
      },
      {
        key: "effort",
        label: "Effort",
        defaultWidth: 80,
        minWidth: 60,
        maxWidth: 100,
        render: (t) => {
          const tone = t.effort ? TASK_EFFORT_DEFAULT_TONES[t.effort] ?? "neutral" : "neutral";
          const Icon = t.effort ? TASK_EFFORT_ICON[t.effort] : null;
          return (
            <InlineSelect
              value={t.effort ?? ""}
              editable={canEditTask(t) && !isTaskLocked(t)}
              allowEmpty
              options={TASK_EFFORT_OPTIONS}
              renderReadOnly={() =>
                t.effort ? (
                  <span className={`status-pill ${tone}`} style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }} title={t.effort}>
                    {Icon && <Icon size={12} />}
                  </span>
                ) : (
                  "—"
                )
              }
              onCommit={(v) => updateTask(t.id, { effort: v || null })}
            />
          );
        },
      },
      {
        key: "start_date",
        label: "Start",
        defaultWidth: 110,
        maxWidth: 140,
        render: (t) => {
          const isParent = t._depth === 0 && hasChildren(t.id);
          const computed = isParent ? taskDatesFromSubtasks(t.id) : null;
          return (
            <span title={computed ? "Computed from this task's own sub-tasks (earliest sub-task start)" : undefined}>
              <InlineDate
                value={t.start_date}
                editable={!isParent && canEditTask(t) && !isTaskLocked(t)}
                onCommit={(v) => {
                  if (v && t.current_due_date && v > t.current_due_date) {
                    alert("Start date can't be after the due date.");
                    return;
                  }
                  updateTask(t.id, { start_date: v || null });
                }}
              />
            </span>
          );
        },
      },
      {
        key: "timing",
        label: "Timing",
        defaultWidth: 110,
        maxWidth: 150,
        render: (t) => {
          const timing = timingOf(t);
          return <span className={`status-pill ${timing.tone}`}>{timing.label}</span>;
        },
      },
      {
        key: "timing_variance_days",
        label: "Days +/-",
        defaultWidth: 90,
        maxWidth: 110,
        render: (t) => {
          const days = timingVarianceDays(t);
          if (days === null) return <span style={{ color: "var(--muted)" }}>—</span>;
          if (days === 0) return <span className="status-pill success">On time</span>;
          const tone = days > 0 ? "danger" : "success";
          const label = days > 0 ? `+${days}d late` : `${Math.abs(days)}d early`;
          return <span className={`status-pill ${tone}`}>{label}</span>;
        },
      },
      {
        key: "current_due_date",
        label: "Due",
        defaultWidth: 130,
        minWidth: 110,
        render: (t) => {
          const locked = isProjectLocked(t.project_id);
          // While the project is still in scoping mode (unlocked), the due
          // date is a normal editable field -- no extension ceremony needed.
          // Once locked, the DB trigger enforces read-only; the extension
          // status/history/request action all live in the Due Date Ext.
          // column now instead of being split across two places.
          // See [[project_capaciq_extension_requests]].
          const isParent = t._depth === 0 && hasChildren(t.id);
          const computed = isParent ? taskDatesFromSubtasks(t.id) : null;
          return (
            <span title={computed ? "Computed from this task's own sub-tasks (latest sub-task due date)" : undefined}>
              <InlineDate
                value={t.current_due_date}
                editable={!isParent && !locked && canEditTask(t) && !isTaskLocked(t)}
                onCommit={(v) => v && updateTask(t.id, { current_due_date: v, original_due_date: v })}
              />
            </span>
          );
        },
      },
      {
        key: "due_date_ext",
        label: "Due Date Ext.",
        defaultWidth: 140,
        minWidth: 120,
        render: (t) => {
          const status = dueDateExtStatus(t);
          return (
            <button
              onClick={() => setExtDetailTask(t)}
              className={`status-pill ${status.tone}`}
              style={{ border: "none", cursor: "pointer", fontFamily: "inherit" }}
              title="Click to see extension request details"
            >
              {status.label}
            </button>
          );
        },
      },
      {
        key: "validated_completion_date",
        label: "Validated",
        defaultWidth: 160,
        minWidth: 140,
        // Independent completion check, distinct from the assignee's own
        // submitted_on stamp (set automatically when Status flips to Done
        // above) -- only the project owner or Full Access can validate or
        // correct this date, never the assignee themselves.
        render: (t) => {
          const canValidate = canManageTasksIn(t.project_id);
          if (t.status !== "Done") {
            return <span style={{ color: "var(--muted)", fontSize: 11.5 }}>—</span>;
          }
          if (!t.validated_completion_date) {
            if (!canValidate) return <span style={{ color: "var(--muted)", fontSize: 11.5 }}>Pending validation</span>;
            return (
              <button
                onClick={() => updateTask(t.id, { validated_completion_date: new Date().toISOString(), validated_by: me?.id ?? null })}
                style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, color: "var(--accent)", background: "none", border: "none", cursor: "pointer" }}
              >
                <CheckCircle2 size={13} />
                Validate
              </button>
            );
          }
          const dateOnly = t.validated_completion_date.slice(0, 10);
          return (
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <InlineDate
                value={dateOnly}
                editable={canValidate}
                onCommit={(v) => {
                  if (!v) return;
                  updateTask(t.id, { validated_completion_date: new Date(v).toISOString(), validated_by: me?.id ?? null });
                }}
              />
              <span style={{ fontSize: 10, color: "var(--muted)" }} title="Validated by">
                {ownerName(t.validated_by)}
              </span>
              {/* Reopening clears the validation and reverts Status to
                  In Progress, unlocking Assignee/Status/Effort/Est. Hrs/
                  Start/Due again (see isTaskLocked above). Restricted to
                  Full Access only, never the project owner -- Sandra,
                  2026-07-22: "keep it for full access only" -- a
                  deliberate, visible action rather than something that
                  falls out of just editing Status directly (which is now
                  locked once validated). */}
              {isFullAccess && (
                <button
                  onClick={async () => {
                    const ok = await confirm({
                      title: "Reopen task",
                      message: `Reopen "${t.name}"? This clears its validation and sets Status back to In Progress, unlocking its fields for editing again.`,
                      confirmLabel: "Reopen",
                    });
                    if (!ok) return;
                    updateTask(t.id, {
                      validated_completion_date: null,
                      validated_by: null,
                      status: "In Progress",
                      submitted_on: null,
                      submitted_by: null,
                    });
                  }}
                  title="Reopen -- clears validation and unlocks this task"
                  style={{ display: "flex", alignItems: "center", background: "none", border: "none", cursor: "pointer", padding: 2, color: "var(--muted)" }}
                >
                  <RotateCcw size={12} />
                </button>
              )}
            </div>
          );
        },
      },
      {
        key: "estimated_hours",
        label: "Est. hrs",
        defaultWidth: 90,
        maxWidth: 120,
        render: (t) => <InlineNumber value={t.estimated_hours} editable={canEditTask(t) && !isTaskLocked(t)} onCommit={(v) => updateTask(t.id, { estimated_hours: v })} />,
      },
      {
        key: "hours_variance",
        label: "Hrs Variance",
        defaultWidth: 100,
        maxWidth: 130,
        render: (t) => {
          const variance = hoursVarianceOf(t, spentHoursFor(t.id));
          if (!variance) return <span style={{ color: "var(--muted)" }}>—</span>;
          const tone = hoursVarianceTone(variance.percent);
          const sign = variance.hours > 0 ? "+" : "";
          return <span className={`status-pill ${tone}`}>{sign}{variance.hours}h</span>;
        },
      },
      {
        key: "hours_variance_pct",
        label: "Hrs Variance %",
        defaultWidth: 120,
        maxWidth: 150,
        render: (t) => {
          const variance = hoursVarianceOf(t, spentHoursFor(t.id));
          const tone = hoursVarianceTone(variance?.percent ?? null);
          return <ProgressCell percent={variance?.percent ?? null} tone={tone} display="bar" />;
        },
      },
      {
        key: "time_spent_hours",
        label: "Spent hrs",
        defaultWidth: 110,
        maxWidth: 140,
        alwaysVisible: true,
        render: (t) => {
          const hours = spentHoursFor(t.id);
          const isMine = t.assignee_id === me?.id;
          const isRunningHere = running?.task_id === t.id;
          // A Done task shouldn't still be accruing logged time -- disable
          // *starting* a fresh timer once status is Done (Sandra, 2026-07-22:
          // "disable the timer if the task is tagged as done"). Stopping
          // stays available regardless, so nobody's left with a timer stuck
          // running if the status happened to flip to Done while it was
          // already going.
          const doneBlocksStart = t.status === "Done" && !isRunningHere;
          const disabled = timerBusy || (Boolean(running) && !isRunningHere) || doneBlocksStart;
          return (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {/* Fixed width (not sized to the text) so the button after it
                  lands in the same spot whether the value is "0" or
                  "123.45" -- assume a max of hhh.mm hours. Right-aligned
                  so the digits still read naturally against that box. */}
              <span style={{ fontVariantNumeric: "tabular-nums", width: 46, flexShrink: 0, textAlign: "right" }}>{formatHours(hours)}</span>
              {isMine && !t.is_archived && (
                <button
                  onClick={async () => {
                    if (isRunningHere) {
                      const res = await stopRunningTimer();
                      if (res.error) alert(`Couldn't stop timer: ${res.error}`);
                    } else {
                      const res = await startTaskTimer({ id: t.id, name: t.name });
                      if (res.error) alert(`Couldn't start timer: ${res.error}`);
                    }
                  }}
                  disabled={disabled}
                  title={
                    isRunningHere
                      ? "Stop timer"
                      : doneBlocksStart
                      ? "Task is Done -- timer disabled"
                      : running
                      ? `Stop the timer running on "${running.task_name}" first`
                      : "Start timer"
                  }
                  // Always visible (not hover-gated like .row-icon-btn) --
                  // this is a primary action people need to spot at a
                  // glance, not a secondary one like archive. Green =
                  // start, red = stop, so the state reads instantly.
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 20,
                    height: 20,
                    flexShrink: 0,
                    background: "none",
                    border: "none",
                    cursor: disabled ? "default" : "pointer",
                    borderRadius: "var(--radius-sm)",
                    opacity: Boolean(running) && !isRunningHere ? 0.35 : doneBlocksStart ? 0.35 : 1,
                    color: isRunningHere ? "var(--danger-text)" : "var(--accent)",
                  }}
                >
                  {isRunningHere ? <Square size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}
                </button>
              )}
            </div>
          );
        },
      },
    ],
    [people, projects, me, timeEntries, tasks, running, timerBusy, collapsedParents]
  );

  // Board cards get their own name renderer rather than reusing the table
  // cell's render() -- that cell carries table-only chrome (hierarchy
  // indent, expand/collapse chevron, "add sub-task" button) that doesn't
  // belong on a compact card and threw off alignment with the rows below
  // it. A sub-task shows its parent's name as a small property instead
  // (Notion-style relation display) rather than an indent/connector icon.
  function renderTaskCard(t: TaskWithDepth) {
    const hidden = taskViews.activeView.hiddenColumns;
    const find = (key: string) => taskColumns.find((c) => c.key === key);
    return (
      <>
        {!hidden.includes("name") && (
          <div style={{ minWidth: 0 }}>
            <InlineText value={t.name} editable={canEditTask(t)} bold onCommit={(v) => updateTask(t.id, { name: v })} />
          </div>
        )}
        {t.parent_task_id && (
          <div className="board-card-property">
            <span className="board-card-property-label">Parent</span>
            <span className="board-card-property-value">{taskName(t.parent_task_id)}</span>
          </div>
        )}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {!hidden.includes("project") && find("project")?.render(t)}
          {!hidden.includes("assignee") && find("assignee")?.render(t)}
        </div>
        {!hidden.includes("current_due_date") && <div>{find("current_due_date")?.render(t)}</div>}
      </>
    );
  }

  const taskGroupOptions: GroupOption<TaskWithDepth>[] = [
    {
      key: "project",
      label: "Project",
      getGroup: (t) => projectName(t.project_id),
      // Every project shows up here even with zero tasks yet, so a
      // freshly created project isn't invisible in this view -- it gets
      // an empty section with its own "+ New task" trigger instead.
      allGroups: () => projects.map((p) => p.name),
    },
    {
      key: "status",
      label: "Status",
      getGroup: (t) => t.status ?? "No status",
      getTone: (t) => statusTone(statusGroupOf(TASK_STATUS_GROUPED, t.status)),
    },
    { key: "assignee", label: "Assignee", getGroup: (t) => ownerName(t.assignee_id) },
    {
      key: "effort",
      label: "Effort",
      getGroup: (t) => t.effort ?? "No effort set",
      getTone: (t) => (t.effort ? TASK_EFFORT_DEFAULT_TONES[t.effort] ?? "neutral" : "neutral"),
    },
    {
      key: "timing",
      label: "Timing",
      getGroup: (t) => timingOf(t).label,
      getTone: (t) => timingOf(t).tone,
    },
    {
      key: "due_date_ext",
      label: "Due Date Ext.",
      getGroup: (t) => dueDateExtStatus(t).label,
      getTone: (t) => dueDateExtStatus(t).tone,
    },
  ];

  // Board's own Group-by list for Tasks -- same rationale as
  // projectBoardGroupOptions above. Project/Status/Assignee/Effort/Timing
  // all have a fixed, enumerable set of values so they're all Board-
  // groupable; Task/Start/Due/Est. hrs/Spent hrs are free text, dates, or
  // continuous numbers and are listed disabled instead of omitted.
  const taskBoardGroupOptions: GroupOption<TaskWithDepth>[] = [
    { key: "name", label: "Task", getGroup: () => "", boardGroupable: false },
    { key: "project", label: "Project", getGroup: (t) => projectName(t.project_id), boardGroupable: true },
    {
      key: "assignee",
      label: "Assignee",
      getGroup: (t) => ownerName(t.assignee_id),
      boardGroupable: true,
    },
    {
      key: "status",
      label: "Status",
      getGroup: (t) => t.status ?? "No status",
      getTone: (t) => statusTone(statusGroupOf(TASK_STATUS_GROUPED, t.status)),
      boardGroupable: true,
    },
    {
      key: "timing",
      label: "Timing",
      getGroup: (t) => timingOf(t).label,
      getTone: (t) => timingOf(t).tone,
      boardGroupable: true,
    },
    { key: "start_date", label: "Start", getGroup: () => "", boardGroupable: false },
    { key: "current_due_date", label: "Due", getGroup: () => "", boardGroupable: false },
    {
      key: "due_date_ext",
      label: "Due Date Ext.",
      getGroup: (t) => dueDateExtStatus(t).label,
      getTone: (t) => dueDateExtStatus(t).tone,
      boardGroupable: true,
    },
    {
      key: "estimated_hours",
      label: "Est. hrs",
      getGroup: () => "",
      boardGroupable: false,
    },
    {
      key: "time_spent_hours",
      label: "Spent hrs",
      getGroup: () => "",
      boardGroupable: false,
    },
    {
      key: "effort",
      label: "Effort",
      getGroup: (t) => t.effort ?? "No effort set",
      getTone: (t) => (t.effort ? TASK_EFFORT_DEFAULT_TONES[t.effort] ?? "neutral" : "neutral"),
      boardGroupable: true,
    },
  ];

  // Same idea as getProjectBoardColumns/Value/MoveHandler above, for Tasks.
  // Project and Timing are shown as read-only board groupings (no
  // onMoveCard) -- reassigning a task's project has knock-on effects on
  // its sub-tasks that aren't worth the drag-and-drop risk yet, and Timing
  // is fully computed so there's nothing to write back.
  const DUE_DATE_EXT_BOARD_COLUMNS: BoardColumnDef[] = [
    { value: "No Extension", label: "No Extension", tone: "neutral" },
    { value: "Requested", label: "Requested", tone: "purple" },
    { value: "Rejected", label: "Rejected", tone: "danger" },
    { value: "Extended", label: "Extended", tone: "gold" },
  ];

  function getTaskBoardColumns(groupBy: string): BoardColumnDef[] {
    if (groupBy === "assignee") return people.map((person) => ({ value: person.id, label: person.name, tone: "neutral" }));
    if (groupBy === "effort") return TASK_EFFORT_OPTIONS.map((v) => ({ value: v, label: v, tone: TASK_EFFORT_DEFAULT_TONES[v] ?? "neutral" }));
    if (groupBy === "project") return projects.map((p) => ({ value: p.id, label: p.name ?? "Untitled", tone: "neutral" }));
    if (groupBy === "timing") return TASK_TIMING_BOARD_COLUMNS;
    if (groupBy === "due_date_ext") return DUE_DATE_EXT_BOARD_COLUMNS;
    return TASK_BOARD_COLUMNS;
  }

  function getTaskBoardValue(t: TaskWithDepth, groupBy: string): string | null {
    if (groupBy === "assignee") return t.assignee_id;
    if (groupBy === "effort") return t.effort;
    if (groupBy === "project") return t.project_id;
    if (groupBy === "timing") return timingOf(t).label;
    if (groupBy === "due_date_ext") return dueDateExtStatus(t).label;
    return t.status;
  }

  function getTaskBoardMoveHandler(groupBy: string): ((t: TaskWithDepth, newValue: string) => void) | undefined {
    if (groupBy === "assignee") return (t, v) => updateTask(t.id, { assignee_id: v || null });
    if (groupBy === "effort") return (t, v) => updateTask(t.id, { effort: v || null });
    if (groupBy === "status") return (t, v) => updateTask(t.id, { status: v || null });
    return undefined; // project, timing, due_date_ext: read-only board
  }

  // Labels here match each column's own header text exactly (e.g. "Task"
  // not "Name", "Start"/"Due" not "Start date"/"Due date"), and every
  // sortable column is listed -- "Timing" was previously missing entirely.
  const taskSortOptions: SortOption<TaskWithDepth>[] = [
    { key: "name", label: "Task", getValue: (t) => t.name ?? "" },
    { key: "project", label: "Project", getValue: (t) => projectName(t.project_id) },
    { key: "assignee", label: "Assignee", getValue: (t) => ownerName(t.assignee_id) },
    { key: "status", label: "Status", getValue: (t) => t.status ?? "" },
    { key: "effort", label: "Effort", getValue: (t) => (t.effort ? TASK_EFFORT_POINTS[t.effort] ?? null : null) },
    { key: "start_date", label: "Start", getValue: (t) => (t.start_date ? new Date(t.start_date).getTime() : null) },
    { key: "timing", label: "Timing", getValue: (t) => timingRank(timingOf(t).label) },
    { key: "current_due_date", label: "Due", getValue: (t) => (t.current_due_date ? new Date(t.current_due_date).getTime() : null) },
    { key: "estimated_hours", label: "Est. hrs", getValue: (t) => t.estimated_hours ?? null },
    { key: "time_spent_hours", label: "Spent hrs", getValue: (t) => spentHoursFor(t.id) },
    {
      key: "due_date_ext",
      label: "Due Date Ext.",
      getValue: (t) => ["No Extension", "Requested", "Rejected", "Extended"].indexOf(dueDateExtStatus(t).label),
    },
  ];

  const taskViews = useTableViews("tasks", me?.id, {
    viewType: "table",
    columnOrder: TASK_COLUMN_ORDER,
    hiddenColumns: [],
    columnWidths: {},
    groupBy: "project",
    hiddenGroups: [],
    color: "neutral",
    showCount: false,
    sorts: [],
  });

  // Same upstream Filter step as filteredProjects above -- the person
  // filter reuses the same t.assignee_id === me?.id identity check already
  // used to gate the per-row timer button, extended to a multi-select via
  // resolveFilterPersonIds() (see filteredProjects above for the full
  // rationale).
  const filteredVisibleTasks = useMemo(() => {
    const view = taskViews.activeView;
    let out = visibleTasks;
    const personIds = resolveFilterPersonIds(view);
    if (personIds.length > 0) {
      out = out.filter((t) => personIds.some((id) => (id === "me" ? t.assignee_id === me?.id : t.assignee_id === id)));
    }
    if (view.filterStatuses && view.filterStatuses.length > 0) {
      const statuses = view.filterStatuses;
      out = out.filter((t) => statuses.includes(t.status ?? ""));
    }
    return out;
  }, [visibleTasks, taskViews.activeView, me?.id]);

  // Instant, Notion-style row creation (mirrors createBlankProject): insert
  // a sensibly-defaulted task immediately and let the person fill it in via
  // the same inline cells every other row uses, instead of a separate
  // multi-field add form.
  async function createBlankTask(projectId: string) {
    if (!projectId) {
      alert("Create a project first before adding tasks.");
      return;
    }
    // Default to the project's own due date rather than "today" -- a
    // fresh task defaulting to today reads as immediately overdue and
    // was the actual trigger for building the scoping-lock mechanism.
    // Falls back to today only if the project has no end_date set yet.
    const today = new Date().toISOString().slice(0, 10);
    const project = projects.find((p) => p.id === projectId);
    const defaultDue = project?.end_date ?? today;
    const { error } = await supabase.from("tasks").insert({
      project_id: projectId,
      name: "Untitled task",
      status: "Not Started",
      original_due_date: defaultDue,
      current_due_date: defaultDue,
      sort_order: Date.now(),
    });
    if (error) {
      alert(`Couldn't create task: ${error.message}`);
      return;
    }
    loadAll();
  }

  // Which Group-by option set + resolved groupBy + restriction mode is
  // active right now, computed once here and reused by ViewSettingsMenu,
  // ViewFilterPills, and TimelineView's own swimlane grouping below --
  // Board and Timeline both restrict to the boardGroupable-flagged option
  // list (projectBoardGroupOptions/taskBoardGroupOptions), but only Board
  // forces a non-null groupBy (a Kanban board can't render without
  // columns); Timeline's flat list is a normal default state, so an
  // unrecognized/unset groupBy resolves to null (ungrouped) instead of a
  // forced fallback field.
  const projectGroupMode: "board" | "timeline" | undefined =
    projectViews.activeView.viewType === "board" ? "board" : projectViews.activeView.viewType === "timeline" ? "timeline" : undefined;
  const projectGroupModeOptions = projectGroupMode ? projectBoardGroupOptions : projectGroupOptions;
  // Calendar never groups (see CalendarView.tsx / ViewSettingsMenu's
  // hideGroupBy) -- force null here too so a groupBy value left over from
  // this view's Table-shaped default doesn't silently surface as a stale
  // "Grouped by X" filter pill while on the Calendar tab.
  const projectResolvedGroupBy =
    projectViews.activeView.viewType === "calendar"
      ? null
      : projectGroupMode === "board"
      ? resolveBoardGroupBy(projectViews.activeView.groupBy, PROJECT_BOARD_GROUPABLE_KEYS, "project_status")
      : projectGroupMode === "timeline"
      ? resolveTimelineGroupBy(projectViews.activeView.groupBy, PROJECT_BOARD_GROUPABLE_KEYS)
      : projectViews.activeView.groupBy;
  const projectTimelineGroupOption =
    projectGroupMode === "timeline" ? projectBoardGroupOptions.find((g) => g.key === projectResolvedGroupBy) : undefined;

  const taskGroupMode: "board" | "timeline" | undefined =
    taskViews.activeView.viewType === "board" ? "board" : taskViews.activeView.viewType === "timeline" ? "timeline" : undefined;
  const taskGroupModeOptions = taskGroupMode ? taskBoardGroupOptions : taskGroupOptions;
  const taskResolvedGroupBy =
    taskViews.activeView.viewType === "calendar"
      ? null
      : taskGroupMode === "board"
      ? resolveBoardGroupBy(taskViews.activeView.groupBy, TASK_BOARD_GROUPABLE_KEYS, "status")
      : taskGroupMode === "timeline"
      ? resolveTimelineGroupBy(taskViews.activeView.groupBy, TASK_BOARD_GROUPABLE_KEYS)
      : taskViews.activeView.groupBy;
  const taskTimelineGroupOption =
    taskGroupMode === "timeline" ? taskBoardGroupOptions.find((g) => g.key === taskResolvedGroupBy) : undefined;

  // Timeline chips: curated per Sandra's Projects-Timeline spec. Name is
  // never a chip (it's the label itself); Actual Progress is never a chip
  // either -- it renders as a plain "NN%" label directly after the Gantt
  // bar (see getProgress/getProgressLabel above), which would be a
  // redundant second progress indicator here. Start/Due dates are also
  // permanently excluded -- Sandra agreed they're redundant with the bar's
  // own position/length. Everything else (Status, Owner, Priority, Health
  // visible by default; Category, Effort, Timelines, Days Extended hidden
  // by default -- see PROJECT_TIMELINE_DEFAULT_HIDDEN_COLUMNS) is a normal
  // toggleable Properties column, shown in plain left-to-right
  // PROJECT_COLUMN_ORDER order -- no more pinning any one property to the
  // front.
  const PROJECT_TIMELINE_EXCLUDED_KEYS = ["name", "actual_progress", "start_date", "end_date"];
  // Explicit chip order agreed with Sandra: Status, Owner, Priority, Health
  // (the default-visible tier) first, then Category/Effort/Timelines/Days
  // Extended (hidden-by-default, shown if opted into) after -- deliberately
  // NOT the same left-to-right order as PROJECT_COLUMN_ORDER (which drives
  // Table view and lists Owner before Status), so Table's own column order
  // is untouched by this Timeline-only preference.
  const PROJECT_TIMELINE_CHIP_ORDER = ["project_status", "owner", "priority", "health", "category", "effort_level", "timelines_locked", "days_extended", "estimated_hours", "time_spent_hours", "hours_variance", "hours_variance_pct"];
  const projectTimelinePropertyColumns = visibleOrderedColumns(projectColumns, projectViews.activeView)
    .filter((c) => !PROJECT_TIMELINE_EXCLUDED_KEYS.includes(c.key))
    .slice()
    .sort((a, b) => {
      const ai = PROJECT_TIMELINE_CHIP_ORDER.indexOf(a.key);
      const bi = PROJECT_TIMELINE_CHIP_ORDER.indexOf(b.key);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
  // Mirrors PROJECT_TIMELINE_EXCLUDED_KEYS -- Start/Due are already shown via
  // the bar's own position/length on the chart, so repeating them as chips
  // is redundant (Sandra: "remove start and due dates in columns since this
  // is covered in the gantt").
  const TASK_TIMELINE_EXCLUDED_KEYS = ["name", "start_date", "current_due_date"];
  const taskTimelinePropertyColumns = visibleOrderedColumns(taskColumns, taskViews.activeView).filter(
    (c) => !TASK_TIMELINE_EXCLUDED_KEYS.includes(c.key)
  );
  // Calendar's card structure treats Project the same way Timeline treats
  // Name -- always shown as its own dedicated line (see getProjectLabel
  // below), not a togglable chip -- so it's excluded here on top of the
  // Timeline exclusions, leaving Assignee/Effort/etc. as the remaining
  // optional property lines a person can toggle via Properties.
  // time_spent_hours is hard-excluded (not just hidden-by-default) even
  // though it's alwaysVisible for Table -- that flag exists so the
  // computed rollup can't be hidden from the Table column list, but it
  // also means normal hiddenColumns toggling can't suppress it, and its
  // render includes a live Start/Stop timer button that has no business
  // being clickable on a small calendar card.
  const TASK_CALENDAR_EXCLUDED_KEYS = ["name", "project", "start_date", "current_due_date", "time_spent_hours", "effort"];
  const taskCalendarPropertyColumns = visibleOrderedColumns(taskColumns, taskViews.activeView).filter(
    (c) => !TASK_CALENDAR_EXCLUDED_KEYS.includes(c.key)
  );

  // Explains to the Properties popover why toggling Name/Actual
  // Progress/Start/Due does nothing on a Timeline view -- see
  // PROJECT_TIMELINE_EXCLUDED_KEYS above. Only passed while the active
  // view actually is Timeline (Table/Board's Properties popover keeps
  // full normal toggling for every column).
  // Same lock-info concept, now shared between Timeline (bar-based) and
  // Calendar (card-based) -- both structurally show Name as the row/card
  // title and Start/Due via position (the Gantt bar's placement, or which
  // day a card sits on) rather than as a separate toggleable chip/line.
  const projectDatesShownStructurally = projectViews.activeView.viewType === "timeline" ? "the bar's position on the chart" : "which day the card sits on";
  const projectTimelinePropertyLockInfo =
    projectViews.activeView.viewType === "timeline" || projectViews.activeView.viewType === "calendar"
      ? {
          name: { reason: "Always shown as the row/card title, not a separate property", forcedVisible: true },
          actual_progress: {
            reason:
              projectViews.activeView.viewType === "timeline"
                ? "Always shown as the Gantt bar's own fill, not a chip"
                : "Not shown on Calendar cards",
            forcedVisible: projectViews.activeView.viewType === "timeline",
          },
          start_date: { reason: `Shown via ${projectDatesShownStructurally}, not as a separate property`, forcedVisible: false },
          end_date: { reason: `Shown via ${projectDatesShownStructurally}, not as a separate property`, forcedVisible: false },
        }
      : undefined;
  const taskDatesShownStructurally = taskViews.activeView.viewType === "timeline" ? "the bar's position on the chart" : "which day the card sits on";
  const taskTimelinePropertyLockInfo =
    taskViews.activeView.viewType === "timeline" || taskViews.activeView.viewType === "calendar"
      ? {
          name: { reason: "Always shown as the row/card title, not a separate property", forcedVisible: true },
          start_date: { reason: `Shown via ${taskDatesShownStructurally}, not as a separate property`, forcedVisible: false },
          current_due_date: { reason: `Shown via ${taskDatesShownStructurally}, not as a separate property`, forcedVisible: false },
          // Calendar-only: Project is a fixed line in the card (right
          // under the title, see getProjectLabel), same structural
          // treatment as Name -- not a togglable chip the way it is on
          // Timeline (hidden-by-default there, but still a normal chip).
          ...(taskViews.activeView.viewType === "calendar"
            ? {
                project: { reason: "Always shown as its own line under the task title", forcedVisible: true },
                time_spent_hours: { reason: "Not shown on Calendar cards -- its Start/Stop timer control doesn't belong on a small card", forcedVisible: false },
              }
            : {}),
        }
      : undefined;

  return (
    <div>
      {confirmDialog}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1>Projects &amp; Tasks</h1>
          <p className="subtitle">
            Every project and its tasks in one place. Owners can edit their project; anyone can edit their own tasks. Click any cell to edit it,
            like Notion.
          </p>
        </div>
        <button
          onClick={() => {
            setArchivedOpen(true);
            loadArchived();
          }}
          style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 10px", fontSize: 11.5, fontWeight: 500, color: "var(--text-secondary)", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", cursor: "pointer" }}
        >
          <ArchiveRestore size={13} />
          View archived
        </button>
      </div>

      <div className="card" style={{ padding: 0, marginBottom: 20 }}>
        <div className="sticky-toolbar-cluster" ref={projectClusterRef}>
        <div className="table-toolbar">
          <ViewTabs
            views={projectViews.views}
            activeViewId={projectViews.activeViewId}
            rows={projects}
            groupOptions={projectGroupOptions}
            onSelect={projectViews.setActiveViewId}
            onCreate={projectViews.createView}
            boardDefaultGroupBy="project_status"
            timelineDefaultHiddenColumns={PROJECT_TIMELINE_DEFAULT_HIDDEN_COLUMNS}
            calendarDefaultHiddenColumns={PROJECT_TIMELINE_DEFAULT_HIDDEN_COLUMNS}
            onRename={projectViews.renameView}
            onDelete={projectViews.deleteView}
            onColorChange={projectViews.setViewColor}
            onDuplicate={projectViews.duplicateView}
            confirm={confirm}
          />
          <div className="toolbar-actions">
            <ViewSettingsMenu
              rows={filteredProjects}
              columns={projectColumns}
              hiddenColumns={projectViews.activeView.hiddenColumns}
              onToggleColumn={(key) =>
                projectViews.updateActiveView({
                  hiddenColumns: projectViews.activeView.hiddenColumns.includes(key)
                    ? projectViews.activeView.hiddenColumns.filter((k) => k !== key)
                    : [...projectViews.activeView.hiddenColumns, key],
                })
              }
              groupOptions={projectGroupModeOptions}
              groupBy={projectResolvedGroupBy}
              hiddenGroups={projectViews.activeView.hiddenGroups}
              onGroupByChange={(groupBy) => projectViews.updateActiveView({ groupBy, hiddenGroups: [] })}
              onHiddenGroupsChange={(hiddenGroups) => projectViews.updateActiveView({ hiddenGroups })}
              showCount={projectViews.activeView.showCount}
              onShowCountChange={(showCount) => projectViews.updateActiveView({ showCount })}
              sortOptions={projectSortOptions}
              sorts={projectViews.activeView.sorts}
              onSortsChange={(sorts) => projectViews.updateActiveView({ sorts })}
              groupMode={projectGroupMode}
              people={people}
              filterPersonIds={resolveFilterPersonIds(projectViews.activeView)}
              onFilterPersonIdsChange={(filterPersonIds) => projectViews.updateActiveView({ filterPersonIds })}
              statusOptions={PROJECT_STATUS_OPTIONS}
              filterStatuses={projectViews.activeView.filterStatuses ?? []}
              onFilterStatusesChange={(filterStatuses) => projectViews.updateActiveView({ filterStatuses })}
              propertyLockInfo={projectTimelinePropertyLockInfo}
              hideGroupBy={projectViews.activeView.viewType === "calendar"}
            />
            {projectViews.activeView.viewType === "timeline" && (
              <TimelineControls
                scale={projectViews.activeView.timelineScale ?? "month"}
                onScaleChange={(timelineScale) => projectViews.updateActiveView({ timelineScale })}
                dateMode={projectViews.activeView.timelineDateMode ?? "range"}
                onDateModeChange={(timelineDateMode) => projectViews.updateActiveView({ timelineDateMode })}
              />
            )}
          </div>
        </div>
        <ViewFilterPills
          groupOptions={projectGroupModeOptions}
          groupBy={projectResolvedGroupBy}
          hiddenGroups={projectViews.activeView.hiddenGroups}
          onGroupByChange={(groupBy) => projectViews.updateActiveView({ groupBy, hiddenGroups: [] })}
          onHiddenGroupsChange={(hiddenGroups) => projectViews.updateActiveView({ hiddenGroups })}
          sortOptions={projectSortOptions}
          sorts={projectViews.activeView.sorts}
          onSortsChange={(sorts) => projectViews.updateActiveView({ sorts })}
          groupMode={projectGroupMode}
          people={people}
          filterPersonIds={resolveFilterPersonIds(projectViews.activeView)}
          filterStatuses={projectViews.activeView.filterStatuses ?? []}
          onClearFilter={() => projectViews.updateActiveView({ filterPersonIds: [], filterStatuses: [] })}
        />
        {projectViews.activeView.viewType !== "board" && projectViews.activeView.viewType !== "timeline" && selectedProjectIds.length > 0 && (
          <div className="bulk-bar">
            <span className="bulk-bar-count">{selectedProjectIds.length} selected</span>
            <button className="bulk-bar-clear" onClick={() => setSelectedProjectIds([])}>
              Clear
            </button>
            <div className="bulk-bar-actions">
              <FieldPickerButton label="Priority" options={PROJECT_PRIORITY_OPTIONS} onPick={(v) => bulkUpdateProjects({ priority: v as ProjectRow["priority"] })} />
              <FieldPickerButton
                label="Owner"
                options={people.map((x) => x.name)}
                onPick={(v) => {
                  const person = people.find((x) => x.name === v);
                  bulkUpdateProjects({ owner_id: person?.id ?? null });
                }}
              />
              <FieldPickerButton label="Status" options={PROJECT_STATUS_OPTIONS} onPick={(v) => bulkUpdateProjects({ project_status: v || null })} />
              <button className="bulk-bar-delete" onClick={bulkDeleteProjects}>
                <Trash2 size={12} />
                Delete
              </button>
            </div>
          </div>
        )}
        </div>
        {loading && !hasLoadedOnce.current ? (
          <div style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>Loading…</div>
        ) : projectViews.activeView.viewType === "board" ? (
          <>
            <BoardView
              rows={sortRows(filteredProjects, projectViews.activeView.sorts, projectSortOptions)}
              rowKey={(p) => p.id}
              columns={getProjectBoardColumns(resolveBoardGroupBy(projectViews.activeView.groupBy, PROJECT_BOARD_GROUPABLE_KEYS, "project_status"))}
              getValue={(p) => getProjectBoardValue(p, resolveBoardGroupBy(projectViews.activeView.groupBy, PROJECT_BOARD_GROUPABLE_KEYS, "project_status"))}
              hiddenColumns={projectViews.activeView.hiddenGroups}
              renderCard={renderProjectCard}
              onMoveCard={getProjectBoardMoveHandler(resolveBoardGroupBy(projectViews.activeView.groupBy, PROJECT_BOARD_GROUPABLE_KEYS, "project_status"))}
              onReorderCard={reorderProjects}
            />
            {canCreateProject && (
              <div className="add-row-trigger" style={{ margin: "0 12px 12px" }} onClick={createBlankProject}>
                <Plus size={12} />
                New project
              </div>
            )}
          </>
        ) : projectViews.activeView.viewType === "timeline" ? (
          <>
            <TimelineView
              rows={sortRows(filteredProjects, projectViews.activeView.sorts, projectSortOptions)}
              rowKey={(p) => p.id}
              renderLabel={(p) => projectColumns.find((c) => c.key === "name")?.render(p)}
              getStart={(p) => p.start_date}
              getDue={(p) => p.end_date}
              dateMode={projectViews.activeView.timelineDateMode ?? "range"}
              scale={projectViews.activeView.timelineScale ?? "month"}
              getTone={(p) => PROJECT_STATUS_TONES[p.project_status ?? ""] ?? "neutral"}
              getTooltip={(p) => `${p.name} · ${formatDate(p.start_date)} → ${formatDate(p.end_date)}`}
              emptyLabel="No projects yet. Add one below."
              propertyColumns={projectTimelinePropertyColumns}
              getProgress={(p) => actualProgress(p.id, tasks)}
              getGroup={projectTimelineGroupOption ? (p) => projectTimelineGroupOption.getGroup(p) : undefined}
              getGroupTone={projectTimelineGroupOption?.getTone}
              hiddenGroups={projectViews.activeView.hiddenGroups}
              labelWidth={projectViews.activeView.timelineLabelWidth ?? 460}
              onLabelWidthChange={(timelineLabelWidth) => projectViews.updateActiveView({ timelineLabelWidth })}
            />
            {canCreateProject && (
              <div className="add-row-trigger" style={{ margin: "0 12px 12px" }} onClick={createBlankProject}>
                <Plus size={12} />
                New project
              </div>
            )}
          </>
        ) : projectViews.activeView.viewType === "calendar" ? (
          <>
            <CalendarView
              rows={sortRows(filteredProjects, projectViews.activeView.sorts, projectSortOptions)}
              rowKey={(p) => p.id}
              renderLabel={(p) => projectColumns.find((c) => c.key === "name")?.render(p)}
              getStart={(p) => p.start_date}
              getDue={(p) => p.end_date}
              getTone={(p) => PROJECT_STATUS_TONES[p.project_status ?? ""] ?? "neutral"}
              getTooltip={(p) => `${p.name} · ${formatDate(p.start_date)} → ${formatDate(p.end_date)}`}
              emptyLabel="No projects yet. Add one below."
              dateMode={projectViews.activeView.timelineDateMode ?? "range"}
              onDateModeChange={(timelineDateMode) => projectViews.updateActiveView({ timelineDateMode })}
              propertyColumns={projectTimelinePropertyColumns}
            />
            {canCreateProject && (
              <div className="add-row-trigger" style={{ margin: "0 12px 12px" }} onClick={createBlankProject}>
                <Plus size={12} />
                New project
              </div>
            )}
          </>
        ) : (
          <div className="data-table-dense">
            <DataTable
              columns={projectColumns}
              rows={filteredProjects}
              rowKey={(p) => p.id}
              view={projectViews.activeView}
              onViewChange={projectViews.updateActiveView}
              groupOptions={projectGroupOptions}
              sortOptions={projectSortOptions}
              emptyLabel="No projects yet. Add one below."
              selectable
              selectedKeys={selectedProjectIds}
              onToggleSelect={(key) => setSelectedProjectIds((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))}
              onToggleSelectAll={toggleProjectSelectAll}
              orderable
              onReorder={reorderProjects}
              footerRow={
                canCreateProject
                  ? (colSpan) => (
                      <td colSpan={colSpan} className="add-row-cell">
                        <div className="add-row-trigger" onClick={createBlankProject}>
                          <Plus size={12} />
                          New project
                        </div>
                      </td>
                    )
                  : undefined
              }
            />
          </div>
        )}
      </div>

      <h2 style={{ marginTop: 0 }}>Tasks</h2>

      <div className="card" style={{ padding: 0 }}>
        <div className="sticky-toolbar-cluster" ref={taskClusterRef}>
        <div className="table-toolbar">
          <ViewTabs
            views={taskViews.views}
            activeViewId={taskViews.activeViewId}
            rows={visibleTasks}
            groupOptions={taskGroupOptions}
            onSelect={taskViews.setActiveViewId}
            onCreate={taskViews.createView}
            boardDefaultGroupBy="status"
            timelineDefaultHiddenColumns={TASK_TIMELINE_DEFAULT_HIDDEN_COLUMNS}
            calendarDefaultHiddenColumns={TASK_CALENDAR_DEFAULT_HIDDEN_COLUMNS}
            onRename={taskViews.renameView}
            onDelete={taskViews.deleteView}
            onColorChange={taskViews.setViewColor}
            onDuplicate={taskViews.duplicateView}
            confirm={confirm}
          />
          <div className="toolbar-actions">
            <ViewSettingsMenu
              rows={filteredVisibleTasks}
              columns={taskColumns}
              hiddenColumns={taskViews.activeView.hiddenColumns}
              onToggleColumn={(key) =>
                taskViews.updateActiveView({
                  hiddenColumns: taskViews.activeView.hiddenColumns.includes(key)
                    ? taskViews.activeView.hiddenColumns.filter((k) => k !== key)
                    : [...taskViews.activeView.hiddenColumns, key],
                })
              }
              groupOptions={taskGroupModeOptions}
              groupBy={taskResolvedGroupBy}
              hiddenGroups={taskViews.activeView.hiddenGroups}
              onGroupByChange={(groupBy) => taskViews.updateActiveView({ groupBy, hiddenGroups: [] })}
              onHiddenGroupsChange={(hiddenGroups) => taskViews.updateActiveView({ hiddenGroups })}
              showCount={taskViews.activeView.showCount}
              onShowCountChange={(showCount) => taskViews.updateActiveView({ showCount })}
              sortOptions={taskSortOptions}
              sorts={taskViews.activeView.sorts}
              onSortsChange={(sorts) => taskViews.updateActiveView({ sorts })}
              groupMode={taskGroupMode}
              people={people}
              filterPersonIds={resolveFilterPersonIds(taskViews.activeView)}
              onFilterPersonIdsChange={(filterPersonIds) => taskViews.updateActiveView({ filterPersonIds })}
              statusOptions={TASK_STATUS_OPTIONS}
              filterStatuses={taskViews.activeView.filterStatuses ?? []}
              onFilterStatusesChange={(filterStatuses) => taskViews.updateActiveView({ filterStatuses })}
              propertyLockInfo={taskTimelinePropertyLockInfo}
              hideGroupBy={taskViews.activeView.viewType === "calendar"}
            />
            {taskViews.activeView.viewType === "timeline" && (
              <TimelineControls
                scale={taskViews.activeView.timelineScale ?? "month"}
                onScaleChange={(timelineScale) => taskViews.updateActiveView({ timelineScale })}
                dateMode={taskViews.activeView.timelineDateMode ?? "range"}
                onDateModeChange={(timelineDateMode) => taskViews.updateActiveView({ timelineDateMode })}
              />
            )}
          </div>
        </div>
        <ViewFilterPills
          groupOptions={taskGroupModeOptions}
          groupBy={taskResolvedGroupBy}
          hiddenGroups={taskViews.activeView.hiddenGroups}
          onGroupByChange={(groupBy) => taskViews.updateActiveView({ groupBy, hiddenGroups: [] })}
          onHiddenGroupsChange={(hiddenGroups) => taskViews.updateActiveView({ hiddenGroups })}
          sortOptions={taskSortOptions}
          sorts={taskViews.activeView.sorts}
          onSortsChange={(sorts) => taskViews.updateActiveView({ sorts })}
          groupMode={taskGroupMode}
          people={people}
          filterPersonIds={resolveFilterPersonIds(taskViews.activeView)}
          filterStatuses={taskViews.activeView.filterStatuses ?? []}
          onClearFilter={() => taskViews.updateActiveView({ filterPersonIds: [], filterStatuses: [] })}
        />
        {taskViews.activeView.viewType !== "board" && taskViews.activeView.viewType !== "timeline" && selectedTaskIds.length > 0 && (
          <div className="bulk-bar">
            <span className="bulk-bar-count">{selectedTaskIds.length} selected</span>
            <button className="bulk-bar-clear" onClick={() => setSelectedTaskIds([])}>
              Clear
            </button>
            <div className="bulk-bar-actions">
              <FieldPickerButton label="Status" options={TASK_STATUS_OPTIONS} onPick={(v) => bulkUpdateTasks({ status: v || null })} />
              <FieldPickerButton
                label="Assignee"
                options={people.map((x) => x.name)}
                onPick={(v) => {
                  const person = people.find((x) => x.name === v);
                  bulkUpdateTasks({ assignee_id: person?.id ?? null });
                }}
              />
              <button className="bulk-bar-delete" onClick={bulkDeleteTasks}>
                <Trash2 size={12} />
                Delete
              </button>
            </div>
          </div>
        )}
        </div>
        {loading && !hasLoadedOnce.current ? (
          <div style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>Loading…</div>
        ) : taskViews.activeView.viewType === "board" ? (
          <>
            <BoardView
              rows={sortRowsHierarchical(filteredVisibleTasks, taskViews.activeView.sorts, taskSortOptions, (t) => t.id, (t) => t.parent_task_id)}
              rowKey={(t) => t.id}
              columns={getTaskBoardColumns(resolveBoardGroupBy(taskViews.activeView.groupBy, TASK_BOARD_GROUPABLE_KEYS, "status"))}
              getValue={(t) => getTaskBoardValue(t, resolveBoardGroupBy(taskViews.activeView.groupBy, TASK_BOARD_GROUPABLE_KEYS, "status"))}
              hiddenColumns={taskViews.activeView.hiddenGroups}
              renderCard={renderTaskCard}
              onMoveCard={getTaskBoardMoveHandler(resolveBoardGroupBy(taskViews.activeView.groupBy, TASK_BOARD_GROUPABLE_KEYS, "status"))}
              onReorderCard={reorderTasks}
            />
            {canCreateTask && (
              <div className="add-row-trigger" style={{ margin: "0 12px 12px" }} onClick={() => createBlankTask(projects[0]?.id ?? "")}>
                <Plus size={12} />
                New task
              </div>
            )}
          </>
        ) : taskViews.activeView.viewType === "timeline" ? (
          <>
            <TimelineView
              rows={sortRowsHierarchical(filteredVisibleTasks, taskViews.activeView.sorts, taskSortOptions, (t) => t.id, (t) => t.parent_task_id)}
              rowKey={(t) => t.id}
              renderLabel={(t) => taskColumns.find((c) => c.key === "name")?.render(t)}
              getStart={(t) => t.start_date}
              getDue={(t) => t.current_due_date}
              dateMode={taskViews.activeView.timelineDateMode ?? "range"}
              scale={taskViews.activeView.timelineScale ?? "month"}
              getTone={(t) => statusTone(statusGroupOf(TASK_STATUS_GROUPED, t.status))}
              getTooltip={(t) => `${t.name} · ${formatDate(t.start_date)} → ${formatDate(t.current_due_date)}`}
              emptyLabel="No tasks yet. Add one below."
              propertyColumns={taskTimelinePropertyColumns}
              getGroup={taskTimelineGroupOption ? (t) => taskTimelineGroupOption.getGroup(t) : undefined}
              getGroupTone={taskTimelineGroupOption?.getTone}
              hiddenGroups={taskViews.activeView.hiddenGroups}
              labelWidth={taskViews.activeView.timelineLabelWidth ?? 460}
              onLabelWidthChange={(timelineLabelWidth) => taskViews.updateActiveView({ timelineLabelWidth })}
            />
            {canCreateTask && (
              <div className="add-row-trigger" style={{ margin: "0 12px 12px" }} onClick={() => createBlankTask(projects[0]?.id ?? "")}>
                <Plus size={12} />
                New task
              </div>
            )}
          </>
        ) : taskViews.activeView.viewType === "calendar" ? (
          <>
            <CalendarView
              rows={sortRowsHierarchical(filteredVisibleTasks, taskViews.activeView.sorts, taskSortOptions, (t) => t.id, (t) => t.parent_task_id)}
              rowKey={(t) => t.id}
              renderLabel={(t) => (
                <InlineText value={t.name} editable={canEditTask(t)} bold onCommit={(v) => updateTask(t.id, { name: v })} />
              )}
              getParentLabel={(t) => (t.parent_task_id ? tasks.find((pt) => pt.id === t.parent_task_id)?.name ?? null : null)}
              getProjectLabel={(t) => projectName(t.project_id)}
              titleBadge={(t) => taskColumns.find((c) => c.key === "effort")?.render(t)}
              getStart={(t) => t.start_date}
              getDue={(t) => t.current_due_date}
              getTone={(t) => statusTone(statusGroupOf(TASK_STATUS_GROUPED, t.status))}
              getTooltip={(t) => `${t.name} · ${formatDate(t.start_date)} → ${formatDate(t.current_due_date)}`}
              emptyLabel="No tasks yet. Add one below."
              dateMode={taskViews.activeView.timelineDateMode ?? "range"}
              onDateModeChange={(timelineDateMode) => taskViews.updateActiveView({ timelineDateMode })}
              propertyColumns={taskCalendarPropertyColumns}
            />
            {canCreateTask && (
              <div className="add-row-trigger" style={{ margin: "0 12px 12px" }} onClick={() => createBlankTask(projects[0]?.id ?? "")}>
                <Plus size={12} />
                New task
              </div>
            )}
          </>
        ) : (
          <div className="data-table-dense">
            <DataTable
              columns={taskColumns}
              rows={filteredVisibleTasks}
              rowKey={(t) => t.id}
              getParentId={(t) => t.parent_task_id}
              view={taskViews.activeView}
              onViewChange={taskViews.updateActiveView}
              groupOptions={taskGroupOptions}
              sortOptions={taskSortOptions}
              emptyLabel="No tasks yet. Add one below."
              compactGutter
              selectable
              selectedKeys={selectedTaskIds}
              onToggleSelect={(key) => setSelectedTaskIds((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))}
              onToggleSelectAll={toggleTaskSelectAll}
              orderable
              onReorder={reorderTasks}
              footerRow={
                canCreateTask && taskViews.activeView.groupBy !== "project"
                  ? (colSpan) => (
                      <td colSpan={colSpan} className="add-row-cell">
                        <div className="add-row-trigger" onClick={() => createBlankTask(projects[0]?.id ?? "")}>
                          <Plus size={12} />
                          New task
                        </div>
                      </td>
                    )
                  : undefined
              }
              groupFooterRow={
                taskViews.activeView.groupBy === "project"
                  ? (colSpan, group) => {
                      // Empty groups (a project with no tasks yet) have no
                      // rows to read project_id off of -- fall back to
                      // matching the group's name against the projects list.
                      const projectId = group.rows[0]?.project_id ?? projects.find((p) => p.name === group.key)?.id;
                      if (!projectId || !canManageTasksIn(projectId)) return null;
                      return (
                        <td colSpan={colSpan} className="add-row-cell">
                          <div className="add-row-trigger" onClick={() => createBlankTask(projectId)}>
                            <Plus size={12} />
                            New task
                          </div>
                        </td>
                      );
                    }
                  : undefined
              }
            />
          </div>
        )}
      </div>

      {archivedOpen && (
        <Modal title="Archived items" onClose={() => setArchivedOpen(false)} width={560}>
          {archivedLoading ? (
            <p style={{ fontSize: 12.5, color: "var(--muted)" }}>Loading…</p>
          ) : archivedProjects.length === 0 && archivedTasks.length === 0 ? (
            <p style={{ fontSize: 12.5, color: "var(--muted)" }}>Nothing archived right now.</p>
          ) : (
            <>
              <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 0 }}>
                Archived items are permanently deleted {ARCHIVE_RETENTION_DAYS} days after archiving unless restored.
              </p>
              {archivedProjects.length > 0 && (
                <>
                  <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3, color: "var(--muted)", margin: "10px 0 4px" }}>
                    Projects
                  </div>
                  {archivedProjects.map((p) => {
                    const daysLeft = p.archived_at
                      ? ARCHIVE_RETENTION_DAYS - Math.floor((Date.now() - new Date(p.archived_at).getTime()) / (1000 * 60 * 60 * 24))
                      : ARCHIVE_RETENTION_DAYS;
                    return (
                      <div key={p.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 2px", borderBottom: "1px solid var(--border)" }}>
                        <div>
                          <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy)" }}>{p.name}</div>
                          <div style={{ fontSize: 10.5, color: "var(--muted)" }}>{daysLeft > 0 ? `${daysLeft} days left` : "Deleting soon"}</div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                          <button
                            onClick={() => restoreProject(p.id)}
                            style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 600, color: "var(--accent)", background: "none", border: "none", cursor: "pointer" }}
                          >
                            <ArchiveRestore size={13} />
                            Restore
                          </button>
                          <button
                            onClick={() => deleteProjectPermanently(p)}
                            style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 600, color: "var(--danger-text)", background: "none", border: "none", cursor: "pointer" }}
                          >
                            <Trash2 size={13} />
                            Delete permanently
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
              {archivedTasks.length > 0 && (
                <>
                  <div style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3, color: "var(--muted)", margin: "10px 0 4px" }}>
                    Tasks
                  </div>
                  {archivedTasks.map((t) => {
                    const daysLeft = t.archived_at
                      ? ARCHIVE_RETENTION_DAYS - Math.floor((Date.now() - new Date(t.archived_at).getTime()) / (1000 * 60 * 60 * 24))
                      : ARCHIVE_RETENTION_DAYS;
                    return (
                      <div key={t.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 2px", borderBottom: "1px solid var(--border)" }}>
                        <div>
                          <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy)" }}>{t.name}</div>
                          <div style={{ fontSize: 10.5, color: "var(--muted)" }}>{daysLeft > 0 ? `${daysLeft} days left` : "Deleting soon"}</div>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                          <button
                            onClick={() => restoreTask(t.id)}
                            style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 600, color: "var(--accent)", background: "none", border: "none", cursor: "pointer" }}
                          >
                            <ArchiveRestore size={13} />
                            Restore
                          </button>
                          <button
                            onClick={() => deleteTaskPermanently(t)}
                            style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 600, color: "var(--danger-text)", background: "none", border: "none", cursor: "pointer" }}
                          >
                            <Trash2 size={13} />
                            Delete permanently
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </>
          )}
        </Modal>
      )}

      {extensionTask && (
        <RequestExtensionModal
          taskName={extensionTask.name}
          currentDueDate={extensionTask.current_due_date}
          onClose={() => setExtensionTask(null)}
          onSubmit={(newDueDate, reasonCategory, reasonNotes) =>
            submitExtensionRequest(extensionTask, newDueDate, reasonCategory, reasonNotes)
          }
        />
      )}

      {extensionProject && extensionProject.end_date && (
        <RequestExtensionModal
          taskName={extensionProject.name}
          currentDueDate={extensionProject.end_date}
          onClose={() => setExtensionProject(null)}
          approvalNote="This is a whole-project timeline change, so it always goes to your manager (or Full Access) for approval -- never self-approved, even by the project owner."
          onSubmit={(newDueDate, reasonCategory, reasonNotes) =>
            submitProjectExtensionRequest(extensionProject, newDueDate, reasonCategory, reasonNotes)
          }
        />
      )}

      {extDetailTask && (
        <Modal title={`Extension history -- ${extDetailTask.name}`} onClose={() => setExtDetailTask(null)}>
          {taskExtensionRequests(extDetailTask.id).length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--muted)" }}>No extension requests have been made for this task yet.</p>
          ) : (
            taskExtensionRequests(extDetailTask.id).map((r) => (
              <div key={r.id} style={{ padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <span className={`status-pill ${r.status === "Approved" ? "success" : r.status === "Rejected" ? "danger" : "warning"}`}>{r.status}</span>
                  <span style={{ fontSize: 11, color: "var(--muted)" }}>
                    {formatDate(extDetailTask.current_due_date)} {"\u2192"} {formatDate(r.requested_new_due_date)}
                  </span>
                </div>
                <div style={{ fontSize: 11.5, marginBottom: 4 }}>
                  <span className="status-pill neutral" style={{ fontSize: 9.5 }}>
                    {r.reason_category}
                  </span>
                  <span style={{ marginLeft: 6 }}>{r.reason_notes}</span>
                </div>
                <div style={{ fontSize: 10.5, color: "var(--muted)" }}>
                  Requested {formatDate(r.created_at)}
                  {r.status !== "Pending" && r.decided_at && <> · {r.status} on {formatDate(r.decided_at)}</>}
                  {r.decision_notes && <> -- "{r.decision_notes}"</>}
                </div>
              </div>
            ))
          )}
          {isProjectLocked(extDetailTask.project_id) && canEditTask(extDetailTask) && (
            <button
              onClick={() => {
                setExtDetailTask(null);
                setExtensionTask(extDetailTask);
              }}
              style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 600, color: "var(--accent)", background: "none", border: "1px solid var(--accent)", borderRadius: "var(--radius-sm)", padding: "5px 10px", cursor: "pointer" }}
            >
              <CalendarClock size={13} />
              {dueDateExtStatus(extDetailTask).label === "Extended" ? "Request another extension" : "Request extension"}
            </button>
          )}
        </Modal>
      )}
    </div>
  );
}
