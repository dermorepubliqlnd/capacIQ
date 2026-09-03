import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, CornerDownRight, ChevronRight, ChevronDown, Archive, ArchiveRestore, Trash2, Feather, Weight, BicepsFlexed, Flame, AlertTriangle, CalendarClock, CheckCircle2, X, RotateCcw, MessageCircle, Handshake, ShieldCheck, Cpu, Crown, TrendingUp, Wrench, Sparkles, Folder, Lock } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useSession } from "../lib/useSession";
import { useTableViews } from "../lib/useTableViews";
import DataTable from "../components/DataTable";
import BoardView, { type BoardColumnDef } from "../components/BoardView";
import TimelineView, { TimelineControls } from "../components/TimelineView";
import CalendarView from "../components/CalendarView";
import CardActionMenu from "../components/CardActionMenu";
import ViewTabs from "../components/ViewTabs";
import ViewSettingsMenu, { ViewFilterPills } from "../components/ViewSettingsMenu";
import Modal from "../components/Modal";
import RequestExtensionModal from "../components/RequestExtensionModal";
import NotesSidebar from "../components/NotesSidebar";
import { useConfirm } from "../lib/useConfirm";
import { InlineText, InlineSelect, InlineDate, InlineNumber } from "../components/InlineCell";
import ProgressCell, { ProgressDisplayToggle } from "../components/ProgressCell";
import type { ColumnDef, GroupOption, SortOption } from "../lib/tableTypes";
import { sortRows, sortRowsHierarchical, visibleOrderedColumns, resolveFilterPersonIds } from "../lib/tableTypes";
import { formatDate } from "../lib/formatDate";
import { WBS_STATUS_META, wbsStatusMetaFor, type WbsStatus } from "../lib/wbsStatus";

// Tone-palette mapping for wbs_status (Phase 4, 2026-07-28) -- WBS_STATUS_META
// carries its own bg/color/border for the WBS Planning page's banner, but
// Table/Board group headers and Kanban columns here use the shared
// TONE_STYLES palette (see tableTypes.ts) instead, so this is a separate,
// small mapping onto that existing vocabulary.
const WBS_STATUS_TONES: Record<WbsStatus, string> = {
  draft: "neutral",
  baseline_locked: "accent",
  revision_in_progress: "warning",
  changed_after_baseline: "gold",
  closed: "neutral",
};
import { rollupHoursFor, ownHoursFor, formatHours, type TimeEntryRow } from "../lib/timeTracking";
// Deletion history archive (2026-08-14c): a permanently-deleted task's own
// logged Spent Hrs are archived (supabase/policies.sql "Migration
// 2026-08-14c") as a raw per-project-per-person hours total before the
// task row disappears, so a project's Spent Hrs rollup doesn't shrink just
// because one of its tasks was deleted. No FK on its project_id (see the
// migration) so this row also survives the project itself later being
// permanently deleted -- an orphaned total with nowhere left to show
// against, but not lost data.
interface DeletedSpentHourRow {
  project_id: string | null;
  person_id: string;
  hours: number;
}
import { useTimeTracking } from "../lib/TimeTrackingContext";
import { CATEGORY_ICON_LIBRARY, CATEGORY_TONE_ICON_COLOR } from "../lib/categoryIcons";
import { Play, Square } from "lucide-react";
import {
  PROJECT_EFFORT_LEVEL_OPTIONS,
  PROJECT_EFFORT_LEVEL_TONES,
  effortLevelLabel,
  PROJECT_PRIORITY_OPTIONS,
  priorityLabel,
  PROJECT_STATUS_OPTIONS,
  PROJECT_STATUS_TONES,
  PROJECT_PHASE_TONES,
  TASK_STATUS_GROUPED,
  TASK_STATUS_OPTIONS,
  TASK_EFFORT_OPTIONS,
  TASK_EFFORT_DEFAULT_TONES,
  statusGroupOf,
} from "../lib/notionOptions";

interface PersonOption {
  id: string;
  name: string;
  // 2026-09-03: needed for Grouped-by-Assignee's colored headers
  // (colorForPerson) -- was not previously fetched here since nothing on
  // this page rendered a person's own color before.
  color?: string | null;
}

// Work Type (Phase 12, 2026-08-20): admin-configurable lookup, replacing
// what would otherwise be a hardcoded array -- see the Admin page's own
// "Work Types" section for add/rename/reorder/deactivate. Fetched
// UNFILTERED (not just is_active) here, unlike `people` above, because a
// task whose Work Type was later deactivated still needs its historical
// label to resolve for display; only the WBS Planning picker itself
// filters to is_active.
interface WorkTypeOption {
  id: string;
  name: string;
  is_active: boolean;
  sort_order: number;
}

// Project Source (Phase 20, 2026-08-24) -- admin-configurable lookup for
// "how/why a project originated" (Intake, L&D Initiative, ...), managed
// on Site Settings same as Work Types. Separate dimension from Category
// (which classifies training TYPE). Fetched unfiltered for the same
// historical-label reason as WorkTypeOption above.
interface ProjectSourceOption {
  id: string;
  name: string;
  is_active: boolean;
  sort_order: number;
}

// Project Category (2026-09-03) -- admin-configurable lookup, mirrors
// ProjectSourceOption exactly. Unlike Source, projects.category stays a
// plain text column (not a category_id FK) -- Category has far more code
// touchpoints (icon map, tone map, grouping, board columns) than Source,
// so this keeps the refactor to "where does the option LIST come from"
// only. Icon + color are self-service as of Phase 36 (2026-09-03) --
// see categoryIconMap/categoryToneMap below and categoryIcons.ts.
interface ProjectCategoryOption {
  id: string;
  name: string;
  is_active: boolean;
  sort_order: number;
  // Self-service icon/color (Phase 36, 2026-09-03) -- keys into
  // CATEGORY_ICON_LIBRARY / CATEGORY_TONE_ICON_COLOR (categoryIcons.ts),
  // set from the "Manage Project Categories" picker in Site Settings.
  icon: string;
  color: string;
}

// Project Phase (2026-09-03) -- admin-configurable lookup, mirrors
// ProjectCategoryOption. Which Phases are OFFERED under which Status
// (Sandra: "phase is conditional/dependent on status, make sure I can
// make that mapping") is a separate many-to-many table,
// project_status_phase_mapping, edited as a matrix in Site Settings --
// same pattern as the existing Task Type <-> Output Type mapping.
// Deliberately NOT covered: Status itself (Not Started/In Progress/
// Completed/Paused/Cancelled) stays a fixed, code-defined set, not
// admin-renameable -- health scoring, the Design-phase lock guardrail,
// and a DB CHECK constraint all key off those exact 5 strings, so
// letting them be renamed/deleted here would silently break those.
// Completed is always forced to Phase "Done", and Paused/Cancelled
// always offer the full active Phase list (both pre-existing, deliberate
// product rules -- see project_capaciq_status_phase_redesign) -- so
// only Not Started and In Progress have a real, mapping-editable subset.
interface ProjectPhaseOption {
  id: string;
  name: string;
  is_active: boolean;
  sort_order: number;
}

export interface ProjectRow {
  id: string;
  name: string;
  owner_id: string | null;
  category: string | null;
  source_id: string | null;
  priority: "Low" | "Medium" | "High" | null;
  status: string | null;
  phase: string | null;
  effort_level: string | null;
  start_date: string | null;
  end_date: string | null;
  is_archived: boolean;
  archived_at: string | null;
  sort_order: number | null;
  timelines_locked: boolean;
  original_start_date: string | null;
  original_due_date: string | null;
  wbs_status: WbsStatus;
}

export interface TaskRow {
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
  validated_locked_at: string | null;
  validated_locked_by: string | null;
  // Assignee self-reported (2026-08-20, Sandra: "allow users to add
  // their actual task completion date") -- distinct from both
  // submitted_on (automatic, stamped the instant Status flips to Done)
  // and validated_completion_date (manager/owner sign-off) -- lets an
  // assignee record the real date they finished, independent of when a
  // validator gets around to confirming it. Locks alongside the other
  // isTaskLocked-gated fields once validated (also enforced at the DB
  // layer, see enforce_task_validation_field_lock in phase10_migration).
  actual_completion_date: string | null;
  effort: string | null;
  // Phase 12 (2026-08-20): new reporting dimension, admin-configurable via
  // work_types (see WorkTypeOption above) -- nullable, existing tasks
  // won't have one until someone sets it going forward.
  work_type_id: string | null;
  // Phase 21 (2026-08-24): Materials Output -- what kind of material a
  // task produced (admin-configurable via output_types, see WBS Planning's
  // OutputTypeOption) and how many units. Feeds the Portfolio Dashboard's
  // Materials Output card + breakdown chart.
  output_type_id: string | null;
  output_count: number | null;
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

// SVG icon per Category (replacing the old flat-color emoji badges) --
// same icon reused for the Project-name badge and the Category cell/
// Timeline chip itself, so both stay in sync automatically. Icon/color
// per category are now self-service (Phase 36, 2026-09-03): each
// ProjectCategoryOption carries its own `icon`/`color` fields (set from
// the Site Settings picker), looked up against the fixed palettes in
// categoryIcons.ts -- CategoryIcon itself just renders whichever
// icon name + tone it's given, falling back to Folder/neutral for a
// category with no match (e.g. a name typed directly into `category`
// that no longer has a row in project_categories).
function CategoryIcon({ iconName, tone, size = 13 }: { iconName?: string; tone?: string; size?: number }) {
  const Icon = (iconName && CATEGORY_ICON_LIBRARY[iconName]) || Folder;
  const color = CATEGORY_TONE_ICON_COLOR[tone ?? "neutral"] ?? CATEGORY_TONE_ICON_COLOR.neutral;
  return <Icon size={size} color={color} style={{ flexShrink: 0 }} />;
}

const PROJECT_COLUMN_ORDER = ["name", "owner", "category", "source", "status", "health", "phase", "priority", "start_date", "end_date", "actual_progress", "wbs_status", "estimated_hours", "time_spent_hours", "hours_variance", "hours_variance_pct", "days_extended", "effort_level"];

// Default hidden-columns set for a brand-new Projects Timeline view (see
// timelineDefaultHiddenColumns on ViewTabs / initialHiddenColumns on
// createView) -- per Sandra's curated Timeline-chip spec, Category/Effort/
// Timelines(lock state)/Days Extended start hidden but stay available to
// turn on via Properties; Status/Owner/Priority/Health start visible.
const PROJECT_TIMELINE_DEFAULT_HIDDEN_COLUMNS = ["category", "source", "effort_level", "days_extended", "estimated_hours", "time_spent_hours", "hours_variance", "hours_variance_pct"];
// Same idea for Tasks Timeline: "Days +/-" (Sandra: a signed day-count is
// redundant once you can already see a bar's length/position on the
// chart), Hrs Variance/%/Est./Spent (effort-tracking detail, not
// scheduling), Validated (a completion-approval flag, not a date signal),
// and Project (redundant with the swimlane header while the default
// grouping is "by Project" -- worth re-showing if grouping changes).
// All still available via Properties, just not cluttering a fresh
// Timeline view by default.
const TASK_TIMELINE_DEFAULT_HIDDEN_COLUMNS = ["project", "timing_variance_days", "estimated_hours", "time_spent_hours", "hours_variance", "hours_variance_pct", "validated_completion_date", "validated_by", "actual_completion_date", "work_type"];
// Task Calendar cards are much denser than a Timeline row -- Sandra asked
// specifically for Project/Effort/Assignee to show by default ("main
// focal point should be the task" -- Name is always the card's title
// regardless), everything else starts hidden but stays available via
// Properties. Unlike Timeline, Project stays visible here since Calendar
// has no swimlane/group-by-project header to make it redundant (Notion's
// own Calendar view doesn't support grouping either -- confirmed with
// Sandra, not building it).
const TASK_CALENDAR_DEFAULT_HIDDEN_COLUMNS = ["status", "timing", "validated_completion_date", "validated_by", "actual_completion_date", "estimated_hours", "time_spent_hours", "timing_variance_days", "hours_variance", "hours_variance_pct", "work_type"];
const TASK_COLUMN_ORDER = ["name", "project", "assignee", "status", "timing", "start_date", "current_due_date", "actual_completion_date", "validated_completion_date", "validated_by", "estimated_hours", "time_spent_hours", "effort", "timing_variance_days", "due_date_ext", "work_type", "hours_variance", "hours_variance_pct"];

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
  // "Very Heavy" (Phase 12, 2026-08-20) -- Effort's new top computed tier
  // for tasks estimated over 24 hours. Flame per the same "fun, not
  // corporate" spirit as the other three.
  "Very Heavy": Flame,
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
export function countWorkingDays(start: Date, end: Date, holidayDates: Set<string>): number {
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
// SUGGEST closing the project out rather than auto-flipping status,
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
//   0a. Status is Completed or Cancelled -- echo that status verbatim at
//       neutral tone. A closed-out project never gets second-guessed by
//       the formula below (confirmed with Sandra 2026-07-17: a project
//       cancelled at 30% actual progress should read "Cancelled", not
//       "Off track"). Redesigned 2026-07-23: this used to be a derived
//       3-bucket check (statusGroupOf's "complete" bucket, which lumped
//       Done/Canceled/Merged together) -- now that Status is its own
//       small lifecycle field, it's a direct equality check, no bucket
//       derivation needed.
//   0b. Status is Paused -- echo "Paused" at its own tone. New rule as of
//       the Status/Phase split: a paused project shouldn't be silently
//       judged On track/Overdue by the formula below while work on it
//       isn't actually happening.
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
export function healthOf(
  p: ProjectRow,
  allTasks: TaskRow[],
  holidayDates: Set<string>
): { label: string; tone: "success" | "warning" | "danger" | "neutral" | "purple" } {
  if (p.status === "Completed" || p.status === "Cancelled") return { label: p.status, tone: "neutral" };
  if (p.status === "Paused") return { label: "Paused", tone: "purple" };

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

export function actualProgress(projectId: string, allTasks: TaskRow[]): number | null {
  // Bugfix (2026-08-31, P1). This used to weight each task by
  // TASK_EFFORT_POINTS[t.effort]. That map deliberately has no "Very Heavy"
  // key (it belongs to the retired points model), so a Very Heavy task --
  // which is simply any task over 24 estimated hours (see
  // effort_level_thresholds / phase12_migration.sql; effort is DERIVED from
  // hours, not typed) -- scored weight 0 and was skipped entirely. A project
  // made only of large tasks therefore had denominator 0, returned null, and
  // rendered as "Health unavailable" on Projects and in the Dashboard donut:
  // the biggest projects were exactly the ones with no progress reading.
  //
  // Since effort is now derived from estimated_hours anyway, weighting by
  // estimated_hours directly is both strictly more accurate (a 40h task
  // counts twice a 20h one, instead of both being "Heavy-ish") and removes
  // the lookup hole permanently.
  //
  // Parent tasks are excluded: a parent's estimated_hours is auto-populated
  // as the SUM of its sub-tasks', so counting it too double-weighted every
  // grouped branch.
  const parentIds = new Set(allTasks.filter((t) => t.parent_task_id).map((t) => t.parent_task_id as string));
  const projectTasks = allTasks.filter((t) => t.project_id === projectId && !parentIds.has(t.id));
  if (projectTasks.length === 0) return null;
  let numerator = 0;
  let denominator = 0;
  for (const t of projectTasks) {
    const weight = t.estimated_hours ?? 0;
    if (weight <= 0) continue;
    const factor = TASK_COMPLETION_FACTOR[t.status ?? ""] ?? 0;
    numerator += weight * factor;
    denominator += weight;
  }
  if (denominator > 0) return Math.round((numerator / denominator) * 100);
  // Fallback: no task in this project has hours scoped yet. Rather than the
  // old "Health unavailable", fall back to plain equal-weight task counting
  // -- a status-only reading is still a real reading, and "no estimate yet"
  // is a scoping gap, not a reason to hide progress entirely.
  const factorSum = projectTasks.reduce((sum, t) => sum + (TASK_COMPLETION_FACTOR[t.status ?? ""] ?? 0), 0);
  return Math.round((factorSum / projectTasks.length) * 100);
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
// Redesigned 2026-07-23 alongside the Status/Phase split: rather than one
// 11-wide board clustered under 3 super-labels, there are now two board
// column sets -- a small 5-column Status board (the lifecycle view), and
// an 8-column Phase board (the real pipeline view, clustered under Not
// Started/In Progress/Completed the same way the old combined field was,
// so it still reads with structure). Phase is the more natural default
// for a Kanban-style board (it's literally "where in production is this"),
// but Status stays available too since it's still a real, board-groupable
// field.
const PROJECT_BOARD_STATUS_COLUMNS: BoardColumnDef[] = PROJECT_STATUS_OPTIONS.map((value) => ({
  value,
  label: value,
  tone: PROJECT_STATUS_TONES[value] ?? "neutral",
}));

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
const PROJECT_BOARD_GROUPABLE_KEYS = ["status", "phase", "priority", "category", "source", "effort_level", "owner", "wbs_status"];
const TASK_BOARD_GROUPABLE_KEYS = ["status", "assignee", "effort", "work_type", "project", "timing", "due_date_ext"];

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
  // Priority: manager/owner-validated date (authoritative) > the
  // assignee's own self-reported actual_completion_date > the automatic
  // submitted_on stamp as a last resort (2026-08-20: added the
  // self-reported tier between the two existing ones, at Sandra's
  // request, so Days +/- reflects when someone says they actually
  // finished rather than only the system's Done-flip timestamp once a
  // validator gets to it).
  return t.validated_completion_date ?? t.actual_completion_date ?? t.submitted_on;
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
// Estimated Hours used to be a flat, independently-set field on every task
// row with no rollup relationship between a parent and its sub-tasks --
// Sandra (2026-07-23) asked for a parent-task rollup instead (see
// taskEstimatedHoursFromSubtasks + its sync effect below, same shape as
// the existing Start/Due date rollup). Once that sync effect writes a
// parent's own estimated_hours to match the sum of its direct children,
// counting a parent's own field here too would double it -- so this
// excludes any task that has children, summing only true leaf tasks
// (whether top-level with no sub-tasks, or a sub-task itself).
function projectEstimatedHoursTotal(projectId: string, allTasks: TaskRow[]): number | null {
  const withEstimate = allTasks.filter(
    (t) =>
      t.project_id === projectId &&
      !t.is_archived &&
      t.estimated_hours !== null &&
      t.estimated_hours !== undefined &&
      !allTasks.some((child) => child.parent_task_id === t.id && !child.is_archived)
  );
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
function projectSpentHoursTotal(projectId: string, allTasks: TaskRow[], entries: TimeEntryRow[], deletedSpent: DeletedSpentHourRow[] = []): number {
  const projectTasks = allTasks.filter((t) => t.project_id === projectId && !t.is_archived);
  const liveTotal = projectTasks.reduce((sum, t) => sum + ownHoursFor(entries, t.id), 0);
  // Deletion archive (2026-08-14c): a task that got permanently deleted no
  // longer has a row in allTasks/entries to sum above -- its own logged
  // hours were archived (by project) before it disappeared, so add those
  // back in here rather than letting the project's total silently shrink.
  const archivedTotal = deletedSpent.filter((d) => d.project_id === projectId).reduce((sum, d) => sum + Number(d.hours), 0);
  return Math.round((liveTotal + archivedTotal) * 100) / 100;
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
function FieldPickerButton({
  label,
  options,
  onPick,
  labelFor,
}: {
  label: string;
  options: string[];
  onPick: (value: string) => void;
  labelFor?: (value: string) => string;
}) {
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
              {labelFor ? labelFor(o) : o}
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
// Projects are (see [[project_capaciq_archive_semantics]]) -- but several
// tables reference task_id with no ON DELETE CASCADE, so deleting a task
// that ever accumulated one of these dependent rows hits a foreign key
// violation ("update or delete on table "tasks" violates foreign key
// constraint ..."). First hit for extension_requests (Sandra 2026-07-22),
// then task_effort_changes for Task 4 (2026-07-23) -- and the first fix
// attempt (separate client-side .from(table).delete() calls before the
// tasks delete) turned out to be a dead end: none of these dependent
// tables have a DELETE policy defined under RLS, so those client-side
// deletes were silent no-ops (0 rows affected, no error), and the
// underlying row was never actually removed. Now delegates to a single
// security-definer RPC (delete_tasks_and_dependents, supabase/policies.sql)
// that checks authorization itself (mirrors tasks_delete's own policy
// condition) and clears extension_requests, task_effort_changes,
// time_entries, and task_collaborators with elevated privileges before
// deleting the tasks -- so RLS can't silently swallow the cleanup again.
async function deleteTasksAndDependents(ids: string[]): Promise<{ error: string | null }> {
  if (ids.length === 0) return { error: null };
  const { error } = await supabase.rpc("delete_tasks_and_dependents", { p_task_ids: ids });
  return { error: error?.message ?? null };
}

export default function Projects() {
  const navigate = useNavigate();
  const { person: me } = useSession();
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [people, setPeople] = useState<PersonOption[]>([]);
  // Work Types (Phase 12, 2026-08-20) -- fetched unfiltered (all rows,
  // active or not) so a task referencing a since-deactivated Work Type
  // still resolves to its historical label here; only the WBS Planning
  // picker itself narrows this down to is_active for new selections.
  const [workTypes, setWorkTypes] = useState<WorkTypeOption[]>([]);
  const [projectSources, setProjectSources] = useState<ProjectSourceOption[]>([]);
  const [projectCategories, setProjectCategories] = useState<ProjectCategoryOption[]>([]);
  // Active category names, in sort order -- replaces the old hardcoded
  // PROJECT_CATEGORY_OPTIONS wherever the Category picker/grouping/board
  // needs its list of choices.
  const projectCategoryOptions = useMemo(
    () => projectCategories.filter((c) => c.is_active).map((c) => c.name),
    [projectCategories]
  );
  // Live icon/color lookups (Phase 36, 2026-09-03) -- replaces the old
  // hardcoded PROJECT_CATEGORY_ICON_COMPONENTS/PROJECT_CATEGORY_TONES
  // maps everywhere a category's badge is rendered. Includes inactive
  // categories too (a project can still carry a since-deactivated
  // category's name -- it should keep showing its own icon/color, same
  // "never make an existing value disappear" convention as elsewhere).
  const categoryIconMap = useMemo(
    () => Object.fromEntries(projectCategories.map((c) => [c.name, c.icon])),
    [projectCategories]
  );
  const categoryToneMap = useMemo(
    () => Object.fromEntries(projectCategories.map((c) => [c.name, c.color])),
    [projectCategories]
  );
  const [projectPhases, setProjectPhases] = useState<ProjectPhaseOption[]>([]);
  // status_phase_mapping rows: which Phase ids are offered under "Not
  // Started" / "In Progress" (the only two Statuses with a real,
  // Sandra-editable subset -- see ProjectPhaseOption's comment above).
  const [phaseStatusMapping, setPhaseStatusMapping] = useState<{ status: string; phase_id: string }[]>([]);
  // 2026-09-03 -- project ids with a pending project_baseline_requests
  // row, purely for the WBS Status display override below (see
  // wbsStatusMetaFor). Not the same thing as the request itself (no
  // reason/decision data needed here, just "is one pending right now").
  const [pendingBaselineProjectIds, setPendingBaselineProjectIds] = useState<Set<string>>(new Set());
  const activePhaseNames = useMemo(
    () => projectPhases.filter((ph) => ph.is_active).map((ph) => ph.name),
    [projectPhases]
  );
  // Replaces the old hardcoded PROJECT_PHASE_OPTIONS_BY_STATUS lookup --
  // Completed/Paused/Cancelled keep their fixed, previously-agreed rules;
  // Not Started/In Progress read Sandra's own mapping (Site Settings),
  // always including the project's OWN current phase even if it's since
  // been unmapped or deactivated, same "never make an existing value
  // disappear from its own picker" convention as projectSources above.
  function phaseOptionsForStatus(status: string | null, currentPhase?: string | null): string[] {
    if (status === "Completed") return ["Done"];
    if (status === "Paused" || status === "Cancelled" || !status) {
      return currentPhase && !activePhaseNames.includes(currentPhase) ? [...activePhaseNames, currentPhase] : activePhaseNames;
    }
    const mappedIds = new Set(phaseStatusMapping.filter((m) => m.status === status).map((m) => m.phase_id));
    const mapped = projectPhases.filter((ph) => mappedIds.has(ph.id) && (ph.is_active || ph.name === currentPhase)).map((ph) => ph.name);
    return currentPhase && !mapped.includes(currentPhase) ? [...mapped, currentPhase] : mapped;
  }
  // Replaces the old hardcoded nextPhaseForStatus import from
  // notionOptions.ts -- same cascade rules, but the Not Started/In
  // Progress default and "already valid" check now read the live
  // mapping instead of a fixed array.
  function nextPhaseForStatusLive(currentPhase: string | null, newStatus: string): string | null {
    if (newStatus === "Completed") return "Done";
    if (newStatus === "Paused" || newStatus === "Cancelled") return currentPhase;
    const options = phaseOptionsForStatus(newStatus, currentPhase);
    if (currentPhase && options.includes(currentPhase)) return currentPhase;
    return options[0] ?? currentPhase;
  }
  // Manager-chain data for the new validation-authority check below
  // (2026-08-20) -- deliberately a SEPARATE, unfiltered fetch (includes
  // inactive people) from `people` above, which stays active-only for
  // assignee dropdowns etc. Walking a reports_to chain to find the
  // nearest ACTIVE manager needs to see inactive intermediates too, or
  // the chain breaks the moment it hits one. This is only used for
  // deciding whether to show the Validate button -- the real
  // authorization gate is the validate_task_completion RPC server-side,
  // so an approximate client-side check here is fine.
  const [chainPeople, setChainPeople] = useState<{ id: string; reports_to: string | null; is_active: boolean }[]>([]);
  // Project Notes (2026-08-14): per-project note count for the list/board
  // bubble, and which project (if any) currently has the Notes sidebar
  // open. Counts are fetched once in loadAll() and kept in sync afterward
  // by NotesSidebar itself calling onCountChange whenever it loads/posts.
  const [noteCounts, setNoteCounts] = useState<Record<string, number>>({});
  const [notesSidebarProjectId, setNotesSidebarProjectId] = useState<string | null>(null);
  // Per-person Spent Hrs breakdown popup (2026-08-14) -- which task's
  // breakdown modal (if any) is currently open.
  const [hoursBreakdownTaskId, setHoursBreakdownTaskId] = useState<string | null>(null);
  const [timeEntries, setTimeEntries] = useState<TimeEntryRow[]>([]);
  const [deletedSpentHours, setDeletedSpentHours] = useState<DeletedSpentHourRow[]>([]);
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

  // Persisted (2026-08-26, Sandra: "the task list defaults to expanded
  // view every time there's a refresh, can the system remember the last
  // setting or view selected by the user?") -- same localStorage
  // convention as DataTable's own collapsedGroups (see that component's
  // doc comment): per-browser/per-user, not part of any shared/saved
  // view, since which sub-task groups are collapsed is a personal
  // reading preference, not team-shared config.
  const COLLAPSED_PARENTS_STORAGE_KEY = "capaciq_tasks_collapsed_parents";
  const [collapsedParents, setCollapsedParentsState] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(COLLAPSED_PARENTS_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });
  function setCollapsedParents(updater: string[] | ((prev: string[]) => string[])) {
    setCollapsedParentsState((prev) => {
      const next = typeof updater === "function" ? (updater as (prev: string[]) => string[])(prev) : updater;
      try {
        localStorage.setItem(COLLAPSED_PARENTS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore -- private browsing / storage full, still works for the
        // rest of this session, it just won't persist across refreshes
      }
      return next;
    });
  }
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
    const [{ data: projectData }, { data: taskData }, { data: peopleData }, { data: chainPeopleData }, { data: holidayData }, { data: extReqData }, { data: timeEntryData }, { data: noteData }, { data: delSpentData }, { data: workTypeData }, { data: projectSourceData }, { data: projectCategoryData }, { data: projectPhaseData }, { data: phaseMappingData }, { data: pendingBaselineData }] = await Promise.all([
      supabase.from("projects").select("*").eq("is_archived", false).order("sort_order"),
      supabase.from("tasks").select("*").eq("is_archived", false).order("sort_order"),
      supabase.from("people").select("id,name,color").eq("is_active", true).order("name"),
      supabase.from("people").select("id,reports_to,is_active"),
      supabase.from("holidays").select("date"),
      supabase
        .from("extension_requests")
        .select("id,task_id,status,requested_new_due_date,reason_category,reason_notes,decided_at,decision_notes,created_at")
        .order("created_at", { ascending: false }),
      // Only confirmed/approved/legacy entries actually count toward Spent
      // Hrs (see rollupHoursFor) -- fetching just those keeps this list
      // small instead of pulling every running/pending/rejected row too.
      supabase.from("time_entries").select("*").in("status", ["confirmed", "approved"]),
      // Project Notes bubble/count (2026-08-14) -- just the project_id per
      // note, reduced client-side into a count map. The sidebar itself
      // fetches full note rows (body, timestamps, mentions) lazily only
      // when opened for a given project.
      supabase.from("project_notes").select("project_id"),
      // Deletion archive (2026-08-14c) -- see DeletedSpentHourRow above.
      supabase.from("deleted_project_spent_hours_archive").select("project_id,person_id,hours"),
      supabase.from("work_types").select("id,name,is_active,sort_order").order("sort_order"),
      supabase.from("project_sources").select("id,name,is_active,sort_order").order("sort_order"),
      supabase.from("project_categories").select("id,name,is_active,sort_order,icon,color").order("sort_order"),
      supabase.from("project_phases").select("id,name,is_active,sort_order").order("sort_order"),
      supabase.from("project_status_phase_mapping").select("status,phase_id"),
      // 2026-09-03 (Sandra: "can WBS Status also update to Awaiting
      // Baseline Approval if it's queued for approval") -- display-only:
      // no new wbs_status enum value, just a project_id set checked
      // wherever WBS_STATUS_META[p.wbs_status] renders, to swap the
      // Draft label/tone for a pending project. Pending is the only
      // status that still means "waiting" (decide_baseline_request
      // immediately flips it to approved/rejected).
      supabase.from("project_baseline_requests").select("project_id").eq("status", "pending"),
    ]);
    const nextProjects = (projectData as ProjectRow[]) ?? [];
    const nextTasks = (taskData as TaskRow[]) ?? [];
    setProjects(nextProjects);
    setTasks(nextTasks);
    setPeople((peopleData as PersonOption[]) ?? []);
    setChainPeople((chainPeopleData as { id: string; reports_to: string | null; is_active: boolean }[]) ?? []);
    setHolidayDates(new Set(((holidayData as { date: string }[]) ?? []).map((h) => h.date)));
    setExtensionRequests((extReqData as ExtensionRequestLite[]) ?? []);
    setTimeEntries((timeEntryData as TimeEntryRow[]) ?? []);
    setDeletedSpentHours((delSpentData as DeletedSpentHourRow[]) ?? []);
    setWorkTypes((workTypeData as WorkTypeOption[]) ?? []);
    setProjectSources((projectSourceData as ProjectSourceOption[]) ?? []);
    setProjectCategories((projectCategoryData as ProjectCategoryOption[]) ?? []);
    setProjectPhases((projectPhaseData as ProjectPhaseOption[]) ?? []);
    setPhaseStatusMapping((phaseMappingData as { status: string; phase_id: string }[]) ?? []);
    setPendingBaselineProjectIds(new Set(((pendingBaselineData as { project_id: string }[]) ?? []).map((r) => r.project_id)));
    const nextNoteCounts: Record<string, number> = {};
    for (const row of (noteData as { project_id: string }[]) ?? []) {
      nextNoteCounts[row.project_id] = (nextNoteCounts[row.project_id] ?? 0) + 1;
    }
    setNoteCounts(nextNoteCounts);
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
  // 2026-09-03 (Sandra: "add these 3 new fields in the WBS UI... in the
  // project list view these are view only and can't be changed [once
  // locked]. but as long as the WBS is still draft, still allow change
  // in both WBS UI and project list"). Category/Source/Complexity stay
  // editable here exactly like every other field while wbs_status is
  // still "draft" -- once Start Project has been requested/locked, this
  // list only shows them (WBS Planning's own new Category/Source/
  // Complexity fields become the only place left to change them, same
  // as Name/Owner already work). Status/Phase are untouched by this --
  // they keep using plain canEditProject everywhere.
  const canEditProjectSetupField = (p: ProjectRow) => canEditProject(p) && p.wbs_status === "draft";

  // Should we show the "Mark as Done?" suggestion chip for this project?
  // Deliberately a suggestion, not an auto-set of status -- see the
  // dismissal-helper comment above for why.
  function shouldSuggestDone(p: ProjectRow): boolean {
    if (p.status === "Completed" || p.status === "Cancelled") return false;
    if (dismissedDoneSuggestions.has(p.id)) return false;
    return actualProgress(p.id, tasks) === 100;
  }

  // Status/Phase are two separate properties but changing Status cascades
  // into Phase (see nextPhaseForStatus's own doc comment for the exact
  // rules) -- always go through this helper on a Status change rather than
  // writing { status } alone, so Phase never drifts out of sync with it.
  function changeProjectStatus(p: ProjectRow, newStatus: string | null) {
    updateProject(p.id, { status: newStatus, phase: newStatus ? nextPhaseForStatusLive(p.phase, newStatus) : p.phase });
  }

  function dismissDoneSuggestion(projectId: string) {
    setDismissedDoneSuggestions((prev) => {
      if (prev.has(projectId)) return prev;
      return new Set(prev).add(projectId);
    });
  }
  const canManageTasksIn = (projectId: string) => isFullAccess || isProjectOwner(projectId);
  // Closure is final (Sandra, repeatedly: "no re-opening"). Until Phase 26
  // (2026-08-28) WbsPlanning.tsx's own `canEditWbs = wbs_status !== "closed"`
  // was the ONLY thing anywhere enforcing that -- nothing on this page,
  // and no database trigger, looked at wbs_status at all, so a closed
  // project's tasks stayed fully editable from the Projects & Tasks list
  // (Status, Actual Completion, validation/reopen, the timer, extension
  // requests, deletion). Now gated here and, authoritatively, by
  // enforce_closed_project_lock / delete_tasks_and_dependents /
  // the phase-22 lock triggers in phase26_migration.sql.
  const isProjectClosed = (projectId: string) => projects.find((p) => p.id === projectId)?.wbs_status === "closed";
  const canEditTask = (t: TaskRow) => !isProjectClosed(t.project_id) && (canManageTasksIn(t.project_id) || t.assignee_id === me?.id);
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

  // Manager-chain fallback (2026-08-20, mirrors nearest_active_manager()
  // in phase10_migration.sql, best-effort client-side approximation only
  // -- validate_task_completion enforces this authoritatively server-
  // side). Walks reports_to from personId, skipping inactive accounts,
  // returns the first active manager found.
  function nearestActiveManagerClient(personId: string | null): string | null {
    if (!personId) return null;
    let current = chainPeople.find((p) => p.id === personId)?.reports_to ?? null;
    let depth = 0;
    while (current && depth < 20) {
      const mgr = chainPeople.find((p) => p.id === current);
      if (mgr?.is_active) return mgr.id;
      current = mgr?.reports_to ?? null;
      depth += 1;
    }
    return null;
  }

  // Validation authority (2026-08-20, Sandra: "project owner, also allow
  // immediate manager and skip level as fallback") -- broadened from
  // owner/Full-Access-only. The assignee's immediate manager can always
  // validate; someone further up only if the immediate manager's account
  // is inactive. Approximate here (see nearestActiveManagerClient above);
  // validate_task_completion is the real gate.
  function canValidateTask(t: TaskRow): boolean {
    if (isProjectClosed(t.project_id)) return false;
    if (canManageTasksIn(t.project_id)) return true;
    if (!t.assignee_id || !me?.id) return false;
    const immediateManager = chainPeople.find((p) => p.id === t.assignee_id)?.reports_to ?? null;
    if (immediateManager === me.id) return true;
    return nearestActiveManagerClient(t.assignee_id) === me.id;
  }

  // QA fix (2026-08-21): reopening a validated task was Full-Access-only
  // (Sandra, 2026-07-22) with a separate, never-wired "Approve Reopening"
  // flag sitting decorative in User Management -- toggling it for someone
  // did nothing, since neither the Reopen button nor reopen_task ever
  // checked it. Sandra's fix: "re-opening task will only be done by the
  // immediate manager with skip level option as fallback" -- replaces the
  // dead flag with the same real manager-chain authority
  // canValidateTask/validate_task_completion already uses, minus the
  // project-owner branch (deliberately narrower -- owner alone shouldn't
  // be able to reopen, only Full Access or the assignee's manager chain).
  // reopen_task (SQL) is the authoritative gate; this is the client-side
  // approximation for whether to even show the button.
  function canReopenTask(t: TaskRow): boolean {
    if (isProjectClosed(t.project_id)) return false;
    if (isFullAccess) return true;
    if (!t.assignee_id || !me?.id) return false;
    const immediateManager = chainPeople.find((p) => p.id === t.assignee_id)?.reports_to ?? null;
    if (immediateManager === me.id) return true;
    return nearestActiveManagerClient(t.assignee_id) === me.id;
  }

  // 2026-09-03 (Sandra): opened up project creation + visibility to
  // everyone -- Standard-access people were silently blocked from ever
  // seeing the "Add project" control (canCreateProject required Full
  // Access) and from seeing projects they weren't owner/assignee/
  // collaborator on (see can_see_project() in Supabase). Approval
  // authorities (editing, closing, reopening, extension decisions, etc.)
  // are untouched -- only *visibility* and *creation* are now open to all.
  const canCreateProject = true;
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

  // Estimated Hours rollup (Sandra, 2026-07-23: "I am now add[ing] est
  // hours in parent, shall this not be locked and just sum what will be
  // placed in the sub-tasks?") -- same write-back shape as the date
  // rollup just above: a parent task's own estimated_hours is kept in
  // sync with the sum of its direct sub-tasks' own estimated_hours, and
  // its cell becomes read-only so nobody free-types a number that'd just
  // get overwritten. Returns null (not 0) when none of the sub-tasks have
  // an estimate yet, same "nothing to show" convention as
  // projectEstimatedHoursTotal, so an all-blank set of sub-tasks reads as
  // "—" instead of a misleading "0".
  //
  // Deliberately NOT gated on isProjectLocked the way the date rollup is:
  // locking timelines freezes due dates specifically (the whole point of
  // Scoping->Locked), but Estimated Hours has no such governance -- an
  // estimate can still reasonably be refined mid-execution, so this stays
  // live regardless of lock state.
  function taskEstimatedHoursFromSubtasks(parentId: string): number | null {
    const withEstimate = tasks.filter(
      (t) => t.parent_task_id === parentId && !t.is_archived && t.estimated_hours !== null && t.estimated_hours !== undefined
    );
    if (withEstimate.length === 0) return null;
    return Math.round(withEstimate.reduce((sum, t) => sum + (t.estimated_hours ?? 0), 0) * 100) / 100;
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    tasks
      .filter((t) => t.parent_task_id === null && !t.is_archived)
      .forEach((parent) => {
        // No sub-tasks at all -- this root task behaves as a normal leaf,
        // its own estimated_hours stays exactly what was typed into it.
        const hasSubtasks = tasks.some((t) => t.parent_task_id === parent.id && !t.is_archived);
        if (!hasSubtasks) return;
        // Has sub-tasks: always mirror the sum, including clearing back
        // to null if none of them have an estimate yet -- otherwise a
        // stale number typed in before this field got locked would sit
        // there forever, unreachable and wrong, until the first sub-task
        // got its own estimate.
        const computed = taskEstimatedHoursFromSubtasks(parent.id);
        if (computed !== parent.estimated_hours) updateTask(parent.id, { estimated_hours: computed });
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
    // (a closed project keeps showing whatever extension history it
    // ended with -- only the "Request extension" action below is gated)
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

  // Phase 6 (2026-07-28): the old manual Lock/Unlock button, and the
  // captureProjectBaseline snapshot it used to take on first lock, were
  // removed here -- both retired in favor of the WBS Planning page's
  // lock_wbs_baseline RPC (Phase 2/3), which is now the only way a
  // project's baseline gets captured. See [[project_capaciq_phase6_retire_old_flow]].

  // Guardrail (Sandra, 2026-07-23): moving a project's Phase to Design
  // while its Timelines are still in Scoping (unlocked) prompts to lock
  // first (Phase 6: now redirects to WBS Planning's Lock Baseline instead
  // of a manual Lock button, which no longer exists -- see below).
  // Declining the prompt, or
  // getting blocked by the incomplete-task gate, blocks the Phase change
  // itself (her answer: "Block the Phase change"), leaving Phase
  // untouched. Already-locked projects skip the prompt entirely. Scoped to
  // the single-row Phase cell only, not the bulk-edit toolbar or Board
  // drag-to-Design -- bulk Status edits already can't cascade Phase
  // per-row (see changeProjectStatus's bulk-edit note elsewhere in this
  // file), and gating a multi-card Board drag felt like a separate,
  // riskier decision to make without her sign-off, so it's left alone for
  // now.
  // Phase 4 (2026-07-28): rewritten per Sandra's call on how Design-phase
  // moves interact with WBS Status now that it's the source of truth
  // ("redirect to WBS page"). This no longer auto-locks anything itself --
  // baseline locking needs a full dependency-aware task snapshot that only
  // the WBS Planning page can build (buildTaskSnapshotPayload), so silently
  // calling the old set_project_timelines_locked RPC here would leave
  // wbs_status stuck on Draft while timelines_locked flipped true, exactly
  // the mismatch this whole column swap was meant to avoid. A project
  // that's already past Draft (Baseline Locked/Revision in Progress/
  // Changed After Baseline/Closed) has a real baseline already, so the
  // move is allowed through untouched; a still-Draft project blocks the
  // Phase change (same "block it" policy as before) and offers to jump to
  // the WBS Planning page to Lock Baseline there instead.
  async function guardDesignPhaseLock(p: ProjectRow): Promise<boolean> {
    if (p.wbs_status !== "draft") return true;
    if (
      await confirm(
        `Moving "${p.name}" to Design first needs its WBS Baseline locked -- that's now done from the WBS Planning page (it needs the full task plan, not just a quick toggle here).\n\nGo to WBS Planning now to Start Project?`
      )
    ) {
      navigate(`/projects/${p.id}/wbs`);
    }
    return false;
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
    // Bugfix (2026-08-24, found in post-ship audit): this cascade to the
    // project's own tasks was fire-and-forget -- if it failed, the
    // project would show as restored/active while its tasks silently
    // stayed archived (missing from Table/Board/WBS with no visible
    // error). Now surfaces the failure instead of hiding it.
    const { error: taskError } = await supabase.from("tasks").update({ is_archived: false, archived_at: null }).eq("project_id", id);
    if (taskError) {
      await alert(`Project restored, but its tasks couldn't be restored: ${taskError.message}. Try restoring again, or check the tasks directly.`);
    }
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
    // Deletion archive (2026-08-14c): delete_project_and_dependents
    // (supabase/policies.sql "Migration 2026-08-14c") replaces the old
    // two-call sequence (deleteTasksAndDependents then a raw projects
    // delete) with a single RPC that archives this project's own
    // PM-overhead points/hours AND each of its tasks' Utilization/Spent
    // Hrs numbers before anything is actually removed -- same
    // authorization check as the projects_delete RLS policy, just
    // replicated server-side since a SECURITY DEFINER function bypasses RLS.
    const { error } = await supabase.rpc("delete_project_and_dependents", { p_project_id: p.id });
    if (error) {
      alert(`Couldn't delete: ${error.message}`);
      return;
    }
    loadArchived();
    loadAll();
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

  // Shared archive-projects logic, used by both the Table view's bulk
  // "Archive" bar button and the new single-card action menu on
  // Board/Calendar/Timeline (Quality audit follow-on, UX #5, 2026-08-21:
  // those three views had no delete/archive affordance at all -- only
  // Table view's toolbar did). Confirmation copy pluralizes correctly for
  // either a bulk selection or a single card.
  async function archiveProjects(ids: string[]) {
    if (ids.length === 0) return;
    const childTaskCount = tasks.filter((t) => ids.includes(t.project_id)).length;
    // Sandra, quality audit 2026-08-20 (UX #2): this button archives, it
    // doesn't permanently delete -- renamed from "Delete" to "Archive"
    // (and the confirm copy to match) so it isn't confused with Archived
    // Items' actually-irreversible "Delete permanently".
    const ok = await confirm({
      title: ids.length > 1 ? "Archive projects" : "Archive project",
      message:
        childTaskCount > 0
          ? `Archive ${ids.length} project${ids.length > 1 ? "s" : ""}? This will also archive ${childTaskCount} task${childTaskCount > 1 ? "s" : ""} in them. Everything can be restored within ${ARCHIVE_RETENTION_DAYS} days unless permanently deleted.`
          : `Archive ${ids.length > 1 ? `${ids.length} projects` : "this project"}? ${ids.length > 1 ? "They" : "It"} can be restored within ${ARCHIVE_RETENTION_DAYS} days unless permanently deleted.`,
      confirmLabel: "Archive",
    });
    if (!ok) return;
    const now = new Date().toISOString();
    const { error } = await supabase.from("projects").update({ is_archived: true, archived_at: now }).in("id", ids);
    if (error) {
      alert(`Couldn't archive: ${error.message}`);
      return;
    }
    // Bugfix (2026-08-24, found in post-ship audit): same cascade gap as
    // restoreProject above -- a failure here used to leave tasks quietly
    // active under a project that now shows archived.
    const { error: taskError } = await supabase.from("tasks").update({ is_archived: true, archived_at: now }).in("project_id", ids);
    if (taskError) {
      await alert(`Project${ids.length > 1 ? "s" : ""} archived, but the tasks in ${ids.length > 1 ? "them" : "it"} couldn't be archived: ${taskError.message}. Try again, or check the tasks directly.`);
    }
    setSelectedProjectIds((prev) => prev.filter((id) => !ids.includes(id)));
    loadAll();
  }

  async function bulkDeleteProjects() {
    await archiveProjects(selectedProjectIds);
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
    // Quality audit follow-on (2026-08-20 review, Data Integrity #3):
    // this used to be one-task-at-a-time and didn't bundle sub-tasks,
    // unlike bulkDeleteTasks below which correctly does. Not a
    // corruption risk (a sub-task whose parent no longer exists just
    // fails to load cleanly) but a confusing dead end -- someone
    // deleting a parent from Archived Items would find its sub-tasks
    // stuck there with no parent to restore alongside. A sub-task only
    // ever ends up archived here as a side effect of its whole project
    // being archived (tasks have no standalone archive action), so any
    // live sub-tasks of `t` are already sitting in this same
    // archivedTasks list -- just find them by parent_task_id.
    const childIds = archivedTasks.filter((c) => c.parent_task_id === t.id).map((c) => c.id);
    const allIds = Array.from(new Set([t.id, ...childIds]));
    const ok = await confirm({
      title: "Delete permanently",
      message: `Permanently delete "${t.name}"${childIds.length ? ` (and ${childIds.length} sub-task${childIds.length > 1 ? "s" : ""})` : ""}? This can't be undone.`,
      confirmLabel: "Delete permanently",
      danger: true,
    });
    if (!ok) return;
    const { error } = await deleteTasksAndDependents(allIds);
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
    // Bump this whenever PROJECT_COLUMN_ORDER above is deliberately
    // re-ordered (see columnOrderVersion in tableTypes.ts) so everyone's
    // already-saved "default" view picks up the new order on next load.
    // 1 = 2026-09-02 re-prioritization (Owner/Category/Source moved up
    // next to identity; Status/Health/Phase/Priority as the live-triage
    // cluster; hours/variance and Days Extended pushed toward the end;
    // Complexity last).
    columnOrderVersion: 1,
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
      out = out.filter((p) => statuses.includes(p.status ?? ""));
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
          const tone = (p.category && categoryToneMap[p.category]) || "neutral";
          // Round 21 (Sandra): the Project name/Owner should no longer be
          // editable from this list at all -- both now live exclusively in
          // the WBS page's own header (already editable there, see
          // WbsPlanning.tsx). This cell is now a plain link into that page
          // instead of an inline-editable text field, so "renaming a
          // project" and "opening its WBS" are the same action rather than
          // two separate, easy-to-confuse affordances.
          return (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className={`project-icon-badge ${tone}`}><CategoryIcon iconName={p.category ? categoryIconMap[p.category] : undefined} tone={tone} /></span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  navigate(`/projects/${p.id}/wbs`);
                }}
                title="Open this project's WBS page (name and owner are edited there)"
                style={{
                  flex: 1,
                  minWidth: 0,
                  textAlign: "left",
                  background: "none",
                  border: "none",
                  padding: 0,
                  font: "inherit",
                  fontWeight: 600,
                  color: "var(--accent)",
                  cursor: "pointer",
                  textOverflow: "ellipsis",
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                }}
              >
                {p.name || "Untitled project"}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setNotesSidebarProjectId(p.id);
                }}
                title={
                  noteCounts[p.id]
                    ? `${noteCounts[p.id]} note${noteCounts[p.id] === 1 ? "" : "s"} on this project`
                    : "Add a note to this project"
                }
                className={`note-bubble-btn${noteCounts[p.id] ? " has-notes" : ""}`}
              >
                <MessageCircle size={13} />
                {!!noteCounts[p.id] && <span className="note-bubble-count">{noteCounts[p.id]}</span>}
              </button>
            </div>
          );
        },
      },
      {
        key: "owner",
        label: "Owner",
        defaultWidth: 150,
        maxWidth: 220,
        // Round 21 (Sandra): Owner is now also only editable from the WBS
        // page's own header -- always read-only here, regardless of
        // canEditProject, matching the Project name cell above.
        render: (p) => <span>{ownerName(p.owner_id)}</span>,
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
            labelFor={priorityLabel}
            renderReadOnly={() => (p.priority ? <span className={`status-pill ${priorityTone(p.priority)}`}>{priorityLabel(p.priority)}</span> : "—")}
            onCommit={(v) => updateProject(p.id, { priority: v as ProjectRow["priority"] })}
          />
        ),
      },
      {
        key: "status",
        label: "Status",
        defaultWidth: 140,
        maxWidth: 200,
        render: (p) => (
          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
            <InlineSelect
              value={p.status ?? ""}
              editable={canEditProject(p)}
              allowEmpty
              options={PROJECT_STATUS_OPTIONS}
              renderReadOnly={() =>
                p.status ? <span className={`status-pill ${PROJECT_STATUS_TONES[p.status ?? ""] ?? "neutral"}`}>{p.status}</span> : "—"
              }
              onCommit={(v) => changeProjectStatus(p, v || null)}
            />
            {shouldSuggestDone(p) && canEditProject(p) && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    changeProjectStatus(p, "Completed");
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
        // New 2026-07-23: Phase used to be baked into the same field as
        // Status (11 combined values) -- now its own property, cascading
        // off Status (see PROJECT_PHASE_OPTIONS_BY_STATUS). Paused/
        // Cancelled projects get the full pipeline list here since their
        // Phase is frozen wherever it was, not tied to their Status.
        key: "phase",
        label: "Phase",
        defaultWidth: 130,
        maxWidth: 180,
        render: (p) => (
          <InlineSelect
            value={p.phase ?? ""}
            editable={canEditProject(p)}
            allowEmpty
            options={phaseOptionsForStatus(p.status, p.phase)}
            renderReadOnly={() => (p.phase ? <span className={`status-pill ${PROJECT_PHASE_TONES[p.phase ?? ""] ?? "neutral"}`}>{p.phase}</span> : "—")}
            onCommit={async (v) => {
              if (v === "Design" && p.phase !== "Design" && !(await guardDesignPhaseLock(p))) return;
              updateProject(p.id, { phase: v || null });
            }}
          />
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
        label: "Scoped Hours",
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
          const total = projectSpentHoursTotal(p.id, tasks, timeEntries, deletedSpentHours);
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
          const spent = projectSpentHoursTotal(p.id, tasks, timeEntries, deletedSpentHours);
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
          const spent = projectSpentHoursTotal(p.id, tasks, timeEntries, deletedSpentHours);
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
            editable={canEditProjectSetupField(p)}
            allowEmpty
            options={projectCategoryOptions}
            renderReadOnly={() =>
              p.category ? (
                <span className={`status-pill ${(p.category && categoryToneMap[p.category]) ?? "neutral"}`} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <CategoryIcon iconName={p.category ? categoryIconMap[p.category] : undefined} tone={(p.category && categoryToneMap[p.category]) ?? "neutral"} size={12} />
                  {p.category}
                </span>
              ) : "—"
            }
            onCommit={(v) => updateProject(p.id, { category: v || null })}
          />
        ),
      },
      {
        // Phase 20 (2026-08-24): Source -- admin-configurable via Site
        // Settings (projectSources), mirrors Category's own InlineSelect
        // shape but keyed by source_id (a real FK) rather than a plain
        // text value, since Source's option list is DB-backed and can
        // change over time.
        key: "source",
        label: "Source",
        defaultWidth: 160,
        maxWidth: 220,
        render: (p) => {
          const activeSourceOptions = projectSources.filter((s) => s.is_active || s.id === p.source_id).map((s) => s.name);
          const currentName = projectSources.find((s) => s.id === p.source_id)?.name ?? "";
          return (
            <InlineSelect
              value={currentName}
              editable={canEditProjectSetupField(p)}
              allowEmpty
              options={activeSourceOptions}
              renderReadOnly={() => (currentName ? <span className="status-pill neutral">{currentName}</span> : "—")}
              onCommit={(v) => {
                const match = projectSources.find((s) => s.name === v);
                updateProject(p.id, { source_id: match?.id ?? null });
              }}
            />
          );
        },
      },
      {
        key: "effort_level",
        label: "Complexity",
        defaultWidth: 100,
        maxWidth: 130,
        render: (p) => (
          <InlineSelect
            value={p.effort_level ?? ""}
            editable={canEditProjectSetupField(p)}
            allowEmpty
            options={PROJECT_EFFORT_LEVEL_OPTIONS}
            renderReadOnly={() =>
              p.effort_level ? <span className={`status-pill ${PROJECT_EFFORT_LEVEL_TONES[p.effort_level] ?? "neutral"}`}>{effortLevelLabel(p.effort_level)}</span> : "—"
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
        // Governance lockdown (Sandra, 2026-07-29): Start/Due are structural
        // planning fields now owned exclusively by the WBS page (its own
        // Start-date field, plus dates computed/written from the task plan)
        // -- same rationale as Name/Owner going WBS-only in Round 21. This
        // page is read-only for both dates regardless of canEditProject.
        render: (p) => {
          const computed = projectDatesFromTasks(p.id);
          return (
            <span title={computed ? "Computed from this project's own tasks (earliest task start)" : "Set in this project's WBS page"}>
              <InlineDate value={p.start_date} editable={false} onCommit={() => {}} />
            </span>
          );
        },
      },
      {
        key: "end_date",
        label: "Due",
        defaultWidth: 110,
        maxWidth: 140,
        // Governance lockdown (Sandra, 2026-07-29): see start_date above --
        // Due is also WBS-only now, not editable from this page.
        render: (p) => {
          const computed = projectDatesFromTasks(p.id);
          return (
            <span title={computed ? "Computed from this project's own tasks (latest task due date)" : "Set in this project's WBS page"}>
              <InlineDate value={p.end_date} editable={false} onCommit={() => {}} />
            </span>
          );
        },
      },
      {
        // Phase 4 (2026-07-28): the old "Timelines" column (Locked/Scoping
        // pill + inline Lock/Unlock button) is replaced outright by the
        // WBS Status badge -- Sandra's explicit call ("we can replace the
        // timeline property now with the WBS status"). Baseline locking
        // itself now only ever happens through the WBS Planning page's
        // Lock Baseline action (it needs a full dependency-aware task
        // snapshot -- see buildTaskSnapshotPayload -- that this table
        // can't build), so there's no inline lock/unlock control here any
        // more; this column is a status readout plus links into the page
        // where the actual actions live. timelines_locked itself keeps
        // working unchanged under the hood (Extension Requests, the
        // Design-phase guardrail's date checks, and inline date editing
        // all still read it directly), since the Phase 2 RPCs already
        // keep it in sync with wbs_status one-for-one.
        key: "wbs_status",
        label: "WBS Status",
        defaultWidth: 210,
        maxWidth: 260,
        render: (p) => {
          const meta = wbsStatusMetaFor(p.wbs_status, pendingBaselineProjectIds.has(p.id));
          return (
            <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span
                title={meta?.hint}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "2px 8px",
                  fontSize: 11,
                  fontWeight: 500,
                  borderRadius: "var(--radius-btn)",
                  border: `1px solid ${meta?.border ?? "var(--border)"}`,
                  background: meta?.bg ?? "var(--surface)",
                  color: meta?.color ?? "var(--text-secondary)",
                }}
              >
                {meta?.label ?? p.wbs_status}
              </span>
              {/* Sandra, 2026-07-29: removed the separate "WBS" button --
                  the Project name cell (Round 21) already navigates to
                  /projects/:id/wbs, so this was a duplicate affordance. */}
              {/* Sandra, 2026-07-29: Report link now gated to Closed only
                  (was "any non-draft status") -- the redesigned WBS page
                  itself now surfaces baseline/revision/variance info
                  in-place, so this report is reserved for the final,
                  closed-project performance summary. */}
              {p.wbs_status === "closed" && (
                <button
                  onClick={() => navigate(`/projects/${p.id}/baseline`)}
                  title="View this project's Baseline vs Final performance report"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "2px 8px",
                    fontSize: 11,
                    fontWeight: 500,
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--border)",
                    background: "var(--surface)",
                    color: "var(--accent, #2563eb)",
                    cursor: "pointer",
                  }}
                >
                  Report
                </button>
              )}
            </div>
          );
        },
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
    [people, projects, me, tasks, holidayDates, projectViews.activeView.progressDisplay, noteCounts, timeEntries, deletedSpentHours, projectCategoryOptions, categoryIconMap, categoryToneMap, projectPhases, phaseStatusMapping, activePhaseNames]
  );

  // Board-view card body. Name always renders first/bold as the card's
  // own title (its Properties popover row is drag-disabled for Board
  // views -- see nonReorderableKeys passed to ViewSettingsMenu below --
  // so it can't silently drift out of that spot). Every other visible
  // property renders below it as a plain label/value row, in the exact
  // order the Properties popover's own drag handles set (visibleOrderedColumns
  // reads the same columnOrder Table's header drag writes to), with the
  // "Show property labels on cards" toggle controlling whether the label
  // half of each row renders at all.
  //
  // Previously this only ever rendered a hardcoded shortlist (bold name,
  // owner, priority, due date, progress bar) with no labels at all,
  // regardless of what Properties said was shown or what order it was
  // dragged into -- toggling on anything else (Status, Phase, Health,
  // Est. hrs, etc.) had zero effect, and the shortlist's own labels never
  // matched the rest (Sandra, 2026-07-29: "all are tagged as shown but
  // only a few property actually shows" / "property names are shown for
  // the others, so make it consistent for the rest").
  function renderProjectCard(p: ProjectRow) {
    const hidden = projectViews.activeView.hiddenColumns;
    const showLabels = projectViews.activeView.boardShowPropertyLabels ?? true;
    const find = (key: string) => projectColumns.find((c) => c.key === key);
    const groupByKey = resolveBoardGroupBy(projectViews.activeView.groupBy, PROJECT_BOARD_GROUPABLE_KEYS, "phase");
    const propertyColumns = visibleOrderedColumns(projectColumns, projectViews.activeView).filter(
      (c) => c.key !== "name" && c.key !== groupByKey
    );
    return (
      <>
        <div className="board-card-name-row">
          {!hidden.includes("name") && <div className="board-card-name-row-title">{find("name")?.render(p)}</div>}
          {/* Quality audit follow-on (2026-08-21, UX #5): Board had no
              delete/archive affordance at all -- only Table view's
              toolbar did. Projects only (not Tasks) -- Tasks' bulk
              delete was deliberately removed from Table view itself by
              the 2026-07-29 governance lockdown, so adding it back here
              would contradict that decision. */}
          <CardActionMenu
            items={[
              {
                icon: <Archive size={13} />,
                label: "Archive",
                tone: "danger",
                onClick: () => archiveProjects([p.id]),
              },
            ]}
          />
        </div>
        {propertyColumns.map((c) => (
          <div key={c.key} className="board-card-property">
            {showLabels && (
              <span className="board-card-property-label">{c.plainLabel ?? (typeof c.label === "string" ? c.label : c.key)}</span>
            )}
            <span className="board-card-property-value">{c.render(p)}</span>
          </div>
        ))}
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
      key: "status",
      label: "Status",
      getGroup: (p) => p.status ?? "No status",
      getTone: (p) => PROJECT_STATUS_TONES[p.status ?? ""] ?? "neutral",
      // Phase 23 follow-up (2026-08-25, Sandra: "that's ok to fix too to
      // avoid confusion"): same treatment as taskGroupOptions above --
      // every groupable field gets its own canonical section order
      // instead of incidental row-encounter order. Deliberately-ordered
      // scales (Status/Priority/Complexity/Phase/WBS Status) keep their
      // workflow/severity order rather than being alphabetized.
      allGroups: () => [...PROJECT_STATUS_OPTIONS, "No status"],
    },
    {
      key: "phase",
      label: "Phase",
      getGroup: (p) => p.phase ?? "No phase",
      getTone: (p) => PROJECT_PHASE_TONES[p.phase ?? ""] ?? "neutral",
      allGroups: () => [...activePhaseNames, "No phase"],
    },
    {
      key: "priority",
      label: "Priority",
      getGroup: (p) => p.priority ?? "No priority",
      getTone: (p) => priorityTone(p.priority),
      allGroups: () => [...PROJECT_PRIORITY_OPTIONS, "No priority"],
    },
    {
      key: "owner",
      label: "Owner",
      getGroup: (p) => ownerName(p.owner_id),
      allGroups: () => [...people.map((person) => person.name), "—"],
    },
    {
      key: "category",
      label: "Category",
      getGroup: (p) => p.category ?? "Uncategorized",
      getTone: (p) => categoryToneMap[p.category ?? ""] ?? "neutral",
      // projectCategoryOptions is already sort_order-ordered from Site Settings.
      allGroups: () => [...projectCategoryOptions, "Uncategorized"],
    },
    {
      key: "source",
      label: "Source",
      getGroup: (p) => projectSources.find((s) => s.id === p.source_id)?.name ?? "Not set",
      getTone: () => "neutral",
      allGroups: () => [...projectSources.filter((s) => s.is_active).map((s) => s.name), "Not set"],
    },
    {
      key: "effort_level",
      label: "Complexity",
      getGroup: (p) => p.effort_level ?? "No complexity set",
      getTone: (p) => PROJECT_EFFORT_LEVEL_TONES[p.effort_level ?? ""] ?? "neutral",
      allGroups: () => [...PROJECT_EFFORT_LEVEL_OPTIONS, "No complexity set"],
    },
    {
      key: "health",
      label: "Health",
      getGroup: (p) => healthOf(p, tasks, holidayDates).label,
      getTone: (p) => healthOf(p, tasks, holidayDates).tone,
      // No allGroups here -- healthOf() returns many dynamic, open-ended
      // labels (not a small fixed enum like the fields above), so there's
      // no safe canonical list to enumerate without risking a missing
      // bucket. Left on the previous row-encounter-order behavior.
    },
    {
      key: "wbs_status",
      label: "WBS Status",
      // 2026-09-03: same Awaiting-Baseline-Approval display override as
      // the WBS Status cell -- a pending-request Draft project gets its
      // own section here instead of blending into the plain "Draft"
      // group. Not pre-seeded in allGroups (so it only appears when a
      // project actually has one pending), same as any other
      // encountered-but-not-canonical value elsewhere in this file.
      getGroup: (p) => wbsStatusMetaFor(p.wbs_status, pendingBaselineProjectIds.has(p.id)).label,
      getTone: (p) => (p.wbs_status === "draft" && pendingBaselineProjectIds.has(p.id) ? "warning" : WBS_STATUS_TONES[p.wbs_status] ?? "neutral"),
      allGroups: () => (Object.keys(WBS_STATUS_META) as WbsStatus[]).map((s) => WBS_STATUS_META[s].label),
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
      key: "status",
      label: "Status",
      getGroup: (p) => p.status ?? "No status",
      getTone: (p) => PROJECT_STATUS_TONES[p.status ?? ""] ?? "neutral",
      boardGroupable: true,
    },
    {
      key: "phase",
      label: "Phase",
      getGroup: (p) => p.phase ?? "No phase",
      getTone: (p) => PROJECT_PHASE_TONES[p.phase ?? ""] ?? "neutral",
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
      getTone: (p) => categoryToneMap[p.category ?? ""] ?? "neutral",
      boardGroupable: true,
    },
    {
      key: "source",
      label: "Source",
      getGroup: (p) => projectSources.find((s) => s.id === p.source_id)?.name ?? "Not set",
      getTone: () => "neutral",
      boardGroupable: true,
    },
    {
      key: "effort_level",
      label: "Complexity",
      getGroup: (p) => p.effort_level ?? "No complexity set",
      getTone: (p) => PROJECT_EFFORT_LEVEL_TONES[p.effort_level ?? ""] ?? "neutral",
      boardGroupable: true,
    },
    { key: "start_date", label: "Start", getGroup: () => "", boardGroupable: false },
    { key: "end_date", label: "Due", getGroup: () => "", boardGroupable: false },
    {
      key: "wbs_status",
      label: "WBS Status",
      getGroup: (p) => WBS_STATUS_META[p.wbs_status]?.label ?? p.wbs_status,
      getTone: (p) => WBS_STATUS_TONES[p.wbs_status] ?? "neutral",
      boardGroupable: true,
    },
  ];

  // Computes Board's actual columns/getValue/drag-write-handler for
  // whichever field is currently grouped by. Status/Phase each have their
  // own column set (PROJECT_BOARD_STATUS_COLUMNS / PROJECT_BOARD_PHASE_
  // COLUMNS); Priority/Category/Effort reuse their own enum option lists;
  // Owner is built from the live people list (value = person id, so
  // drag-drop writes back an unambiguous id rather than a display name).
  const WBS_STATUS_BOARD_COLUMNS: BoardColumnDef[] = (Object.keys(WBS_STATUS_META) as WbsStatus[]).map((status) => ({
    value: status,
    label: WBS_STATUS_META[status].label,
    tone: WBS_STATUS_TONES[status] ?? "neutral",
    hint: WBS_STATUS_META[status].hint,
  }));

  function getProjectBoardColumns(groupBy: string): BoardColumnDef[] {
    if (groupBy === "priority") return PROJECT_PRIORITY_OPTIONS.map((v) => ({ value: v, label: priorityLabel(v), tone: priorityTone(v) }));
    if (groupBy === "category") return projectCategoryOptions.map((v) => ({ value: v, label: v, tone: categoryToneMap[v] ?? "neutral" }));
    if (groupBy === "source")
      return projectSources.filter((s) => s.is_active).map((s) => ({ value: s.id, label: s.name, tone: "neutral" }));
    if (groupBy === "effort_level")
      return PROJECT_EFFORT_LEVEL_OPTIONS.map((v) => ({ value: v, label: v, tone: PROJECT_EFFORT_LEVEL_TONES[v] ?? "neutral" }));
    if (groupBy === "owner") return people.map((person) => ({ value: person.id, label: person.name, tone: "neutral" }));
    if (groupBy === "wbs_status") return WBS_STATUS_BOARD_COLUMNS;
    if (groupBy === "status") return PROJECT_BOARD_STATUS_COLUMNS;
    // default board grouping is Phase -- the real pipeline view. Built
    // live (not a static array) since Phase is now Sandra-editable --
    // clusters each active phase under whichever Status column(s) its
    // mapping puts it in ("Done" always clusters under Completed).
    const notStartedNames = new Set(phaseOptionsForStatus("Not Started"));
    const inProgressNames = new Set(phaseOptionsForStatus("In Progress"));
    return projectPhases
      .filter((ph) => ph.is_active)
      .map((ph) => ({
        value: ph.name,
        label: ph.name,
        clusterLabel: ph.name === "Done" ? "Completed" : notStartedNames.has(ph.name) ? "Not Started" : inProgressNames.has(ph.name) ? "In Progress" : "In Progress",
        tone: PROJECT_PHASE_TONES[ph.name] ?? "neutral",
      }));
  }

  function getProjectBoardValue(p: ProjectRow, groupBy: string): string | null {
    if (groupBy === "priority") return p.priority;
    if (groupBy === "category") return p.category;
    if (groupBy === "source") return p.source_id;
    if (groupBy === "effort_level") return p.effort_level;
    if (groupBy === "owner") return p.owner_id;
    if (groupBy === "wbs_status") return p.wbs_status;
    if (groupBy === "status") return p.status;
    return p.phase;
  }

  function getProjectBoardMoveHandler(groupBy: string): ((p: ProjectRow, newValue: string) => void) | undefined {
    if (groupBy === "priority") return (p, v) => updateProject(p.id, { priority: (v || null) as ProjectRow["priority"] });
    // 2026-09-03: Category/Source/Complexity are WBS-only once a project
    // leaves Draft (see canEditProjectSetupField above) -- same rule
    // applies to dragging a card between Board swimlanes grouped by one
    // of these, not just the Table view's inline cells.
    if (groupBy === "category")
      return (p, v) => {
        if (p.wbs_status !== "draft") {
          alert(`"${p.name}" has already started -- change its Category from the WBS page instead.`);
          return;
        }
        updateProject(p.id, { category: v || null });
      };
    if (groupBy === "source")
      return (p, v) => {
        if (p.wbs_status !== "draft") {
          alert(`"${p.name}" has already started -- change its Source from the WBS page instead.`);
          return;
        }
        updateProject(p.id, { source_id: v || null });
      };
    if (groupBy === "effort_level")
      return (p, v) => {
        if (p.wbs_status !== "draft") {
          alert(`"${p.name}" has already started -- change its Complexity from the WBS page instead.`);
          return;
        }
        updateProject(p.id, { effort_level: v || null });
      };
    // Owner is WBS-only (Round 21) -- dragging a card grouped by Owner used
    // to silently reassign it here too, bypassing that lockdown. No
    // drag-drop handler for this grouping any more (2026-07-29).
    if (groupBy === "owner") return undefined;
    if (groupBy === "wbs_status") return undefined; // baseline/revision transitions run through the WBS Planning page's RPCs (task snapshot required) -- not a plain field write, so no drag-drop here
    // Dragging a card between Status columns goes through changeProjectStatus
    // so Phase cascades correctly (see its own doc comment); dragging
    // between Phase columns writes phase directly and never touches Status.
    if (groupBy === "status") return (p, v) => changeProjectStatus(p, v || null);
    return (p, v) => updateProject(p.id, { phase: v || null });
  }

  const projectSortOptions: SortOption<ProjectRow>[] = [
    { key: "name", label: "Project", getValue: (p) => p.name ?? "" },
    { key: "owner", label: "Owner", getValue: (p) => ownerName(p.owner_id) },
    { key: "priority", label: "Priority", getValue: (p) => PROJECT_PRIORITY_OPTIONS.indexOf(p.priority ?? "") },
    { key: "status", label: "Status", getValue: (p) => PROJECT_STATUS_OPTIONS.indexOf(p.status ?? "") },
    { key: "phase", label: "Phase", getValue: (p) => activePhaseNames.indexOf(p.phase ?? "") },
    { key: "category", label: "Category", getValue: (p) => p.category ?? "" },
    { key: "source", label: "Source", getValue: (p) => projectSources.find((s) => s.id === p.source_id)?.name ?? "" },
    { key: "effort_level", label: "Complexity", getValue: (p) => PROJECT_EFFORT_LEVEL_OPTIONS.indexOf(p.effort_level ?? "") },
    { key: "start_date", label: "Start", getValue: (p) => (p.start_date ? new Date(p.start_date).getTime() : null) },
    { key: "end_date", label: "Due", getValue: (p) => (p.end_date ? new Date(p.end_date).getTime() : null) },
    { key: "health", label: "Health", getValue: (p) => healthRank(healthOf(p, tasks, holidayDates).label) },
    { key: "actual_progress", label: "Actual Progress", getValue: (p) => actualProgress(p.id, tasks) ?? -1 },
    { key: "estimated_hours", label: "Scoped Hours", getValue: (p) => projectEstimatedHoursTotal(p.id, tasks) ?? -1 },
    { key: "time_spent_hours", label: "Spent hrs", getValue: (p) => projectSpentHoursTotal(p.id, tasks, timeEntries, deletedSpentHours) },
    {
      key: "hours_variance",
      label: "Hrs Variance",
      getValue: (p) => projectHoursVarianceOf(projectEstimatedHoursTotal(p.id, tasks), projectSpentHoursTotal(p.id, tasks, timeEntries, deletedSpentHours))?.hours ?? -Infinity,
    },
    {
      key: "hours_variance_pct",
      label: "Hrs Variance %",
      getValue: (p) => projectHoursVarianceOf(projectEstimatedHoursTotal(p.id, tasks), projectSpentHoursTotal(p.id, tasks, timeEntries, deletedSpentHours))?.percent ?? -1,
    },
    { key: "wbs_status", label: "WBS Status", getValue: (p) => (Object.keys(WBS_STATUS_META) as WbsStatus[]).indexOf(p.wbs_status) },
  ];

  // Round 21 (Sandra): "New project" now goes straight into the WBS page
  // instead of dropping a blank "Untitled" row into this list for inline
  // editing -- Project name and Owner are only ever set from the WBS
  // header now, so there's nothing left to edit inline here anyway.
  async function createBlankProject() {
    // Creator becomes owner immediately so they can keep editing/managing
    // the project afterward (projects_update/canEditProject both key off
    // owner_id) -- previously only Full Access ever created projects, and
    // owner_id was left to be set later from the WBS header.
    const { data, error } = await supabase.from("projects").insert({ name: "Untitled", sort_order: Date.now(), owner_id: me?.id ?? null }).select("id").single();
    if (error || !data) {
      alert(`Couldn't create project: ${error?.message ?? "unknown error"}`);
      return;
    }
    navigate(`/projects/${data.id}/wbs`);
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
    // Phase 26: closure is final -- also enforced by
    // enforce_closed_project_lock, this is just the friendlier message.
    if (isProjectClosed(parent.project_id)) {
      await alert("This project is closed -- its scope is final, so no more tasks can be added to it.");
      return;
    }
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
                {/* Sandra, 2026-07-29: the main Projects & Tasks page is now
                    read-only for structural fields -- Name, Project,
                    Assignee, Effort, Start, Due, Est. hrs can only be
                    changed from WBS Planning. This page's own task list
                    only allows Status, Time Tracking, Due Date
                    Ext.(request), and Validated. The old inline "add
                    sub-task" plus button is removed for the same reason
                    -- structural additions belong in WBS Planning. */}
                <InlineText value={t.name} editable={false} bold={t._depth === 0} onCommit={(v) => updateTask(t.id, { name: v })} />
              </div>
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
            editable={false}
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
            editable={false}
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
            // Sandra, 2026-08-24: status changes, time logging, and
            // extension requests are all locked until the project's
            // baseline is locked (isProjectLocked reads timelines_locked,
            // which flips true in lockstep with wbs_status leaving
            // "draft" -- see [[project_capaciq...baseline_lock_gating]]).
            // Planning freely pre-baseline shouldn't look like real
            // progress tracking.
            editable={canEditTask(t) && !isTaskLocked(t) && isProjectLocked(t.project_id)}
            allowEmpty
            // Flat list, not TASK_STATUS_GROUPED -- the grouped <optgroup>
            // headers ("To-do"/"In Progress"/"Complete") each wrapped
            // exactly one identical-named option, so the dropdown showed
            // redundant parent labels. Sandra: just the 3 plain options.
            options={TASK_STATUS_OPTIONS}
            renderReadOnly={() =>
              t.status ? <span className={`status-pill ${statusTone(statusGroupOf(TASK_STATUS_GROUPED, t.status))}`}>{t.status}</span> : "—"
            }
            onCommit={async (v) => {
              // Flipping to Done stamps the assignee's own self-reported
              // completion moment -- separate from validated_completion_date,
              // which is the project owner/manager's independent check (see
              // the Validated column below). Moving *off* Done clears the
              // stamp so a task that's reopened doesn't keep a stale
              // "submitted" record.
              if (v === "Done") {
                // Sandra, 2026-08-26: don't allow tagging a task Done
                // without any logged time behind it -- gated on the same
                // Confirmed/Approved hours that already feed Spent Hrs
                // (ownHoursFor, not the parent rollup -- this is about
                // THIS task's own work, not its sub-tasks').
                if (ownHoursFor(timeEntries, t.id) <= 0) {
                  await alert("This task can't be marked Done yet -- it has no logged hours (Confirmed or Approved) on it. Log time first, then mark it Done.");
                  return;
                }
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
          // Phase 12 (2026-08-20): Effort is now fully computed from
          // Scoped Hours (see supabase/phase12_migration.sql's
          // derive_effort_level trigger) -- this cell has been read-only
          // everywhere on this page since the 2026-07-29 Tasks-page
          // governance lockdown anyway, so no editable={} change is
          // needed here, just the value now always reflects the derived
          // level rather than something a user picked. A "Very Heavy"
          // result gets a small non-blocking hint icon suggesting the
          // task be broken up -- purely informational, never blocks
          // saving.
          return (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <InlineSelect
                value={t.effort ?? ""}
                editable={false}
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
              {t.effort === "Very Heavy" && (
                <span title="Very Heavy (over 24 planned effort hours) -- consider breaking this task into smaller sub-tasks in WBS Planning." style={{ display: "inline-flex" }}>
                  <AlertTriangle size={12} color="var(--warning-text)" />
                </span>
              )}
            </span>
          );
        },
      },
      {
        key: "work_type",
        label: "Work Type",
        defaultWidth: 150,
        render: (t) => {
          const wt = workTypes.find((w) => w.id === t.work_type_id);
          return wt ? <span className="status-pill neutral">{wt.name}</span> : <span style={{ color: "var(--muted)" }}>—</span>;
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
                editable={false}
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
        minWidth: 120,
        render: (t) => {
          // Due dates aren't directly editable once a task exists (the DB
          // trigger enforces read-only post-lock, and pre-lock there's
          // nothing to extend yet) -- the whole cell is a single click
          // target that opens the extension-history modal, same as the
          // dedicated "Extension" column right after it (2026-08-25: split
          // back into its own column per Sandra -- this cell used to also
          // carry the extension status pill inline, see
          // [[project_capaciq_icons_gating_validation_split]] for that
          // merge and [[project_capaciq_extension_requests]] for the modal).
          const isParent = t._depth === 0 && hasChildren(t.id);
          const computed = isParent ? taskDatesFromSubtasks(t.id) : null;
          return (
            <button
              onClick={() => setExtDetailTask(t)}
              title={computed ? "Computed from this task's own sub-tasks (latest sub-task due date) -- click to see extension request details" : "Click to see extension request details or request one"}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: "none",
                border: "none",
                cursor: "pointer",
                font: "inherit",
                padding: 0,
                color: "inherit",
              }}
            >
              <InlineDate value={t.current_due_date} editable={false} onCommit={() => {}} />
            </button>
          );
        },
      },
      {
        key: "due_date_ext",
        label: "Extension",
        defaultWidth: 130,
        minWidth: 110,
        render: (t) => {
          const status = dueDateExtStatus(t);
          return (
            <button
              onClick={() => setExtDetailTask(t)}
              title="Click to see extension request details or request one"
              style={{ background: "none", border: "none", cursor: "pointer", font: "inherit", padding: 0 }}
            >
              <span className={`status-pill ${status.tone}`}>{status.label}</span>
            </button>
          );
        },
      },
      {
        key: "validated_completion_date",
        label: "Validated Date",
        defaultWidth: 160,
        minWidth: 140,
        // Independent completion check, distinct from the assignee's own
        // submitted_on/actual_completion_date (see the Actual Completion
        // column below) -- broadened 2026-08-20 (Sandra: "project owner,
        // also allow immediate manager and skip level as fallback") from
        // owner/Full-Access-only, see canValidateTask above. Both actions
        // now go through validate_task_completion/reopen_task (real RPCs,
        // enforced server-side -- see phase10_migration.sql) rather than
        // a plain client-side-gated update, since a manager who isn't the
        // project owner has no direct row-level access to this task at
        // all.
        // Split 2026-08-25 (Sandra) into two columns -- this one just the
        // date (+ the Validate/Reopen buttons); "Validated By" (below,
        // same validated_by column) is now its own separate cell.
        render: (t) => {
          const canValidate = canValidateTask(t);
          if (t.status !== "Done") {
            return <span style={{ color: "var(--muted)", fontSize: 11.5 }}>—</span>;
          }
          if (!t.validated_completion_date) {
            if (!canValidate) return <span style={{ color: "var(--muted)", fontSize: 11.5 }}>Pending validation</span>;
            return (
              <button
                onClick={async () => {
                  const { error } = await supabase.rpc("validate_task_completion", { p_task_id: t.id });
                  if (error) alert(`Couldn't validate: ${error.message}`);
                  else loadAll();
                }}
                style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, color: "var(--accent)", background: "none", border: "none", cursor: "pointer" }}
              >
                <CheckCircle2 size={13} />
                Validate
              </button>
            );
          }
          const dateOnly = t.validated_completion_date.slice(0, 10);
          const locked = Boolean(t.validated_locked_at);
          const canReopen = canReopenTask(t);
          // Reopening clears the validation (and, via the DB trigger, the
          // lock alongside it) and reverts Status to In Progress,
          // unlocking Assignee/Status/Effort/Est. Hrs/Start/Due (and Actual
          // Completion) again (see isTaskLocked above). Broadened per
          // Sandra's 2026-08-20 instruction to "only be done by the
          // immediate manager with skip level option as fallback" -- see
          // canReopenTask above. 2026-08-26: reopening a LOCKED validation
          // now routes through this same confirm but with Cancel styled as
          // the prominent choice (Sandra: "ensure that re-opening is
          // intentional and not confuse the re-open as the dominant
          // button") -- see emphasizeCancel on ConfirmDialog.
          async function doReopen() {
            const ok = await confirm({
              title: "Reopen task",
              message: `Reopen "${t.name}"? This clears its validation${locked ? " and lock" : ""} and sets Status back to In Progress, unlocking its fields for editing again.`,
              confirmLabel: "Reopen",
              cancelLabel: "Cancel",
              emphasizeCancel: locked,
            });
            if (!ok) return;
            const { error } = await supabase.rpc("reopen_task", { p_task_id: t.id });
            if (error) alert(`Couldn't reopen: ${error.message}`);
            else loadAll();
          }
          return (
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              {locked ? (
                // Locked: read-only, green-checkmark/lock indicator.
                // Clicking it (when authorized) is the entry point into
                // Reopen -- Sandra: "clicking on a locked validated date
                // can trigger that".
                <button
                  onClick={canReopen ? doReopen : undefined}
                  disabled={!canReopen}
                  title={canReopen ? "Validation locked -- click to reopen" : "Validation locked"}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    fontSize: 11.5,
                    color: "var(--text-secondary)",
                    background: "none",
                    border: "none",
                    padding: 0,
                    cursor: canReopen ? "pointer" : "default",
                  }}
                >
                  <Lock size={11} style={{ color: "var(--success-text)" }} />
                  {formatDate(dateOnly)}
                </button>
              ) : (
                <InlineDate
                  value={dateOnly}
                  editable={canValidate}
                  onCommit={async (v) => {
                    if (!v) return;
                    // Sandra, 2026-08-25: validation date can't be earlier
                    // than the actual completion date -- you can't sign off
                    // on completion before the work was actually done.
                    const completionRef = t.actual_completion_date ?? t.submitted_on;
                    if (completionRef && v < completionRef.slice(0, 10)) {
                      alert(`Validation date can't be earlier than the actual completion date (${formatDate(completionRef)}).`);
                      return;
                    }
                    const { error } = await supabase.rpc("validate_task_completion", { p_task_id: t.id, p_validated_date: new Date(v).toISOString() });
                    if (error) alert(`Couldn't save: ${error.message}`);
                    else loadAll();
                  }}
                />
              )}
              {/* Lock (2026-08-26, Sandra): a deliberate second step after
                  Validate -- freezes validated_completion_date/validated_by
                  (enforced server-side via tasks_validation_lock) until
                  Reopen clears it. Same authorization as Validate itself. */}
              {!locked && canValidate && (
                <button
                  onClick={async () => {
                    const { error } = await supabase.rpc("lock_task_validation", { p_task_id: t.id });
                    if (error) alert(`Couldn't lock: ${error.message}`);
                    else loadAll();
                  }}
                  title="Lock this validation -- freezes the date until reopened"
                  style={{ display: "flex", alignItems: "center", background: "none", border: "none", cursor: "pointer", padding: 2, color: "var(--success-text)" }}
                >
                  <CheckCircle2 size={13} />
                </button>
              )}
              {!locked && canReopen && (
                <button
                  onClick={doReopen}
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
        key: "validated_by",
        label: "Validated By",
        defaultWidth: 140,
        minWidth: 120,
        // Companion to validated_completion_date, split out 2026-08-25
        // (Sandra) so who validated and when can each be shown/hidden/
        // sorted independently instead of being crammed into one cell.
        // Read-only here -- validated_by is stamped server-side by
        // validate_task_completion, never edited directly.
        render: (t) => {
          if (t.status !== "Done" || !t.validated_completion_date) {
            return <span style={{ color: "var(--muted)", fontSize: 11.5 }}>—</span>;
          }
          return <span style={{ fontSize: 11.5 }}>{ownerName(t.validated_by)}</span>;
        },
      },
      {
        key: "actual_completion_date",
        label: "Actual Completion",
        defaultWidth: 160,
        minWidth: 140,
        // Self-reported by the assignee (2026-08-20, Sandra: "allow users
        // to add their actual task completion date") -- independent of
        // submitted_on (automatic) and validated_completion_date (manager
        // sign-off). Feeds actualCompletionDateOf's fallback chain (ahead
        // of submitted_on, behind validated_completion_date) for Timing
        // and Days +/-. Editable by the assignee or anyone who can manage
        // this project's tasks, same as most other task fields, and
        // freezes once validated (isTaskLocked), enforced both here and
        // at the DB layer (enforce_task_validation_field_lock).
        render: (t) => {
          const editable = canEditTask(t) && !isTaskLocked(t);
          if (t.status !== "Done" && !t.actual_completion_date) {
            return <span style={{ color: "var(--muted)", fontSize: 11.5 }}>—</span>;
          }
          return (
            <InlineDate
              value={t.actual_completion_date}
              editable={editable}
              onCommit={async (v) => {
                // Same logged-hours gate as marking Status Done (Sandra,
                // 2026-08-26) -- an Actual Completion Date without any
                // Confirmed/Approved time behind it is just as misleading
                // as a bare Done status with no hours.
                if (v && ownHoursFor(timeEntries, t.id) <= 0) {
                  await alert("Can't set an Actual Completion Date yet -- this task has no logged hours (Confirmed or Approved) on it. Log time first.");
                  return;
                }
                updateTask(t.id, { actual_completion_date: v || null });
              }}
            />
          );
        },
      },
      {
        key: "estimated_hours",
        label: "Scoped Hours",
        defaultWidth: 90,
        maxWidth: 120,
        render: (t) => {
          const isParent = t._depth === 0 && hasChildren(t.id);
          return (
            <span title={isParent ? "Computed from this task's own sub-tasks (sum of their Scoped Hours)" : undefined}>
              <InlineNumber
                value={t.estimated_hours}
                editable={false}
                onCommit={(v) => updateTask(t.id, { estimated_hours: v })}
              />
            </span>
          );
        },
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
          // Sandra, 2026-08-24: can't log/track hours against a task
          // whose project baseline isn't locked yet -- same gate as
          // Status and Extension Requests.
          const baselineBlocksStart = !isProjectLocked(t.project_id) && !isRunningHere;
          // Phase 26 (2026-08-28): and no new time against a project
          // whose close-out has already been approved -- the Final Scope
          // snapshot is frozen, so hours logged after it would never be
          // reflected anywhere. Mirrors enforce_time_entry_baseline_lock's
          // new closed-project branch.
          const closedBlocksStart = isProjectClosed(t.project_id) && !isRunningHere;
          const disabled = timerBusy || (Boolean(running) && !isRunningHere) || doneBlocksStart || baselineBlocksStart || closedBlocksStart;
          return (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {/* Fixed width (not sized to the text) so the button after it
                  lands in the same spot whether the value is "0" or
                  "123.45" -- assume a max of hhh.mm hours. Right-aligned
                  so the digits still read naturally against that box. */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setHoursBreakdownTaskId(t.id);
                }}
                title="See who logged time on this task"
                style={{
                  fontVariantNumeric: "tabular-nums",
                  width: 46,
                  flexShrink: 0,
                  textAlign: "right",
                  background: "none",
                  border: "none",
                  padding: 0,
                  font: "inherit",
                  color: hours > 0 ? "var(--accent)" : "inherit",
                  cursor: hours > 0 ? "pointer" : "default",
                  textDecoration: hours > 0 ? "underline" : "none",
                  textDecorationColor: hours > 0 ? "var(--border)" : undefined,
                  textUnderlineOffset: 2,
                }}
                disabled={hours === 0}
              >
                {formatHours(hours)}
              </button>
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
                      : baselineBlocksStart
                      ? "Baseline isn't locked yet -- lock it in WBS Planning before tracking hours"
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
                    // 2026-08-26 (Sandra: "grey out the blue start button
                    // when baseline is not set yet") -- disabled was
                    // already correctly gating baselineBlocksStart, but
                    // opacity never accounted for it, so the button stayed
                    // full-color/blue while functionally unclickable.
                    opacity: Boolean(running) && !isRunningHere ? 0.35 : doneBlocksStart || baselineBlocksStart ? 0.35 : 1,
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
  // it. Name always renders first/bold (its Properties popover row is
  // drag-disabled for Board views, same as Projects -- see
  // nonReorderableKeys passed to ViewSettingsMenu below). A sub-task
  // shows its parent's name as a small property instead (Notion-style
  // relation display) rather than an indent/connector icon -- not a real
  // column, so it's not toggleable via Properties, but it still respects
  // the "Show property labels on cards" switch for its own "Parent"
  // label.
  //
  // As with renderProjectCard above, every remaining visible property
  // renders as a plain label/value row in the exact order the Properties
  // popover's drag handles set, skipping whichever field currently drives
  // the Kanban grouping (already shown as the column itself).
  function renderTaskCard(t: TaskWithDepth) {
    const hidden = taskViews.activeView.hiddenColumns;
    const showLabels = taskViews.activeView.boardShowPropertyLabels ?? true;
    const groupByKey = resolveBoardGroupBy(taskViews.activeView.groupBy, TASK_BOARD_GROUPABLE_KEYS, "status");
    const propertyColumns = visibleOrderedColumns(taskColumns, taskViews.activeView).filter(
      (c) => c.key !== "name" && c.key !== groupByKey
    );
    return (
      <>
        {!hidden.includes("name") && (
          <div style={{ minWidth: 0 }}>
            <InlineText value={t.name} editable={false} bold onCommit={(v) => updateTask(t.id, { name: v })} />
          </div>
        )}
        {t.parent_task_id && (
          <div className="board-card-property">
            {showLabels && <span className="board-card-property-label">Parent</span>}
            <span className="board-card-property-value">{taskName(t.parent_task_id)}</span>
          </div>
        )}
        {propertyColumns.map((c) => (
          <div key={c.key} className="board-card-property">
            {showLabels && (
              <span className="board-card-property-label">{c.plainLabel ?? (typeof c.label === "string" ? c.label : c.key)}</span>
            )}
            <span className="board-card-property-value">{c.render(t)}</span>
          </div>
        ))}
      </>
    );
  }

  const taskGroupOptions: GroupOption<TaskWithDepth>[] = [
    {
      key: "project",
      label: "Project",
      getGroup: (t) => projectName(t.project_id),
      // 2026-09-03 (Sandra: "when grouping by project can the header
      // follow the same colors assigned to the project... base it from
      // the category colors, light version not the text color" -- there's
      // no independent per-project color, so this borrows the project's
      // own Category tone via categoryToneMap, same light-bg/dark-text
      // pairing every Category badge already uses (resolveTone in
      // DataTable picks the light .bg half automatically).
      getTone: (t) => {
        const proj = projects.find((p) => p.id === t.project_id);
        return (proj?.category && categoryToneMap[proj.category]) || "neutral";
      },
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
      // Phase 23 follow-up (2026-08-25, Sandra: "that's ok to fix too to
      // avoid confusion"): every groupable field here used to fall back to
      // incidental row-encounter order for its section order (only
      // "project" had a fixed allGroups list). Each field now gets its own
      // canonical order -- the same fixed sequence already used for its
      // Board columns/dropdown, not a blind alphabetical re-sort, so a
      // deliberately-ordered scale (Status/Effort here) keeps its
      // workflow/severity order instead of being scrambled A-Z.
      allGroups: () => [...TASK_STATUS_OPTIONS, "No status"],
    },
    {
      key: "assignee",
      label: "Assignee",
      getGroup: (t) => ownerName(t.assignee_id),
      // 2026-09-03 (Sandra: "if grouped by assignee then follow their
      // assigned colors but a subtle one too") -- tried per-person
      // colorForPerson tinting via resolveTone, then reverted same day
      // ("revert the colors when grouped to default, it's not
      // translating well") -- back to the flat gray every other
      // grouping without a getTone falls back to.
      allGroups: () => [...people.map((p) => p.name), "—"],
    },
    {
      // 2026-09-03 (Sandra: "add a group option to group by project
      // owner") -- distinct from Assignee above (who's doing the task)
      // and from Owner in the Projects grouping (that one's per-project;
      // this reads the same owner_id but through each task's own
      // project_id, so every task in a project lands under that
      // project's owner regardless of who the task itself is assigned
      // to).
      key: "project_owner",
      label: "Project Owner",
      getGroup: (t) => ownerName(projects.find((p) => p.id === t.project_id)?.owner_id ?? null),
      allGroups: () => [...people.map((p) => p.name), "—"],
    },
    {
      key: "effort",
      label: "Effort",
      getGroup: (t) => t.effort ?? "No effort set",
      getTone: (t) => (t.effort ? TASK_EFFORT_DEFAULT_TONES[t.effort] ?? "neutral" : "neutral"),
      allGroups: () => [...TASK_EFFORT_OPTIONS, "No effort set"],
    },
    {
      key: "work_type",
      label: "Work Type",
      getGroup: (t) => workTypes.find((w) => w.id === t.work_type_id)?.name ?? "No work type set",
      // workTypes is already alphabetized (Phase 23's one-time DB re-sort
      // + everything reads .order("sort_order")), so this just carries
      // that same order into the grouped Table view's section headers.
      allGroups: () => [...workTypes.filter((w) => w.is_active).map((w) => w.name), "No work type set"],
    },
    {
      key: "timing",
      label: "Timing",
      getGroup: (t) => timingOf(t).label,
      getTone: (t) => timingOf(t).tone,
      allGroups: () => TASK_TIMING_BOARD_COLUMNS.map((c) => c.value),
    },
    {
      key: "due_date_ext",
      label: "Due Date Ext.",
      getGroup: (t) => dueDateExtStatus(t).label,
      getTone: (t) => dueDateExtStatus(t).tone,
      allGroups: () => ["No Extension", "Requested", "Rejected", "Extended"],
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
      label: "Scoped Hours",
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
    {
      key: "work_type",
      label: "Work Type",
      getGroup: (t) => workTypes.find((w) => w.id === t.work_type_id)?.name ?? "No work type set",
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
    if (groupBy === "work_type") return workTypes.filter((w) => w.is_active).map((w) => ({ value: w.id, label: w.name, tone: "neutral" }));
    if (groupBy === "project") return projects.map((p) => ({ value: p.id, label: p.name ?? "Untitled", tone: "neutral" }));
    if (groupBy === "timing") return TASK_TIMING_BOARD_COLUMNS;
    if (groupBy === "due_date_ext") return DUE_DATE_EXT_BOARD_COLUMNS;
    return TASK_BOARD_COLUMNS;
  }

  function getTaskBoardValue(t: TaskWithDepth, groupBy: string): string | null {
    if (groupBy === "assignee") return t.assignee_id;
    if (groupBy === "effort") return t.effort;
    if (groupBy === "work_type") return t.work_type_id;
    if (groupBy === "project") return t.project_id;
    if (groupBy === "timing") return timingOf(t).label;
    if (groupBy === "due_date_ext") return dueDateExtStatus(t).label;
    return t.status;
  }

  function getTaskBoardMoveHandler(groupBy: string): ((t: TaskWithDepth, newValue: string) => void) | undefined {
    // Sandra, 2026-07-29: this page only allows Status/Time/Extension/
    // Validation actions now -- dragging a card between Assignee or
    // Effort board columns used to silently reassign/re-score the task,
    // which is a structural edit that now belongs in WBS Planning only.
    if (groupBy === "status") return (t, v) => updateTask(t.id, { status: v || null });
    return undefined; // assignee, effort, work_type, project, timing, due_date_ext: read-only board
  }

  // Labels here match each column's own header text exactly (e.g. "Task"
  // not "Name", "Start"/"Due" not "Start date"/"Due date"), and every
  // sortable column is listed -- "Timing" was previously missing entirely.
  const taskSortOptions: SortOption<TaskWithDepth>[] = [
    { key: "name", label: "Task", getValue: (t) => t.name ?? "" },
    { key: "project", label: "Project", getValue: (t) => projectName(t.project_id) },
    { key: "assignee", label: "Assignee", getValue: (t) => ownerName(t.assignee_id) },
    { key: "status", label: "Status", getValue: (t) => t.status ?? "" },
    // Same "Very Heavy" hole as actualProgress had: TASK_EFFORT_POINTS has no
    // entry for it, so the heaviest tasks sorted as blank. Effort is an
    // ordered band derived from hours, so sort by that order.
    { key: "effort", label: "Effort", getValue: (t) => (t.effort ? (TASK_EFFORT_OPTIONS.indexOf(t.effort) + 1 || null) : null) },
    { key: "work_type", label: "Work Type", getValue: (t) => workTypes.find((w) => w.id === t.work_type_id)?.name ?? "" },
    { key: "start_date", label: "Start", getValue: (t) => (t.start_date ? new Date(t.start_date).getTime() : null) },
    { key: "timing", label: "Timing", getValue: (t) => timingRank(timingOf(t).label) },
    { key: "current_due_date", label: "Due", getValue: (t) => (t.current_due_date ? new Date(t.current_due_date).getTime() : null) },
    { key: "estimated_hours", label: "Scoped Hours", getValue: (t) => t.estimated_hours ?? null },
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
    // See the matching comment on projectViews' columnOrderVersion above.
    // 1 = 2026-09-02 re-prioritization (Status bumped up; Scoped/Spent
    // hours -- the daily workspace -- moved right after identity; Timing/
    // Effort as the triage cluster; schedule fields next; Work Type and
    // Hrs Variance/% pushed to the very end as reporting-only).
    columnOrderVersion: 1,
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
    // Phase 26: see addSubtask above.
    if (isProjectClosed(projectId)) {
      await alert("This project is closed -- its scope is final, so no more tasks can be added to it.");
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
      ? resolveBoardGroupBy(projectViews.activeView.groupBy, PROJECT_BOARD_GROUPABLE_KEYS, "phase")
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
  const PROJECT_TIMELINE_CHIP_ORDER = ["status", "phase", "owner", "priority", "health", "category", "source", "effort_level", "wbs_status", "days_extended", "estimated_hours", "time_spent_hours", "hours_variance", "hours_variance_pct"];
  const projectTimelinePropertyColumns = visibleOrderedColumns(projectColumns, projectViews.activeView)
    .filter((c) => !PROJECT_TIMELINE_EXCLUDED_KEYS.includes(c.key))
    .slice()
    .sort((a, b) => {
      const ai = PROJECT_TIMELINE_CHIP_ORDER.indexOf(a.key);
      const bi = PROJECT_TIMELINE_CHIP_ORDER.indexOf(b.key);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
  // Calendar-only variant: Priority and Effort move up onto the card's
  // title line as small inline pills (see the Calendar CalendarView call's
  // titleBadge below) instead of their own stacked lines -- Sandra: "can
  // the effort and prio be on the same line as the project title", with
  // an annotated screenshot pointing at empty space to the right of the
  // title. Excluded here so they don't ALSO render as duplicate stacked
  // lines; Timeline's own chip layout (projectTimelinePropertyColumns,
  // above) is unaffected -- she only asked about the Calendar card.
  const projectCalendarPropertyColumns = projectTimelinePropertyColumns.filter(
    (c) => c.key !== "priority" && c.key !== "effort_level"
  );
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
          <h1>Projects</h1>
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
            boardDefaultGroupBy="phase"
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
              onHiddenColumnsChange={(hiddenColumns) => projectViews.updateActiveView({ hiddenColumns })}
              columnOrder={projectViews.activeView.columnOrder}
              onColumnOrderChange={(columnOrder) => projectViews.updateActiveView({ columnOrder })}
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
              boardLabelToggle={
                projectViews.activeView.viewType === "board"
                  ? {
                      checked: projectViews.activeView.boardShowPropertyLabels ?? true,
                      onChange: (boardShowPropertyLabels) => projectViews.updateActiveView({ boardShowPropertyLabels }),
                    }
                  : undefined
              }
              nonReorderableKeys={projectViews.activeView.viewType === "board" ? ["name"] : undefined}
            />
          </div>
        </div>
        {projectViews.activeView.viewType === "timeline" && (
          <div className="timeline-controls-row">
            <TimelineControls
              scale={projectViews.activeView.timelineScale ?? "month"}
              onScaleChange={(timelineScale) => projectViews.updateActiveView({ timelineScale })}
              dateMode={projectViews.activeView.timelineDateMode ?? "range"}
              onDateModeChange={(timelineDateMode) => projectViews.updateActiveView({ timelineDateMode })}
            />
          </div>
        )}
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
              <FieldPickerButton
                label="Priority"
                options={PROJECT_PRIORITY_OPTIONS}
                labelFor={priorityLabel}
                onPick={(v) => bulkUpdateProjects({ priority: v as ProjectRow["priority"] })}
              />
              <FieldPickerButton
                label="Owner"
                options={people.map((x) => x.name)}
                onPick={(v) => {
                  const person = people.find((x) => x.name === v);
                  bulkUpdateProjects({ owner_id: person?.id ?? null });
                }}
              />
              <FieldPickerButton
                label="Status"
                options={PROJECT_STATUS_OPTIONS}
                // Bulk edit can't cascade Phase per-row the way the single-row
                // Status cell does (changeProjectStatus) -- every selected row
                // gets the exact same flat patch. Completed is the one case
                // that's unambiguous regardless of each row's prior phase (it
                // always means Done), so that's force-set here too; for the
                // other statuses the bulk action leaves each row's existing
                // Phase untouched rather than guessing.
                onPick={(v) => bulkUpdateProjects(v === "Completed" ? { status: v, phase: "Done" } : { status: v || null })}
              />
              <FieldPickerButton label="Phase" options={activePhaseNames} onPick={(v) => bulkUpdateProjects({ phase: v || null })} />
              <button className="bulk-bar-delete" onClick={bulkDeleteProjects}>
                <Archive size={12} />
                Archive
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
              columns={getProjectBoardColumns(resolveBoardGroupBy(projectViews.activeView.groupBy, PROJECT_BOARD_GROUPABLE_KEYS, "phase"))}
              getValue={(p) => getProjectBoardValue(p, resolveBoardGroupBy(projectViews.activeView.groupBy, PROJECT_BOARD_GROUPABLE_KEYS, "phase"))}
              hiddenColumns={projectViews.activeView.hiddenGroups}
              renderCard={renderProjectCard}
              onMoveCard={getProjectBoardMoveHandler(resolveBoardGroupBy(projectViews.activeView.groupBy, PROJECT_BOARD_GROUPABLE_KEYS, "phase"))}
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
              getTone={(p) => PROJECT_STATUS_TONES[p.status ?? ""] ?? "neutral"}
              getTooltip={(p) => `${p.name} · ${formatDate(p.start_date)} → ${formatDate(p.end_date)}`}
              emptyLabel="No projects yet. Add one below."
              propertyColumns={projectTimelinePropertyColumns}
              renderActions={(p) => (
                <CardActionMenu
                  items={[
                    { icon: <Archive size={13} />, label: "Archive", tone: "danger", onClick: () => archiveProjects([p.id]) },
                  ]}
                />
              )}
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
              getTone={(p) => PROJECT_STATUS_TONES[p.status ?? ""] ?? "neutral"}
              getTooltip={(p) => `${p.name} · ${formatDate(p.start_date)} → ${formatDate(p.end_date)}`}
              emptyLabel="No projects yet. Add one below."
              dateMode={projectViews.activeView.timelineDateMode ?? "range"}
              onDateModeChange={(timelineDateMode) => projectViews.updateActiveView({ timelineDateMode })}
              propertyColumns={projectCalendarPropertyColumns}
              titleBadge={(p) => (
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  {projectColumns.find((c) => c.key === "priority")?.render(p)}
                  {projectColumns.find((c) => c.key === "effort_level")?.render(p)}
                </div>
              )}
              renderActions={(p) => (
                <CardActionMenu
                  items={[
                    { icon: <Archive size={13} />, label: "Archive", tone: "danger", onClick: () => archiveProjects([p.id]) },
                  ]}
                />
              )}
              isNonWorkingDay={(d) => !isWorkingDay(d, holidayDates)}
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
              onSelectRange={(keys) => setSelectedProjectIds(keys)}
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
              onHiddenColumnsChange={(hiddenColumns) => taskViews.updateActiveView({ hiddenColumns })}
              columnOrder={taskViews.activeView.columnOrder}
              onColumnOrderChange={(columnOrder) => taskViews.updateActiveView({ columnOrder })}
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
              boardLabelToggle={
                taskViews.activeView.viewType === "board"
                  ? {
                      checked: taskViews.activeView.boardShowPropertyLabels ?? true,
                      onChange: (boardShowPropertyLabels) => taskViews.updateActiveView({ boardShowPropertyLabels }),
                    }
                  : undefined
              }
              nonReorderableKeys={taskViews.activeView.viewType === "board" ? ["name"] : undefined}
            />
          </div>
        </div>
        {taskViews.activeView.viewType === "timeline" && (
          <div className="timeline-controls-row">
            <TimelineControls
              scale={taskViews.activeView.timelineScale ?? "month"}
              onScaleChange={(timelineScale) => taskViews.updateActiveView({ timelineScale })}
              dateMode={taskViews.activeView.timelineDateMode ?? "range"}
              onDateModeChange={(timelineDateMode) => taskViews.updateActiveView({ timelineDateMode })}
            />
          </div>
        )}
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
              {/* Sandra, 2026-07-29: bulk Assignee reassignment and bulk
                  Delete are structural edits, same reasoning as the
                  per-row changes above -- only Status stays as a bulk
                  action on this page now. */}
              <FieldPickerButton label="Status" options={TASK_STATUS_OPTIONS} onPick={(v) => bulkUpdateTasks({ status: v || null })} />
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
            />

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
              emptyLabel="No tasks yet. Add tasks from WBS Planning."
              propertyColumns={taskTimelinePropertyColumns}
              getGroup={taskTimelineGroupOption ? (t) => taskTimelineGroupOption.getGroup(t) : undefined}
              getGroupTone={taskTimelineGroupOption?.getTone}
              hiddenGroups={taskViews.activeView.hiddenGroups}
              labelWidth={taskViews.activeView.timelineLabelWidth ?? 460}
              onLabelWidthChange={(timelineLabelWidth) => taskViews.updateActiveView({ timelineLabelWidth })}
            />

          </>
        ) : taskViews.activeView.viewType === "calendar" ? (
          <>
            <CalendarView
              rows={sortRowsHierarchical(filteredVisibleTasks, taskViews.activeView.sorts, taskSortOptions, (t) => t.id, (t) => t.parent_task_id)}
              rowKey={(t) => t.id}
              renderLabel={(t) => (
                <InlineText value={t.name} editable={false} bold onCommit={(v) => updateTask(t.id, { name: v })} />
              )}
              getParentLabel={(t) => (t.parent_task_id ? tasks.find((pt) => pt.id === t.parent_task_id)?.name ?? null : null)}
              getProjectLabel={(t) => projectName(t.project_id)}
              titleBadge={(t) => taskColumns.find((c) => c.key === "effort")?.render(t)}
              getStart={(t) => t.start_date}
              getDue={(t) => t.current_due_date}
              getTone={(t) => statusTone(statusGroupOf(TASK_STATUS_GROUPED, t.status))}
              getTooltip={(t) => `${t.name} · ${formatDate(t.start_date)} → ${formatDate(t.current_due_date)}`}
              emptyLabel="No tasks yet. Add tasks from WBS Planning."
              dateMode={taskViews.activeView.timelineDateMode ?? "range"}
              onDateModeChange={(timelineDateMode) => taskViews.updateActiveView({ timelineDateMode })}
              propertyColumns={taskCalendarPropertyColumns}
              isNonWorkingDay={(d) => !isWorkingDay(d, holidayDates)}
            />

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
              emptyLabel="No tasks yet. Add tasks from WBS Planning."
              compactGutter
              selectable
              selectedKeys={selectedTaskIds}
              onToggleSelect={(key) => setSelectedTaskIds((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))}
              onSelectRange={(keys) => setSelectedTaskIds(keys)}
              onToggleSelectAll={toggleTaskSelectAll}
              // Sandra, 2026-07-29: task creation, reordering, and the
              // "+ New task" row/group-footer trigger are removed from
              // this page -- structural changes (adding, ordering,
              // renaming tasks) now happen in WBS Planning only. This
              // table stays for Status/Time Tracking/Due Date Ext./
              // Validated actions.
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

      {notesSidebarProjectId && (
        <NotesSidebar
          projectId={notesSidebarProjectId}
          projectName={projects.find((p) => p.id === notesSidebarProjectId)?.name || "Untitled project"}
          people={people}
          currentPersonId={me?.id ?? null}
          onClose={() => setNotesSidebarProjectId(null)}
          onCountChange={(projectId, count) => setNoteCounts((prev) => ({ ...prev, [projectId]: count }))}
        />
      )}

      {hoursBreakdownTaskId && (() => {
        const task = tasks.find((t) => t.id === hoursBreakdownTaskId);
        if (!task) return null;
        // 2026-08-26 (Sandra: "when clicking on time spent and viewing
        // logs can we list all the logs say if it's been logged for
        // multiple days and also indicate if it's via time tracking or
        // manual") -- was a per-person TOTAL only (personHoursBreakdownFor);
        // now lists every individual entry under each person, in date
        // order, with a source pill, still grouped/summed by person and
        // grand-totaled the same way as before.
        const childIds = tasks.filter((tt) => tt.parent_task_id === task.id).map((tt) => tt.id);
        const relevantTaskIds = new Set([task.id, ...childIds]);
        const entries = timeEntries
          .filter((e) => relevantTaskIds.has(e.task_id))
          .slice()
          .sort((a, b) => a.started_at.localeCompare(b.started_at));
        const byPerson = new Map<string, TimeEntryRow[]>();
        for (const e of entries) {
          if (!byPerson.has(e.person_id)) byPerson.set(e.person_id, []);
          byPerson.get(e.person_id)!.push(e);
        }
        const total = entries.reduce((sum, e) => sum + (e.duration_minutes ?? 0), 0) / 60;
        const sourceTone: Record<string, string> = { timer: "accent", manual: "neutral", legacy: "neutral" };
        const sourceLabel: Record<string, string> = { timer: "Timer", manual: "Manual", legacy: "Legacy" };
        return (
          <Modal title={`Time spent -- ${task.name}`} onClose={() => setHoursBreakdownTaskId(null)}>
            {entries.length === 0 ? (
              <p style={{ fontSize: 12, color: "var(--muted)" }}>No confirmed time logged on this task yet.</p>
            ) : (
              <>
                {Array.from(byPerson.entries()).map(([personId, personEntries]) => {
                  const personTotal = personEntries.reduce((sum, e) => sum + (e.duration_minutes ?? 0), 0) / 60;
                  return (
                    <div key={personId} style={{ marginBottom: 10 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0 4px", borderBottom: "1px solid var(--border)", fontSize: 12.5, fontWeight: 600 }}>
                        <span>{people.find((p) => p.id === personId)?.name ?? "Unknown"}</span>
                        <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatHours(personTotal)}h</span>
                      </div>
                      {personEntries.map((e) => (
                        <div key={e.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0", fontSize: 11.5, color: "var(--text-secondary)" }}>
                          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            {formatDate(e.started_at)}
                            <span className={`status-pill ${sourceTone[e.source] ?? "neutral"}`} style={{ fontSize: 9.5, padding: "1px 5px" }}>
                              {sourceLabel[e.source] ?? e.source}
                            </span>
                          </span>
                          <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatHours((e.duration_minutes ?? 0) / 60)}h</span>
                        </div>
                      ))}
                    </div>
                  );
                })}
                <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", fontSize: 12.5, fontWeight: 700 }}>
                  <span>Total</span>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatHours(total)}h</span>
                </div>
              </>
            )}
          </Modal>
        );
      })()}

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
