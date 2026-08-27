import { useState, useEffect, useCallback, useRef, Fragment, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams, Link } from "react-router-dom";
import { ArrowLeft, Plus, ChevronLeft, ChevronRight, ChevronDown, Info, AlertTriangle, Link2, Trash2, GripVertical, RefreshCw, Clock, ListPlus, TrendingUp, TrendingDown, Calendar, User, Circle, CheckCircle2, Pin } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useSession } from "../lib/useSession";
import { useConfirm } from "../lib/useConfirm";
import { InlineText, InlineNumber, InlineSelect, InlineDate } from "../components/InlineCell";
import { formatDate } from "../lib/formatDate";
import { rollupHoursFor, formatHours, type TimeEntryRow } from "../lib/timeTracking";
import { addDays, buildHolidaySet, isWorkingDay, parseLocalDate, toISO, workingDaysBetween, type HolidaySet } from "../lib/workingDays";
import { fullCapacityScenario, capacityBasedScenario, packFullCapacityQueue, FULL_CAPACITY_DAILY_HOURS, type FullCapacityQueueTask } from "../lib/taskScheduling";
import { buildForwardSchedule, PROJECT_PM_DAILY_HOURS, type SchedTaskRow, type SchedProjectRow, type SchedAvailabilityRow } from "../lib/capacityScheduler";
import { TASK_EFFORT_OPTIONS, TASK_EFFORT_DEFAULT_TONES, TASK_STATUS_GROUPED, statusGroupOf } from "../lib/notionOptions";
import {
  dailyCapacityFor,
  tierOf,
  taskWorkingDays,
  projectWorkingDays,
  STANDARD_DAILY_HOURS,
  type UtilTaskRow,
  type UtilProjectRow,
  type UtilPersonRow,
} from "../lib/utilizationCalc";
import { colorForPerson, UNASSIGNED_BAR_COLOR } from "../lib/personColors";
import { WBS_STATUS_META, type WbsStatus } from "../lib/wbsStatus";
import { useUnsavedChangesGuard } from "../lib/useUnsavedChangesGuard";
import UtilPersonFilterButton from "../components/UtilPersonFilterButton";

interface ProjectRow {
  id: string;
  name: string;
  owner_id: string | null;
  start_date: string | null;
  end_date: string | null;
  timelines_locked: boolean;
  phase: string | null;
  status: string | null;
  // Draft / Baseline Locked / Revision in Progress / Changed After
  // Baseline / Closed -- a distinct axis from Phase/Status above (Phase 1
  // migration, 2026-07-28). Drives the status banner and which actions
  // (Lock Baseline / Start Revision / Apply/Discard / Request Closure)
  // show below.
  wbs_status: WbsStatus;
  // Persists whichever mode Save last actually wrote onto the tasks
  // (migration 2026-07-28) -- shown read-back in the header as "Scoping
  // Effort" so a project's officially-saved mode stays visible on return
  // visits, not just whatever this page's own local toggle happens to be
  // set to right now.
  scoping_effort_mode: string | null;
  // 2026-08-26 (Sandra: "before requesting to close, all details are
  // encoded like project status, phase, category, priority, source and
  // complexity"): fetched here purely to gate handleRequestClosure below
  // -- these are otherwise edited on the Projects & Tasks list, not this
  // page.
  category: string | null;
  source_id: string | null;
  priority: string | null;
  effort_level: string | null;
}
interface TaskRow {
  id: string;
  project_id: string;
  parent_task_id: string | null;
  name: string;
  assignee_id: string | null;
  status: string | null;
  start_date: string | null;
  // Per-mode draft Start dates (migration 2026-07-24f). `start_date` above
  // stays the single canonical field the REST of the app reads (Projects &
  // Tasks table, Timeline, Calendar) -- only written by this page's own
  // Save button, same as `current_due_date` always was. Full Effort and
  // Conservative Effort each need their OWN Start now: a dependency's
  // predecessor finishes on a different date under each mode, so a single
  // shared Start could never sit "right after" both at once -- see
  // [[project_capaciq_wbs_planning]] Round 11 for the live bug this fixes.
  start_date_full: string | null;
  start_date_standard: string | null;
  // True while this mode's Start is still "on auto-pilot" -- i.e. still
  // tracking its dependencies' own End dates live, rather than having been
  // deliberately typed by hand. Set true whenever a dependency is added
  // (or a task has no dependencies at all, in which case it's simply
  // unused), and flipped to false the moment the user directly edits that
  // mode's Start date themselves. See the sync effect below (migration
  // 2026-07-24g) -- added because Sandra found that extending a
  // predecessor's Estimated hours moved ITS OWN End date but did nothing
  // to a dependent task's already-set Start, leaving only the warning icon
  // and a manual untick/retick-the-dependency workaround.
  start_full_auto: boolean;
  start_standard_auto: boolean;
  // Phase 19 (2026-08-24): Manual mode's own typed End date -- when set
  // (alongside a Manually-overridden Start), the task's hours are spread
  // evenly across the Start-to-End window instead of a flat 7.5h/day
  // rate. Null means "no End typed yet," same convention as every other
  // optional per-task field here.
  manual_end_date: string | null;
  current_due_date: string;
  estimated_hours: number | null;
  effort: string | null;
  // Phase 12 (2026-08-20): new reporting dimension, admin-configurable via
  // work_types (see WorkTypeOption below). WBS Planning is the only page
  // that can actually set it -- the main Tasks page shows it read-only,
  // same governance split as every other structural field here.
  work_type_id: string | null;
  // Phase 21 (2026-08-24): Materials Output. Sandra: track what kind of
  // material a task produced (admin-configurable via output_types, same
  // pattern as Work Type) and how many units, on every task -- feeds the
  // Portfolio Dashboard's Materials Output card + breakdown chart.
  output_type_id: string | null;
  output_count: number | null;
  is_archived: boolean;
  sort_order: number | null;
}
interface WorkTypeOption {
  id: string;
  name: string;
  is_active: boolean;
  sort_order: number;
  is_fixed_schedule: boolean;
}
interface OutputTypeOption {
  id: string;
  name: string;
  is_active: boolean;
  sort_order: number;
}

// Column resizing (2026-08-24, Sandra: "can we now allow resizing column
// width in the WBS"). Scoped to the 10 single-column (rowSpan=2) headers
// in the task table -- Task/Work Type/Scoped Hours/Spent hrs/
// Effort/Output Type/Output Count/Assignee/Depends on/Changes vs Baseline.
// The 9 date-mode sub-columns (Start/End/Duration x Forecasted/Capacity-
// Based/Theoretical) stay at their fixed widths for now -- they're narrow
// date/number columns that rarely need more room, and resizing them would
// mean juggling per-mode keys for comparatively little benefit; easy to
// add later if Sandra asks. Widths persist in localStorage (this table
// has no "saved views" concept the way Projects/Tasks do, so there's
// nowhere server-side to put per-user column widths yet) so a reload
// doesn't reset someone's preferred layout.
const WBS_TASK_COLUMN_DEFAULTS: Record<string, number> = {
  task: 240,
  work_type: 130,
  effort_hours: 90,
  spent_hrs: 90,
  effort: 90,
  output_type: 140,
  output_count: 90,
  assignee: 150,
  depends_on: 150,
  changes: 190,
};
const WBS_TASK_COLUMN_ORDER = ["task", "depends_on", "assignee", "work_type", "output_type", "output_count", "effort_hours", "spent_hrs", "effort", "changes"];
const WBS_DATE_COLUMN_WIDTHS = [110, 100, 90, 110, 100, 90, 110, 100, 90]; // Start/End/Duration x3 modes, fixed
const WBS_COL_WIDTHS_STORAGE_KEY = "capaciq_wbs_task_col_widths";
const WBS_FREEZE_STORAGE_KEY = "capaciq_wbs_freeze_task_col"; // legacy -- read once as a migration fallback
const WBS_FREEZE_COL_STORAGE_KEY = "capaciq_wbs_freeze_col_key";
const WBS_MIN_COL_WIDTH = 50;
interface PersonRow {
  id: string;
  name: string;
  daily_capacity_hours: number;
  is_active: boolean;
  color: string | null;
}
// Phase 2 (2026-07-28): Draft/Baseline/Revision/Final-Scope workflow rows.
// Only the ONE in-progress revision and ONE pending closure request (if
// any) matter to this page -- both are DB-enforced to be unique per
// project (partial unique indexes), so at most one of each ever exists.
interface RevisionRow {
  id: string;
  revision_number: number;
  reason: string;
  status: "in_progress" | "applied" | "discarded";
  started_at: string;
}
// Design spec item 4 (Sandra, 2026-07-29 follow-up, per her reference
// mockup): the task list's Changes/Notes columns compare CURRENT live
// tasks directly against the active Baseline V<n> snapshot -- not the
// latest-applied-revision log (that's still used for the Revision
// Summary panel/legend). project_baseline_tasks already captures
// everything needed for this (parent_task_id/assignee_name/effort/
// depends_on/start+end dates both modes -- confirmed via
// supabase/phase1_migration.sql's ALTER TABLE additions), so no schema
// change was needed.
interface BaselineTaskFull {
  task_id: string;
  estimated_hours: number | null;
  assignee_name: string | null;
  depends_on: string[] | null;
  end_date_full: string | null;
  end_date_standard: string | null;
}
interface RevisionChangeRow {
  id: string;
  revision_id?: string;
  task_id: string;
  task_name: string;
  change_type: string;
  field: string | null;
  previous_value: unknown;
  new_value: unknown;
  changed_at?: string;
}
interface ClosureRequestRow {
  id: string;
  status: "pending" | "approved" | "rejected";
  requested_at: string;
  requested_by: string | null;
}
interface BaselineRequestRow {
  id: string;
  status: "pending" | "approved" | "rejected";
  requested_at: string;
  requested_by: string | null;
}

interface ActiveBaselineRow {
  version_number: number;
  captured_at: string;
}
interface AvailabilityRow {
  person_id: string;
  date: string;
  status: "off" | "half_day";
}
interface HolidayRow {
  date: string;
}
// Task dependencies (Finish-to-Start only, v1, same-project only -- see
// migration 2026-07-24e). A task's own Start date STAYS a free, directly
// editable field (Sandra's explicit choice) -- a dependency only drives a
// soft conflict WARNING in the UI when this task's own Start falls on or
// before a predecessor's own End under the currently active mode. It does
// NOT lock or auto-compute Start the way parent-task rollups do.
interface DependencyRow {
  task_id: string;
  depends_on_task_id: string;
}

// Sandra, 2026-07-24: "this is getting complicated ... have a full and
// conservative computation - remove capacity based." Capacity-Based was
// trying to answer two questions at once (how long will this take, AND
// does this person have room) -- splitting those apart is why the
// Utilization panel below now carries the "does this person have room"
// job on its own, and Assignee becomes a normal per-task field again
// (same as the rest of the app), not something tied to a scheduling mode.
type Mode = "full_capacity" | "standard" | "manual";
// Phase 21 (2026-08-24): Sandra -- rename "Manual" to "Forecasted"
// everywhere in the UI (it's the committed/planned schedule, not a
// manual-entry concept) and standardize display order to Forecasted,
// Capacity-Based, Full everywhere the 3 scenarios appear together
// (this table's columns, the Utilization snapshot rows, the Gantt
// sections, the Effort Comparison chart). Internal wire values
// ("manual", "standard", "full_capacity") are UNCHANGED -- DB columns,
// scoping_effort_mode, and every RPC still use the old identifiers, this
// is a display-only rename/reorder to avoid any migration on a live
// project store. See [[project_capaciq_forecasted_rename_reorder_color]].
const MODE_LABEL: Record<Mode, string> = {
  full_capacity: "Theoretical",
  // Retired Conservative Effort's flat 4h/day rate (Sandra, 2026-08-21):
  // "standard" keeps its wire value/DB columns (scoping_effort_mode=
  // 'standard', etc. -- zero migration needed, fully backward compatible
  // with every already-saved/locked project) but now means Capacity-
  // Based -- computeEntry's "standard" branch walks each assignee's REAL
  // cross-project task queue via buildForwardSchedule instead of a flat
  // rate. See [[project_capaciq_wbs_capacity_based_mode]].
  standard: "Capacity-Based",
  // Phase 12 (2026-08-21): Sandra -- Full Effort and Capacity-Based are
  // now both READ-ONLY, pure computed references; "Manual" (now labeled
  // "Forecasted", Phase 21) is the only mode where a human date wins.
  // Reuses the exact columns/flag that used to carry Capacity-Based's
  // in-place override (start_date_standard/start_standard_auto, Phase 7)
  // -- zero migration, since Capacity-Based no longer needs a draft
  // Start field of its own now that it can never be overridden.
  // Forecasted mirrors Capacity-Based's live suggestion until the user
  // types a Start themselves, then freezes (same freeze mechanic Phase 7
  // already had, just always-on and living in its own column instead of
  // conditionally inside Capacity-Based's). See
  // [[project_capaciq_phase12_manual_mode_split]].
  manual: "Forecasted",
};
// Phase 21 reorder: Forecasted, Capacity-Based, Full (was Full,
// Capacity-Based, Manual) -- drives column order in the task table,
// Timeline (Gantt) section order, and (via the scenario-key mapping
// below) the Utilization snapshot row order.
// 2026-08-26 (Sandra: "remove the Capacity-Based option, it's just
// added noise -- remove all capacity based related features and
// functions"): "standard" dropped from this array, which drives the
// task table's column groups, the Timeline (Gantt) sections, and the
// Effort Comparison chart -- all three now only ever iterate
// Forecasted/Theoretical. The "standard" Mode value, MODE_LABEL entry,
// and buildChain("standard") computation are left in place rather than
// deleted outright: Capacity-Based has no dedicated persisted columns
// of its own (see the big Phase 12 comment below -- it reads the SAME
// start_date_standard/start_standard_auto fields Forecasted owns), so
// there's no live data path left to break by leaving the plumbing
// present but simply never invoked from the UI. See
// [[project_capaciq_capacity_based_removal]].
const MODES: Mode[] = ["manual", "full_capacity"];

// Phase 21 (2026-08-24): a single small vocabulary ("scenario") that
// both Mode (task table / Gantt) and UtilPreviewMode (Utilization
// snapshot) map onto, so ONE centralized toggle can filter both areas at
// once. Sandra: "select which views he wants to see -- if I only want
// to see forecasted, then scenarios and gantt will only show forecasted
// ones." "Actual" is deliberately NOT a ScenarioKey -- it always stays
// visible in the snapshot as the ground-truth reference row, per
// Sandra's explicit confirmation, and has no Gantt equivalent at all.
type ScenarioKey = "forecasted" | "capacity_based" | "full";
const SCENARIO_ORDER: ScenarioKey[] = ["forecasted", "full"];
const SCENARIO_LABEL: Record<ScenarioKey, string> = {
  forecasted: "Forecasted",
  capacity_based: "Capacity-Based",
  full: "Theoretical",
};
// Colors confirmed with Sandra 2026-08-24: Forecasted green,
// Capacity-Based blue, Full yellow -- a straight 3-way swap of the
// Phase 10 palette (which had Full=blue, Capacity-Based=green,
// Manual=yellow).
const SCENARIO_COLOR: Record<ScenarioKey, string> = {
  forecasted: "#1f9d55", // green
  capacity_based: "#2f6fed", // blue
  full: "#c9971b", // yellow/amber
};
const MODE_TO_SCENARIO: Record<Mode, ScenarioKey> = {
  manual: "forecasted",
  standard: "capacity_based",
  full_capacity: "full",
};
const SCENARIO_TO_MODE: Record<ScenarioKey, Mode> = {
  forecasted: "manual",
  capacity_based: "standard",
  full: "full_capacity",
};

// Phase 9 (2026-08-21): the WBS Utilization-snapshot preview toggle is
// its own, slightly richer set of options than the 2 task-table Modes --
// Sandra: "I want it to show the actual resource utilization, then a
// toggle to preview what it'll look like based on the selected effort
// type... e.g. actual 10%, Capacity-Based 40%, manual 60%." "Actual" is
// today's real committed state (no draft merged in at all). The other
// three preview this project's DRAFT plan blended into that baseline --
// "Capacity-Based" here always uses the pure queue-suggested schedule
// (ignoring any per-task manual overrides, so it answers "what would the
// scheduler pick"), while "Manual" is the override-aware chain (what
// Save will actually persist, including any committed overrides) --
// these two are identical unless at least one task has been overridden.
type UtilPreviewMode = "actual" | "full_capacity" | "standard_suggested" | "standard_committed";
// Phase 21 reorder (2026-08-24): Actual first (always-shown baseline
// reference), then Forecasted/Capacity-Based/Full in the same standard
// order used everywhere else on the page.
const UTIL_PREVIEW_MODES: UtilPreviewMode[] = ["actual", "standard_committed", "full_capacity"];
// Maps each preview mode onto the shared ScenarioKey vocabulary above --
// "actual" has no ScenarioKey (it's not toggle-able, always shown).
const UTIL_MODE_TO_SCENARIO: Partial<Record<UtilPreviewMode, ScenarioKey>> = {
  standard_committed: "forecasted",
  standard_suggested: "capacity_based",
  full_capacity: "full",
};
// Phase 10 (2026-08-21): Sandra -- show all 4 scenarios as simultaneous
// rows per person instead of a tab you switch between, so they can be
// compared at a glance. Labels/colors confirmed with her directly.
// Phase 21 (2026-08-24): "Manual Override" relabeled "Forecasted" to
// match the rename everywhere else.
const UTIL_PREVIEW_LABEL: Record<UtilPreviewMode, string> = {
  actual: "Committed (Existing)",
  full_capacity: "Theoretical",
  standard_suggested: "Capacity-Based",
  standard_committed: "Forecasted",
};
// Consistent identity color per scenario -- used for the snapshot row
// marker AND (for full_capacity/standard_suggested/standard_committed)
// the task table's own Full/Capacity-Based/Forecasted column tint, so
// the same scheduling method always reads as the same color everywhere
// it shows up in the page. Phase 21: pulled from the shared
// SCENARIO_COLOR map instead of its own literal hex values, so there's
// only one place colors are defined.
const UTIL_PREVIEW_COLOR: Record<UtilPreviewMode, string> = {
  actual: "var(--muted)",
  full_capacity: SCENARIO_COLOR.full,
  standard_suggested: SCENARIO_COLOR.capacity_based,
  standard_committed: SCENARIO_COLOR.forecasted,
};

// Phase 3 (2026-07-28): status banner copy/colors for the Draft/Baseline/
// Revision/Final-Scope workflow. Deliberately reuses the app's existing
// --navy/--muted/--warning-text CSS vars rather than inventing new colors.
// WBS_STATUS_META moved to ../lib/wbsStatus (Phase 4, 2026-07-28) so the
// Projects page's WBS Status column can share the exact same labels/colors.

interface ChainEntry {
  start: string;
  end: string;
  durationDays: number;
  rawDays?: number;
  // Phase 7 (2026-08-21, Capacity-Based manual override): set when this
  // entry came from a manually-typed Start date rather than the
  // whole-queue Capacity-Based walk. suggestedStart/suggestedEnd carry
  // what Capacity-Based *would* have picked, purely for a deviation
  // badge -- the override always wins for the actual displayed/saved
  // start/end above.
  isOverridden?: boolean;
  suggestedStart?: string;
  suggestedEnd?: string;
  // Phase 19 (2026-08-24): set only when Manual mode's typed End date is
  // driving the span (rather than the flat 7.5h/day fallback) -- the
  // even-spread rate, purely for display (e.g. "5.0 h/day").
  avgHoursPerDay?: number;
}

const UTIL_WINDOW_DAYS = 28; // 4 weeks, daily view

// WBS planning page -- see project_capaciq_wbs_planning memory for the
// full design history across many rounds. Current shape (2026-07-24,
// round 7 -- Project Name/Owner + freely-editable per-task Start dates):
// - Per task: Estimated hours, Task name, Effort, Assignee, and now Start
//   date are all directly editable and autosave immediately, same
//   convention as the rest of the app.
// - End date is NOT typed -- it's computed from that same task's own
//   Start date, independently per task (no shared day-capacity ledger
//   between tasks -- Sandra confirmed this explicitly: two tasks can
//   freely overlap/run in parallel, the utilization panel below is where
//   over-allocation actually shows up, not a scheduling constraint here).
//   Full Effort uses a flat 7.5h/day rate, Conservative Effort a flat
//   4h/day rate -- both via the same `rateScenario` helper in
//   taskScheduling.ts.
// - A parent task's own Start/End/Est.hrs are all locked, computed from
//   its own sub-tasks (min start / max end / hours sum) -- never typed
//   directly, same rollup convention throughout.
// - The project's own Start date (shown at the top, and kept in sync with
//   `projects.start_date` for the rest of the app) is now DERIVED --
//   auto-pulled from the earliest top-level task's own Start date --
//   rather than being the thing tasks chain from. New tasks still default
//   their own Start to "the day after the previous task ends" purely as a
//   convenient starting point; it's a one-time seed, fully overridable.
// - Project Name and Owner are also directly editable here now. Owner
//   feeds the PM-overhead portion of the utilization heat-map below,
//   using this project's own (derived) Start-to-End span -- so picking an
//   Owner, or extending the schedule by adding tasks, fills in that
//   person's PM-overhead utilization live, before Save.
// - "Save" writes ONE active mode's computed End dates onto every task
//   (Start dates are already live/persisted per-task) and snapshots both
//   modes' numbers into task_planning_snapshots for reporting. Locking
//   timelines is only ever done from the Tasks page's own Lock button.
// - The Utilization snapshot panel (points/tier-based, same formula as
//   the Utilization page) shows a live "what happens if I plan this"
//   preview: every OTHER real task/project in the app counts as
//   committed, but for THIS project it uses whatever the active mode
//   currently computes -- so editing Start/Effort/Assignee/Owner updates
//   the heat-map instantly, before Save.
export default function WbsPlanning() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const { person: me } = useSession();
  const { confirm, alert, dialog } = useConfirm();
  const isFullAccess = me?.access_level === "full";

  const [project, setProject] = useState<ProjectRow | null>(null);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [people, setPeople] = useState<PersonRow[]>([]);
  // Work Types (Phase 12, 2026-08-20) -- fetched unfiltered (all rows) so
  // an already-assigned but since-deactivated Work Type still resolves to
  // its historical name here; the dropdown itself (below) filters to
  // is_active for NEW picks, same convention as `people`/is_active vs.
  // whatever a task's own historical assignee_id already points to.
  const [workTypes, setWorkTypes] = useState<WorkTypeOption[]>([]);
  const [outputTypes, setOutputTypes] = useState<OutputTypeOption[]>([]);
  // Task Type <-> Output Type conditional mapping (Phase 23, 2026-08-25) --
  // Sandra: "I want the output be conditional based on task type." Filters
  // the Output Type picker below to only what's allowed for the task's
  // current Work Type; falls back to every active Output Type if the task
  // has no Work Type set yet, or if that Work Type has no mapped rows at
  // all, so nothing goes unpickable.
  const [workTypeOutputTypes, setWorkTypeOutputTypes] = useState<{ work_type_id: string; output_type_id: string }[]>([]);
  const [availability, setAvailability] = useState<AvailabilityRow[]>([]);
  const wbsColWidthsRef = useRef<Record<string, number>>(
    (() => {
      try {
        const raw = localStorage.getItem(WBS_COL_WIDTHS_STORAGE_KEY);
        return raw ? (JSON.parse(raw) as Record<string, number>) : {};
      } catch {
        return {};
      }
    })()
  );
  const [wbsColWidthsVersion, setWbsColWidthsVersion] = useState(0);
  // Freeze panes (2026-08-26, Sandra: "allow freezing of panes in the WBS
  // table"; generalized 2026-08-27, Sandra: "can we pin any column, not
  // just Task") -- keeps the gutter + every column up to (and including)
  // the pinned one visible while scrolling right through the many Work
  // Type/Output/date-mode columns, Excel/Notion-style. Only one column
  // can be pinned at a time -- pinning a different column moves the
  // freeze point there (and un-pins whatever was pinned before);
  // clicking the currently-pinned column's own pin again turns freezing
  // off entirely. `null` means nothing is frozen. Persisted like column
  // widths (no server-side "saved views" concept for this page yet).
  const [wbsFreezeColKey, setWbsFreezeColKey] = useState<string | null>(() => {
    try {
      const raw = localStorage.getItem(WBS_FREEZE_COL_STORAGE_KEY);
      if (raw !== null) return raw === "" ? null : raw;
      // Migration fallback: an existing user's old "Task column frozen"
      // boolean pref (defaulted ON) carries forward as the Task column
      // being the pinned one, so nobody's freeze state silently resets.
      const legacyRaw = localStorage.getItem(WBS_FREEZE_STORAGE_KEY);
      return legacyRaw === null || legacyRaw === "1" ? "task" : null;
    } catch {
      return "task";
    }
  });
  function toggleWbsFreezeCol(colKey: string) {
    setWbsFreezeColKey((prev) => {
      const next = prev === colKey ? null : colKey;
      try {
        localStorage.setItem(WBS_FREEZE_COL_STORAGE_KEY, next ?? "");
      } catch {
        // ignore -- private browsing / storage full, toggle still works
        // for the rest of this session, it just won't persist
      }
      return next;
    });
  }
  // Gutter is a fixed 22px; the Task column's own width is whatever
  // wbsColWidth("task") currently resolves to (resizable) -- the frozen
  // Task column's sticky offset must track that live, not a constant.
  const wbsFrozenGutterW = 22;
  const wbsResizeState = useRef<{ key: string; startX: number; startWidth: number } | null>(null);
  // Utilization-snapshot Person column: resizable + always-frozen/sticky
  // (2026-08-26, Sandra: "can we have the ability to resize the person
  // name columns and freeze it too so we can scroll through the dates in
  // case we have a longer timeline") -- long person names get cramped in
  // a fixed 130px column; this lets Sandra widen it per her own
  // preference, persisted like the WBS table's own column widths. The
  // Scenario column and every date column's sticky-offset math below
  // read this live value instead of a hardcoded 130.
  const UTIL_PERSON_COL_STORAGE_KEY = "capaciq_util_person_col_w";
  const [utilPersonColW, setUtilPersonColW] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(UTIL_PERSON_COL_STORAGE_KEY);
      const n = raw ? Number(raw) : NaN;
      return Number.isFinite(n) && n >= 90 ? n : 130;
    } catch {
      return 130;
    }
  });
  // Read by the auto-scroll effect above WITHOUT being one of its
  // dependencies (see that effect's own comment) -- keeps the effect
  // from re-running, and yanking scrollLeft, on every drag frame.
  const utilPersonColWRef = useRef(utilPersonColW);
  useEffect(() => {
    utilPersonColWRef.current = utilPersonColW;
  }, [utilPersonColW]);
  // Bugfix (2026-08-26, Sandra: "still a bug when adjusting the person
  // name column -- the Scenario word moved in between the dates"): the
  // Scenario column's sticky `left` used to be set to the raw
  // utilPersonColW state -- the WIDTH SANDRA ASKED FOR, not necessarily
  // the column's true on-screen width. This table intentionally uses
  // table-layout:auto (see the NOTE above the <table> below -- fixed
  // layout broke Scenario's own width in a different way), and under
  // auto layout a long person name can still force the Person column
  // wider than its declared width/maxWidth even with overflow:hidden,
  // because auto layout's column-width algorithm considers cell content
  // regardless of overflow. Whenever that happened, Scenario's `left`
  // (still just utilPersonColW) fell short of the column's REAL right
  // edge, so Scenario visually overlapped/slid into the date grid --
  // most noticeable while dragging, since that's when Sandra is
  // watching this exact boundary. Fix: measure the Person column's
  // actual rendered width via ResizeObserver and use THAT for
  // Scenario's `left` instead of trusting the declared width blindly.
  //
  // Round 2 bugfix (2026-08-27, Sandra: "date columns are clipped --
  // looks like the Scenario column is too wide"): confirmed live
  // (getBoundingClientRect on the deployed page) that Chrome renders
  // BOTH sticky columns narrower than their declared width under this
  // table's auto layout (Person: declared 183px, real ~170px; Scenario:
  // declared 150px, real ~136px -- the same "Chrome quirk" noted above
  // the <table> below, just milder than the table-layout:fixed version
  // of it). That alone would be harmless -- the non-sticky date <th>s
  // that follow are positioned by ordinary table flow using the REAL
  // column widths regardless. The actual bug was in THIS measurement:
  // `entries[0].contentRect.width` reports the CONTENT-box width (i.e.
  // real width minus the 20px of left+right padding from `.data-table
  // th`), not the border-box width the column is actually painted at --
  // so even a correctly-firing observer would have fed Scenario's
  // `left` a value ~20px too small. Worse, a fresh ResizeObserver
  // attached directly to this sticky <th> was confirmed (live, via
  // devtools) to never fire a single notification -- so in production
  // `utilPersonRenderedW` never left its `useState(utilPersonColW)`
  // initializer at all, meaning Scenario's `left` used the bare
  // DECLARED width (183) instead of the real rendered one (~170), a
  // ~13px gap. Since the date columns start immediately after Scenario
  // in real, un-measured table flow, that 13px gap meant the sticky
  // Scenario column's true painted footprint extended ~13px further
  // right than code assumed -- covering the leading edge of the first
  // date column(s), which is exactly the "date columns clipped" bug:
  // the very first visible date header rendered as "8/04" with its
  // leading "0" painted over by the sticky Scenario overlay.
  //
  // Fix, two parts: (1) observe the <table> element itself, not the
  // sticky <th> -- a plain block-level element ResizeObserver reliably
  // fires for, unlike this sticky table cell -- and re-measure both
  // sticky columns' real getBoundingClientRect().width (border-box,
  // matching what's actually painted) whenever it fires or any
  // width-affecting dependency changes; also measure synchronously on
  // mount so there's a correct value before any observer callback ever
  // runs. (2) Apply the SAME measured-width approach to the Scenario
  // column (utilScenarioRenderedW) instead of leaving it as a bare `150`
  // constant everywhere downstream -- see the auto-scroll effect above,
  // which used to hardcode SCENARIO_COL_W = 150 for its sticky-offset
  // math despite the real column never actually rendering at 150.
  const utilPersonThRef = useRef<HTMLTableCellElement | null>(null);
  const utilScenarioThRef = useRef<HTMLTableCellElement | null>(null);
  const [utilPersonRenderedW, setUtilPersonRenderedW] = useState(utilPersonColW);
  const [utilScenarioRenderedW, setUtilScenarioRenderedW] = useState(150);
  // Round 5 bugfix (2026-08-27): found the REAL reason nothing above
  // ever took effect, in either the ResizeObserver or MutationObserver
  // form -- this whole measurement effect (like the ORIGINAL Person-only
  // version before it) used a plain `useRef` + `useEffect(..., [])`,
  // which only runs ONCE, on this component's very first commit. This
  // component has an early `if (loading) return ...` gate further down
  // (see the comment on the auto-scroll effect above), so on that FIRST
  // commit -- while the project/people data is still being fetched --
  // the whole Utilization snapshot panel, including this <table>, isn't
  // in the DOM at all yet. `utilSnapshotTableRef.current` was therefore
  // ALWAYS null the one time this effect ever ran, so it always hit its
  // `if (!tableEl) return` and never even created an observer -- not a
  // ResizeObserver/MutationObserver reliability problem at all, just a
  // mount-timing one. By the time `loading` flips to false and the real
  // table renders, the `[]`-deps effect never runs again to notice.
  // Fixed for real with a CALLBACK ref instead of useRef: React invokes
  // this the moment the <table> DOM node is actually attached (i.e. on
  // the render where `loading` has become false), which is exactly the
  // "mount" this measurement needs to react to -- and again with `null`
  // on unmount, when cleanup runs.
  const utilSnapshotObserverCleanupRef = useRef<(() => void) | null>(null);
  const utilSnapshotTableCallbackRef = useCallback((node: HTMLTableElement | null) => {
    if (utilSnapshotObserverCleanupRef.current) {
      utilSnapshotObserverCleanupRef.current();
      utilSnapshotObserverCleanupRef.current = null;
    }
    if (!node) return;
    function measure() {
      const personEl = utilPersonThRef.current;
      const scenarioEl = utilScenarioThRef.current;
      // getBoundingClientRect (border-box, actually-painted size) --
      // NOT ResizeObserver's contentRect, which excludes this table's
      // 20px of th/td horizontal padding and would under-report by
      // exactly that much.
      if (personEl) setUtilPersonRenderedW(personEl.getBoundingClientRect().width);
      if (scenarioEl) setUtilScenarioRenderedW(scenarioEl.getBoundingClientRect().width);
    }
    // React attaches child refs (the Person/Scenario <th> ones) before
    // it invokes a parent's ref callback, so utilPersonThRef/
    // utilScenarioThRef are already populated here -- this first
    // measure() runs synchronously against the real, already-laid-out
    // DOM, no extra frame needed.
    measure();
    // MutationObserver, not ResizeObserver: re-measures on the row
    // expand/collapse, scenario-visibility, and person-filter DOM
    // changes that actually alter the real column widths, without
    // depending on any of that state (several pieces of it --
    // expandedUtilPeople/visibleScenarios/utilPersonFilter -- aren't
    // declared until later in this component, so listing them as a dep
    // array here isn't an option anyway).
    const mo = new MutationObserver(measure);
    mo.observe(node, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
    window.addEventListener("resize", measure);
    utilSnapshotObserverCleanupRef.current = () => {
      mo.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  // Read by the auto-scroll effect below WITHOUT being one of its
  // dependencies (same reasoning as utilPersonColWRef above) -- these
  // update on every animation frame the ResizeObserver fires during a
  // Person-column drag, and depending on them directly would re-trigger
  // the scroll-jump bug that ref was already introduced to avoid.
  const utilPersonRenderedWRef = useRef(utilPersonRenderedW);
  useEffect(() => {
    utilPersonRenderedWRef.current = utilPersonRenderedW;
  }, [utilPersonRenderedW]);
  const utilScenarioRenderedWRef = useRef(utilScenarioRenderedW);
  useEffect(() => {
    utilScenarioRenderedWRef.current = utilScenarioRenderedW;
  }, [utilScenarioRenderedW]);
  const utilPersonResizeState = useRef<{ startX: number; startWidth: number; latest: number } | null>(null);
  function startUtilPersonColResize(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    utilPersonResizeState.current = { startX: e.clientX, startWidth: utilPersonColW, latest: utilPersonColW };
    function onMove(ev: MouseEvent) {
      if (!utilPersonResizeState.current) return;
      const delta = ev.clientX - utilPersonResizeState.current.startX;
      const newWidth = Math.max(90, utilPersonResizeState.current.startWidth + delta);
      utilPersonResizeState.current.latest = newWidth;
      setUtilPersonColW(newWidth);
    }
    function onUp() {
      if (utilPersonResizeState.current) {
        try {
          localStorage.setItem(UTIL_PERSON_COL_STORAGE_KEY, String(utilPersonResizeState.current.latest));
        } catch {
          // ignore -- private browsing / storage full, resizing still
          // works for the rest of this session, it just won't persist
        }
      }
      utilPersonResizeState.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }
  const [holidays, setHolidays] = useState<HolidayRow[]>([]);
  // Cross-project data, fetched ONLY for the utilization heat-map -- a
  // person's real workload includes every task/project they're on, not
  // just this one, so the "does this person have room" question can't be
  // answered from this project's own tasks alone.
  const [allTasks, setAllTasks] = useState<UtilTaskRow[]>([]);
  const [allProjects, setAllProjects] = useState<UtilProjectRow[]>([]);
  const [dependencies, setDependencies] = useState<DependencyRow[]>([]);
  // Sandra, 2026-07-29: Spent Hrs (actual logged time) shown alongside
  // Est. hrs in the WBS task table -- same rollup helper/shape as the
  // main Projects & Tasks page's own Spent Hrs column.
  const [timeEntries, setTimeEntries] = useState<TimeEntryRow[]>([]);
  const [depPickerOpenFor, setDepPickerOpenFor] = useState<string | null>(null);
  // Grip-handle drag reorder (Sandra, 2026-07-28): constrained to siblings
  // -- a top-level task can only reorder among other top-level tasks, a
  // sub-task only among its own parent's other sub-tasks. Purely visual
  // (sort_order) -- does NOT touch Start/End dates on its own; pair with
  // the Refresh dates button below to re-seed dates from the new order.
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [dragOverTaskId, setDragOverTaskId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Phase 21 (2026-08-24): Sandra -- "when saving there should no longer
  // be an option to choose which effort will be used, it will always
  // capture the planned one." Save (and Baseline/Closure requests) now
  // always operate on Forecasted ("manual" wire value) -- the mode where
  // a real committed date can be typed, i.e. the actual plan. This used
  // to be a user-facing picker (setActiveMode via InlineSelect); the
  // picker is removed and this is now a fixed constant, not state.
  const activeMode: Mode = "manual";
  // Separate from `activeMode` (Sandra, 2026-07-28: split the old shared
  // toggle apart) -- this one only drives the Utilization snapshot
  // preview below; `activeMode` is now purely "which mode Save/Scoping
  // Effort points at." Both Gantts render always, unconditionally, so
  // neither state drives Gantt selection anymore.
  // Phase 10: no longer a single selected preview -- all 4 scenarios
  // render simultaneously as rows now, see effectiveForMode below.
  const [saving, setSaving] = useState(false);
  const [utilWindowOffset, setUtilWindowOffset] = useState(0); // in units of UTIL_WINDOW_DAYS blocks
  // Auto-scroll-to-today (2026-08-25): Sandra reported losing sight of a
  // date column in this panel between two browser zoom levels. The date
  // range itself is pure math (anchor + offset), unaffected by zoom -- but
  // the panel's horizontal scroll container previously always opened at
  // scrollLeft 0 (the window's leftmost date), so at a narrower effective
  // width today's column (or any column past the fold) could sit out of
  // view with no indication anything was scrollable. This ref+effect
  // scrolls today into view whenever it's in the currently-displayed
  // window, regardless of viewport width/zoom -- a global fix rather than
  // a zoom-specific one, since zoom can't reliably be detected or tested.
  const utilSnapshotScrollRef = useRef<HTMLDivElement>(null);

  // Phase 11 (2026-08-21): Sandra's snapshot display controls -- reuse
  // the exact same computed points/capacity/tier everywhere below, these
  // three only decide what's shown and to whom, never how it's computed.
  const [utilShowHours, setUtilShowHours] = useState(true);
  // Phase 21 (2026-08-24): replaces the single Full-Effort-only toggle
  // with the centralized 3-scenario checkbox set -- same state now
  // drives BOTH the Utilization snapshot rows below and the Timeline
  // (Gantt) sections further down the page. Defaults to all 3 visible
  // (unchanged default behavior).
  const [visibleScenarios, setVisibleScenarios] = useState<Set<ScenarioKey>>(new Set(SCENARIO_ORDER));
  // null = no filter applied yet (show everyone) -- once the user picks
  // from the popover this becomes an explicit allow-list.
  const [utilPersonFilter, setUtilPersonFilter] = useState<Set<string> | null>(null);
  const [utilPersonFilterOpen, setUtilPersonFilterOpen] = useState(false);
  const [utilPersonSearch, setUtilPersonSearch] = useState("");
  // Collapsed by default per person -- "View scenarios" expands one at a
  // time so a big roster doesn't render as one giant always-open table.
  const [expandedUtilPeople, setExpandedUtilPeople] = useState<Set<string>>(new Set());

  // Phase 2/3 workflow state.
  const [activeRevision, setActiveRevision] = useState<RevisionRow | null>(null);
  const [pendingClosure, setPendingClosure] = useState<ClosureRequestRow | null>(null);
  // Phase 6 (2026-08-21): Baseline Approval workflow, replacing the manual
  // Start Revision / Apply Revision / Discard Revision cycle -- see
  // [[project_capaciq_phase6_baseline_approval]]. One request type covers
  // both the first-ever Lock Baseline (from Draft) and any later
  // re-baseline (from Baseline Locked / Changed After Baseline).
  const [pendingBaselineRequest, setPendingBaselineRequest] = useState<BaselineRequestRow | null>(null);
  // Session-staged edits (Phase 6): every field commit now merges into
  // these maps instead of writing to Supabase immediately -- Save (below)
  // is what actually flushes them. `hasUnsavedChanges` drives both the
  // Save button's own affordance and useUnsavedChangesGuard's
  // leave-without-saving prompt.
  const pendingTaskPatches = useRef<Map<string, Partial<TaskRow>>>(new Map());
  const pendingProjectPatch = useRef<Partial<ProjectRow>>({});
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  // Phase 5 (2026-07-28): shown next to the status banner so it's clear
  // which baseline version Compare-with-Baseline/variance are measuring
  // against, e.g. after a re-baseline event.
  const [activeBaseline, setActiveBaseline] = useState<ActiveBaselineRow | null>(null);
  const [workflowBusy, setWorkflowBusy] = useState(false);
  // Actions menu (2026-08-27, Sandra: "is it possible to remove the
  // request for baseline approval at the top? can we just add an
  // action button instead and from there pick Re-Baseline and Close
  // project") -- consolidates the top status banner's separate
  // workflow buttons (previously just the single Request/Re-baseline
  // Approval button) plus the bottom status bar's Close Project button
  // into one menu, so there's a single place to look for "what can I
  // do to this project's workflow right now" instead of buttons
  // scattered across two banners. Same handlers, same visibility
  // conditions as before -- placement/consolidation only, not a
  // behavior change.
  const [wbsActionsMenuOpen, setWbsActionsMenuOpen] = useState(false);
  const [revisionHistory, setRevisionHistory] = useState<RevisionRow[]>([]);
  const [revisionChangesById, setRevisionChangesById] = useState<Record<string, RevisionChangeRow[]>>({});
  const [expandedRevisionId, setExpandedRevisionId] = useState<string | null>(null);
  // Start Date change requests (2026-08-26) -- removed 2026-08-27 per
  // Sandra: "We will not change start date in task level individually.
  // The start date can only be changed in re-baselines." The per-task
  // request+approval UI (RequestStartDateModal, the clock-icon pin, and
  // the sidebar history panel) is gone; `enforce_start_date_lock` and the
  // `extension_requests` rows/RPC branch for request_type='start_date'
  // are left in place in Postgres (unused, not dropped) -- the DB lock on
  // start_date_standard once baseline is locked remains the safety net,
  // it's just no longer escapable from the UI. Start dates now change
  // only via Re-baseline.
  // Design spec item 7 (Sandra, 2026-07-29): task-list Changes/Notes
  // columns and the Revision Summary panel both read from the SAME
  // latest-applied-revision's change log (decision #1 in
  // [[project_capaciq_wbs_ui_redesign_plan]]: reuse the already-existing
  // per-revision project_revision_changes diff, latest revision only --
  // not new per-field diff-scoring against the original baseline).
  const [latestRevisionChanges, setLatestRevisionChanges] = useState<RevisionChangeRow[]>([]);
  // Sandra, 2026-07-29: "task 5 has been added in v4... I made changes
  // to the hours in v10... isn't the increase supposed to show?" --
  // taskBaselineDiff() below used to stop at "New task" forever for any
  // task added after the baseline, because there's no baseline row to
  // diff its hours against. That silently hid every real edit made to
  // that task in later revisions. This holds the FULL change history
  // (all revisions, not just the last-5 preload used by Revision
  // History) grouped by task_id, so taskBaselineDiff can check "has
  // anything actually changed on this task SINCE it was added" and
  // surface that instead of a stale "New task" tag.
  const [changesByTaskId, setChangesByTaskId] = useState<Record<string, RevisionChangeRow[]>>({});
  const [baselineTasksById, setBaselineTasksById] = useState<Record<string, BaselineTaskFull>>({});

  async function loadAll(silent = false) {
    if (!projectId) return;
    // Sandra, 2026-08-24: "adding a new task ... does not seem to glitch or
    // refresh and go back at the top of the page" -- loadAll() unconditionally
    // flipping `loading` true/false unmounts the entire page behind a bare
    // "Loading..." div (see the `if (loading) return ...` guard below), which
    // resets scroll to top and reads as a full-page flicker. Background
    // refreshes triggered by in-place actions (add/delete task, etc.) now
    // pass silent=true to skip that full-page loading flash entirely --
    // state still updates underneath, but the page never unmounts.
    if (!silent) setLoading(true);
    const [{ data: proj }, { data: tks }, { data: ppl }, { data: avail }, { data: hols }, { data: allTks }, { data: allProjs }, { data: wts }, { data: ots }, { data: wtots }] = await Promise.all([
      supabase.from("projects").select("id,name,owner_id,start_date,end_date,timelines_locked,phase,status,scoping_effort_mode,wbs_status,category,source_id,priority,effort_level").eq("id", projectId).single(),
      supabase
        .from("tasks")
        .select(
          "id,project_id,parent_task_id,name,assignee_id,status,start_date,start_date_full,start_date_standard,start_full_auto,start_standard_auto,manual_end_date,current_due_date,estimated_hours,effort,work_type_id,output_type_id,output_count,is_archived,sort_order"
        )
        .eq("project_id", projectId)
        .eq("is_archived", false)
        .order("sort_order"),
      supabase.from("people").select("id,name,daily_capacity_hours,is_active,color").eq("is_active", true).order("name"),
      supabase.from("person_availability").select("person_id,date,status"),
      supabase.from("holidays").select("date"),
      supabase.from("tasks").select("id,project_id,parent_task_id,assignee_id,status,start_date,current_due_date,estimated_hours,effort,sort_order,work_type_id").eq("is_archived", false),
      supabase.from("projects").select("id,owner_id,start_date,end_date,wbs_status").eq("is_archived", false),
      supabase.from("work_types").select("id,name,is_active,sort_order,is_fixed_schedule").order("sort_order"),
      supabase.from("output_types").select("id,name,is_active,sort_order").order("sort_order"),
      supabase.from("work_type_output_types").select("work_type_id,output_type_id"),
    ]);
    setProject((proj as ProjectRow) ?? null);
    // Phase 21 (2026-08-24): activeMode is now a fixed constant
    // ("manual"/Forecasted, always), not state -- no more seeding needed
    // here. See the activeMode declaration above for why.
    setTasks((tks as TaskRow[]) ?? []);
    setPeople((ppl as PersonRow[]) ?? []);
    setAvailability((avail as AvailabilityRow[]) ?? []);
    setHolidays((hols as HolidayRow[]) ?? []);
    setAllTasks((allTks as UtilTaskRow[]) ?? []);
    setAllProjects((allProjs as UtilProjectRow[]) ?? []);
    setWorkTypes((wts as WorkTypeOption[]) ?? []);
    setOutputTypes((ots as OutputTypeOption[]) ?? []);
    setWorkTypeOutputTypes((wtots as { work_type_id: string; output_type_id: string }[]) ?? []);

    // Dependencies are same-project only (v1), so fetched as a follow-up
    // query scoped to this project's own task ids, once they're known --
    // can't be folded into the Promise.all above since it needs the task
    // id list first.
    const taskIds = ((tks as TaskRow[]) ?? []).map((t) => t.id);
    if (taskIds.length) {
      const [{ data: deps }, { data: entries }] = await Promise.all([
        supabase.from("task_dependencies").select("task_id,depends_on_task_id").in("task_id", taskIds),
        supabase.from("time_entries").select("*").in("task_id", taskIds).in("status", ["confirmed", "approved"]),
      ]);
      setDependencies((deps as DependencyRow[]) ?? []);
      setTimeEntries((entries as TimeEntryRow[]) ?? []);
    } else {
      setDependencies([]);
      setTimeEntries([]);
    }

    const [{ data: revRow }, { data: closureRow }, { data: baselineRow }, { data: baselineReqRow }] = await Promise.all([
      supabase
        .from("project_revisions")
        .select("id,revision_number,reason,status,started_at")
        .eq("project_id", projectId)
        .eq("status", "in_progress")
        .maybeSingle(),
      supabase
        .from("project_closure_requests")
        .select("id,status,requested_at,requested_by")
        .eq("project_id", projectId)
        .eq("status", "pending")
        .maybeSingle(),
      supabase
        .from("project_baselines")
        .select("version_number,captured_at")
        .eq("project_id", projectId)
        .eq("is_active", true)
        .maybeSingle(),
      // Phase 6: pending Baseline Approval request, if any -- mirrors the
      // pendingClosure query above, just against the new table.
      supabase
        .from("project_baseline_requests")
        .select("id,status,requested_at,requested_by")
        .eq("project_id", projectId)
        .eq("status", "pending")
        .maybeSingle(),
    ]);
    setActiveRevision((revRow as RevisionRow) ?? null);
    setPendingClosure((closureRow as ClosureRequestRow) ?? null);
    setActiveBaseline((baselineRow as ActiveBaselineRow) ?? null);
    setPendingBaselineRequest((baselineReqRow as BaselineRequestRow) ?? null);
    if (baselineRow) {
      loadLatestRevisionChanges();
      loadBaselineTaskSnapshot();
    }
    // Design spec item 6 follow-up (Sandra, 2026-07-29): Revision Summary
    // + Revision History now live permanently in the right rail instead
    // of behind an Actions-menu toggle, so this loads unconditionally
    // (cheap -- just an empty list on a Draft project with no revisions).
    loadRevisionHistory();

    if (!silent) setLoading(false);
  }

  async function loadRevisionHistory() {
    if (!projectId) return;
    const { data } = await supabase
      .from("project_revisions")
      .select("id,revision_number,reason,status,started_at")
      .eq("project_id", projectId)
      .order("revision_number", { ascending: false });
    const revs = (data as RevisionRow[]) ?? [];
    setRevisionHistory(revs);
    // Sandra, 2026-07-29 follow-up: the right rail's Revision History now
    // shows each revision's Impact inline (last 5) without a click-to-
    // expand step, so preload their changes here instead of lazily on
    // click (toggleRevisionExpand below still works the same way for any
    // revision not covered by this preload, e.g. beyond the top 5).
    const last5 = revs.slice(0, 5);
    if (last5.length > 0) {
      const { data: changeRows } = await supabase
        .from("project_revision_changes")
        .select("id,revision_id,task_id,task_name,change_type,field,previous_value,new_value")
        .in(
          "revision_id",
          last5.map((r) => r.id)
        );
      const byRevision: Record<string, RevisionChangeRow[]> = {};
      for (const c of (changeRows as RevisionChangeRow[]) ?? []) {
        const key = c.revision_id ?? "";
        const list = byRevision[key] ?? [];
        list.push(c);
        byRevision[key] = list;
      }
      setRevisionChangesById((prev) => ({ ...prev, ...byRevision }));
    }

    // Full history across EVERY revision (not just the last 5 above) --
    // needed so a task added several revisions ago (e.g. V4) still shows
    // its later edits (e.g. an hours change made at V10) instead of a
    // stale "New task" tag. See changesByTaskId's own doc comment.
    if (revs.length > 0) {
      const { data: allChangeRows } = await supabase
        .from("project_revision_changes")
        .select("id,revision_id,task_id,task_name,change_type,field,previous_value,new_value,changed_at")
        .in(
          "revision_id",
          revs.map((r) => r.id)
        );
      const byTask: Record<string, RevisionChangeRow[]> = {};
      for (const c of (allChangeRows as RevisionChangeRow[]) ?? []) {
        const list = byTask[c.task_id] ?? [];
        list.push(c);
        byTask[c.task_id] = list;
      }
      setChangesByTaskId(byTask);
    } else {
      setChangesByTaskId({});
    }
  }

  // Feeds the task list's Changes/Notes columns and the Revision Summary
  // panel -- the latest APPLIED revision's own diff log, not a fresh
  // baseline-vs-current computation. Empty on Draft (no revisions yet)
  // and while a revision is still in_progress (nothing "latest and
  // applied" to show notes for until it's applied).
  // Design spec item 4 follow-up: full per-task snapshot of the ACTIVE
  // baseline, keyed by task_id -- feeds the task list's Changes/Notes
  // columns (current vs Baseline V<n>), separate from
  // loadLatestRevisionChanges() above (which only covers the latest
  // applied revision, used for the Revision Summary panel).
  async function loadBaselineTaskSnapshot() {
    if (!projectId) return;
    const { data: activeBl } = await supabase
      .from("project_baselines")
      .select("id")
      .eq("project_id", projectId)
      .eq("is_active", true)
      .maybeSingle();
    if (!activeBl) {
      setBaselineTasksById({});
      return;
    }
    const { data } = await supabase
      .from("project_baseline_tasks")
      .select("task_id,estimated_hours,assignee_name,depends_on,end_date_full,end_date_standard")
      .eq("baseline_id", (activeBl as { id: string }).id);
    const byId: Record<string, BaselineTaskFull> = {};
    for (const row of (data as BaselineTaskFull[]) ?? []) {
      byId[row.task_id] = row;
    }
    setBaselineTasksById(byId);
  }

  async function loadLatestRevisionChanges() {
    if (!projectId) return;
    const { data: latestRev } = await supabase
      .from("project_revisions")
      .select("id")
      .eq("project_id", projectId)
      .eq("status", "applied")
      .order("revision_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!latestRev) {
      setLatestRevisionChanges([]);
      return;
    }
    const { data } = await supabase
      .from("project_revision_changes")
      .select("id,task_id,task_name,change_type,field,previous_value,new_value")
      .eq("revision_id", (latestRev as { id: string }).id);
    setLatestRevisionChanges((data as RevisionChangeRow[]) ?? []);
  }

  async function toggleRevisionExpand(revisionId: string) {
    if (expandedRevisionId === revisionId) {
      setExpandedRevisionId(null);
      return;
    }
    setExpandedRevisionId(revisionId);
    if (!revisionChangesById[revisionId]) {
      const { data } = await supabase
        .from("project_revision_changes")
        .select("id,task_id,task_name,change_type,field,previous_value,new_value")
        .eq("revision_id", revisionId)
        .order("changed_at");
      setRevisionChangesById((prev) => ({ ...prev, [revisionId]: (data as RevisionChangeRow[]) ?? [] }));
    }
  }

  function dependsOnIdsFor(taskId: string): string[] {
    return dependencies.filter((d) => d.task_id === taskId).map((d) => d.depends_on_task_id);
  }

  // Sandra, 2026-07-24: found live that setting "Task 2 depends on Task 1"
  // didn't move Task 2's Start at all -- v1 (Round 9) deliberately kept
  // Start fully manual with only a warning. Round 10 tried auto-moving a
  // single shared Start field, but that broke down the moment BOTH modes
  // needed to be correct at once: Task 1 finishes on a different date
  // under Full Effort vs Conservative Effort, so one shared Start could
  // only ever be "right after" one of them. Round 11 fix (her own
  // diagnosis: "I think the toggle on top cause the issue"): Full Effort
  // and Conservative Effort now each get their OWN Start field
  // (`start_date_full`/`start_date_standard`), each auto-moved
  // independently -- this computes the latest "day after a predecessor's
  // own End" across ALL of a task's dependencies, for ONE given mode. Used
  // only as a one-time default the moment a dependency is added (not a
  // continuous rollup), so both fields stay completely normal, freely
  // editable afterward. If the user later edits either into a conflict,
  // `dependencyConflict` (mode-parameterized, checked against that SAME
  // mode's own Start field) catches it.
  // Phase 20 (2026-08-24, Sandra: "in the full effort, can you make sure
  // that math is done properly, always assume a full day of 7.5 hours --
  // if there are 2 tasks that is set at 3 hours each, this can still be
  // done in one day"): Full Effort previously always chained a task to
  // the NEXT working day after whatever it follows, regardless of how
  // much of that day's assumed 7.5h was actually left -- two 3-hour tasks
  // got pushed onto two separate days instead of packing into one. These
  // two helpers give Full Effort real same-day packing: sum up every
  // OTHER same-level task (root siblings, or one parent's own children --
  // whichever scope this task belongs to) that already lands entirely on
  // a given date, and only roll to the next working day if the new
  // task's own hours would not actually fit in what's left. Scoped to
  // full_capacity only -- Capacity-Based already does real per-person
  // capacity-aware queueing via buildForwardSchedule, and Manual's Start
  // is either a live mirror of that or a frozen human override, neither
  // of which this flat-rate assumption applies to.
  function sameLevelScope(taskId: string): (TaskRow & { depth: number })[] {
    const t = orderedTasks.find((x) => x.id === taskId);
    if (!t) return [];
    return t.depth === 0
      ? orderedTasks.filter((x) => x.depth === 0)
      : orderedTasks.filter((x) => x.depth === 1 && x.parent_task_id === t.parent_task_id);
  }
  function remainingFullEffortHours(dateStr: string, scope: TaskRow[], excludeTaskId?: string): number {
    let used = 0;
    for (const s of scope) {
      if (s.id === excludeTaskId) continue;
      const entry = chainByMode.full_capacity.get(s.id);
      if (entry && entry.start === dateStr && entry.end === dateStr) used += s.estimated_hours ?? 0;
    }
    return Math.max(0, FULL_CAPACITY_DAILY_HOURS - used);
  }
  function packedFullEffortNextStart(predecessorEnd: string, newHours: number, scope: TaskRow[], excludeTaskId?: string): string {
    const remaining = remainingFullEffortHours(predecessorEnd, scope, excludeTaskId);
    if (newHours <= remaining) return predecessorEnd; // packs into the same day
    return nextWorkingDayAfter(predecessorEnd, holidaySet);
  }

  function suggestedStartFor(depIds: string[], mode: Mode, forTaskId?: string): string | null {
    let latest: string | null = null;
    for (const depId of depIds) {
      const entry = chainByMode[mode].get(depId);
      if (!entry) continue;
      const candidate =
        mode === "full_capacity" && forTaskId
          ? packedFullEffortNextStart(entry.end, tasks.find((x) => x.id === forTaskId)?.estimated_hours ?? 0, sameLevelScope(forTaskId), forTaskId)
          : nextWorkingDayAfter(entry.end, holidaySet);
      if (!latest || candidate > latest) latest = candidate;
    }
    return latest;
  }

  async function addDependency(taskId: string, dependsOnId: string) {
    // Basic guard against an immediate two-way cycle (A depends on B, which
    // already depends on A). Longer cycles aren't checked in this v1 --
    // acceptable given the small task counts these projects run at, but a
    // real limitation if this ever needs to be bulletproof.
    if (dependsOnIdsFor(dependsOnId).includes(taskId)) {
      await alert("Can't add this -- it would create a circular dependency (that task already depends on this one).");
      return;
    }
    setDependencies((prev) => [...prev, { task_id: taskId, depends_on_task_id: dependsOnId }]);
    const { error } = await supabase.from("task_dependencies").insert({ task_id: taskId, depends_on_task_id: dependsOnId });
    if (error) {
      await alert(`Couldn't add dependency: ${error.message}`);
      loadAll();
      return;
    }
    const allDeps = [...dependsOnIdsFor(taskId), dependsOnId];
    const patch: Partial<TaskRow> = {};
    const suggestedFull = suggestedStartFor(allDeps, "full_capacity", taskId);
    if (suggestedFull) {
      patch.start_date_full = suggestedFull;
      patch.start_full_auto = true; // fresh dependency -- start tracking it live again
    }
    const suggestedStandard = suggestedStartFor(allDeps, "standard");
    if (suggestedStandard) {
      patch.start_date_standard = suggestedStandard;
      patch.start_standard_auto = true;
    }
    if (Object.keys(patch).length) saveTaskField(taskId, patch);
  }

  async function removeDependency(taskId: string, dependsOnId: string) {
    setDependencies((prev) => prev.filter((d) => !(d.task_id === taskId && d.depends_on_task_id === dependsOnId)));
    const { error } = await supabase.from("task_dependencies").delete().eq("task_id", taskId).eq("depends_on_task_id", dependsOnId);
    if (error) {
      await alert(`Couldn't remove dependency: ${error.message}`);
      loadAll();
    }
  }

  // Conflict check for the currently active mode: this task's own Start
  // (as scheduled under `mode`) falls on or before a predecessor's own End
  // under that SAME mode -- i.e. the predecessor isn't actually finished
  // yet by the time this task starts. Returns the worst-offending
  // predecessor (latest End) so the tooltip can name it.
  function dependencyConflict(t: TaskRow, mode: Mode): { name: string; end: string } | null {
    const ownEntry = chainByMode[mode].get(t.id);
    if (!ownEntry) return null;
    let worst: { name: string; end: string } | null = null;
    for (const depId of dependsOnIdsFor(t.id)) {
      const depEntry = chainByMode[mode].get(depId);
      if (!depEntry) continue;
      if (ownEntry.start <= depEntry.end) {
        if (!worst || depEntry.end > worst.end) {
          const depTask = tasks.find((x) => x.id === depId);
          worst = { name: depTask?.name ?? "a predecessor", end: depEntry.end };
        }
      }
    }
    return worst;
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const holidaySet = buildHolidaySet(holidays.map((h) => h.date));
  const today = toISO(new Date());
  // Fallback only -- used to seed the very first task's default Start
  // (and the header display) before any task has its own Start date yet.
  const fallbackStartDate = project?.start_date ? project.start_date.slice(0, 10) : new Date().toISOString().slice(0, 10);

  // Parent tasks first, each followed immediately by its own sub-tasks --
  // same 2-level nesting the Projects table uses elsewhere. Relies on
  // `tasks` already coming back sorted by sort_order from the query above
  // (Sandra, 2026-07-24: "when adding task the new untitled task gets in
  // the middle of the task list" -- the query had no explicit order
  // clause before, so Postgres returned rows in whatever physical order
  // they happened to be stored in, NOT creation order. Explicit
  // `.order("sort_order")` fixes this the same way Projects.tsx's own
  // Tasks query already does).
  // Round 20 (Sandra: "grip movement works but only reflects upon
  // refresh -- if I move the bottom task one row above, it doesn't move
  // real time"). Root cause: this used to rely entirely on `tasks`
  // already arriving pre-sorted by `sort_order` from the initial fetch
  // (`.order("sort_order")` in loadAll) -- true on page load, but
  // `reorderTask`'s own optimistic `setTasks((prev) => prev.map(...))`
  // only updates each row's `sort_order` VALUE in place, it doesn't
  // reorder the underlying array itself, so the on-screen row order
  // didn't change until the next full reload re-fetched (and re-sorted)
  // from the DB. Sorting explicitly by `sort_order` here -- exactly like
  // the Projects & Tasks page's own table already does -- makes the
  // drop feel instant instead of needing a refresh, and is harmless on
  // page load too (the fetch is already sorted, so this is a no-op then).
  function computeOrderedTasks(): (TaskRow & { depth: number })[] {
    const bySortOrder = (a: TaskRow, b: TaskRow) => (a.sort_order ?? 0) - (b.sort_order ?? 0);
    const roots = tasks.filter((t) => !t.parent_task_id).sort(bySortOrder);
    const out: (TaskRow & { depth: number })[] = [];
    for (const r of roots) {
      out.push({ ...r, depth: 0 });
      for (const c of tasks.filter((t) => t.parent_task_id === r.id).sort(bySortOrder)) out.push({ ...c, depth: 1 });
    }
    return out;
  }
  const orderedTasks = computeOrderedTasks();

  function hasChildren(taskId: string): boolean {
    return tasks.some((t) => t.parent_task_id === taskId);
  }

  // Actual logged time (own + every descendant's), same rollup as the
  // Projects & Tasks page's Spent Hrs column.
  function spentHoursFor(taskId: string): number {
    return rollupHoursFor(taskId, timeEntries, (id) => tasks.filter((t) => t.parent_task_id === id).map((t) => t.id));
  }

  // Small status glyph shown next to the task Name in the WBS table --
  // Sandra, 2026-07-29: "even just symbols... gray circle not started,
  // in progress yellow arrow, green check if done."
  function statusGlyph(status: string | null) {
    if (status === "Done") return { Icon: CheckCircle2, color: "var(--success-text)", title: "Done" };
    if (status === "In Progress") return { Icon: Clock, color: "var(--warning-text)", title: "In Progress" };
    return { Icon: Circle, color: "var(--muted)", title: "Not Started" };
  }

  // Same rollup rule as the Projects & Tasks page -- a parent task's own
  // Est. hrs is locked and always mirrors the sum of its direct
  // sub-tasks' Est. hrs, never typed directly. Duplicated here (rather
  // than imported from Projects.tsx) since this page has its own separate
  // `tasks` state/query.
  function subtaskHoursSum(parentId: string): number | null {
    const children = tasks.filter((t) => t.parent_task_id === parentId);
    const withEstimate = children.filter((t) => t.estimated_hours !== null && t.estimated_hours !== undefined);
    if (withEstimate.length === 0) return null;
    return Math.round(withEstimate.reduce((sum, t) => sum + (t.estimated_hours ?? 0), 0) * 100) / 100;
  }

  // Same idea, for Start date -- a parent's own Start is locked and
  // mirrors the EARLIEST of its direct sub-tasks' own Start dates (its
  // End mirrors the latest, computed live in buildChain below since End
  // isn't a stored field until Save). Round 11: Start is now three
  // separate fields (legacy `start_date` for the rest of the app, plus
  // `start_date_full`/`start_date_standard` for each mode's own draft) --
  // this rolls up whichever field is asked for.
  function subtaskStartMinField(parentId: string, field: "start_date" | "start_date_full" | "start_date_standard"): string | null {
    const children = tasks.filter((t) => t.parent_task_id === parentId);
    const withStart = children.filter((t) => !!t[field]);
    if (withStart.length === 0) return null;
    return withStart.reduce((min, t) => {
      const v = (t[field] as string).slice(0, 10);
      return v < min ? v : min;
    }, (withStart[0][field] as string).slice(0, 10));
  }

  // Parent-task Assignee rollup (Sandra, 2026-07-28): a parent's own
  // Assignee used to be a fully independent field, decoupled from its
  // children -- same gap Est. hrs had before its own rollup. That's a
  // real double-counting risk for utilization: if a parent happened to
  // carry its own Assignee+Effort, its points landed on top of its
  // children's, even though the parent's own span is just the union of
  // theirs. Fixed the same way Est. hrs already works: derived, locked,
  // never typed directly. "Multiple" is a display-only state (children
  // assigned to 2+ different people) -- never written to `assignee_id`
  // itself, which stays null in that case (or null for zero-assignee
  // children too).
  function parentAssigneeState(parentId: string): { id: string | null; multiple: boolean } {
    const children = tasks.filter((t) => t.parent_task_id === parentId);
    const ids = Array.from(new Set(children.map((t) => t.assignee_id).filter((id): id is string => !!id)));
    if (ids.length === 1) return { id: ids[0], multiple: false };
    if (ids.length > 1) return { id: null, multiple: true };
    return { id: null, multiple: false };
  }

  useEffect(() => {
    for (const t of tasks) {
      if (t.parent_task_id) continue;
      if (!hasChildren(t.id)) continue;
      // Bugfix (2026-08-27, Sandra: false "Done task locked" error on
      // Close Project / Request Baseline Approval): this rollup used to
      // run for every parent regardless of its own status. A Done parent
      // is locked server-side (enforce_done_task_lock trigger) against
      // writes to exactly these scoping fields -- if a Done parent's
      // computed rollup ever drifted from its stored value (e.g. a child
      // task's hours/start/assignee changed after the parent was marked
      // Done), this silently staged a patch into pendingTaskPatches that
      // the NEXT flushPendingEdits() call -- fired by totally unrelated
      // actions like Close Project or Request Baseline Approval -- would
      // then try to write, tripping the DB lock trigger even though
      // neither action needed to touch task fields at all. Skipping Done
      // parents here stops the patch from ever being staged in the first
      // place; this does not affect the normal Done-task edit lock UI,
      // which is enforced separately.
      if (t.status === "Done") continue;
      const sum = subtaskHoursSum(t.id);
      const minLegacy = subtaskStartMinField(t.id, "start_date");
      const minFull = subtaskStartMinField(t.id, "start_date_full");
      const minStandard = subtaskStartMinField(t.id, "start_date_standard");
      const patch: Partial<TaskRow> = {};
      if (sum !== t.estimated_hours) patch.estimated_hours = sum;
      if (minLegacy !== (t.start_date ? t.start_date.slice(0, 10) : null)) patch.start_date = minLegacy;
      if (minFull !== (t.start_date_full ? t.start_date_full.slice(0, 10) : null)) patch.start_date_full = minFull;
      if (minStandard !== (t.start_date_standard ? t.start_date_standard.slice(0, 10) : null)) patch.start_date_standard = minStandard;
      const { id: rolledUpAssignee } = parentAssigneeState(t.id);
      if (rolledUpAssignee !== t.assignee_id) patch.assignee_id = rolledUpAssignee;
      if (Object.keys(patch).length > 0) saveTaskField(t.id, patch);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  // Round 12 (Sandra): "when i change the est hours for a task ... the end
  // date of that task has moved, but the dependency date did not move
  // though a warning shown. Workaround for now was to manually tick and
  // untick the task dependency." Round 10/11's auto-move only ever fired
  // ONCE, at the moment a dependency was added -- editing the predecessor
  // afterward (more hours, a different Effort, its own Start moved) changed
  // ITS OWN End but never re-touched the dependent task's already-set
  // Start. Fixed by keeping each mode's Start "on auto-pilot"
  // (`start_full_auto`/`start_standard_auto`, migration 2026-07-24g) until
  // the user directly edits that field themselves (see `renderModeCells`'
  // onCommit below, which flips the flag off) -- while on auto-pilot, this
  // effect keeps re-deriving the suggested Start from the live chain (which
  // already recomputes on every render from current Est. hrs/Effort/Start)
  // and re-saves it the moment it drifts, no manual untick/retick needed
  // anymore. A task the user has manually overridden is left alone --
  // `dependencyConflict`'s existing warning icon is still the only signal
  // for that case, exactly as Sandra originally asked for.
  // Bugfix (2026-08-26, Sandra: WBS visibly flickering/glitching whenever
  // a dependency is set -- Task 2's Forecasted and Capacity-Based dates
  // rapidly alternated between two different answers): this loop used to
  // run for ALL THREE modes, but "standard" (Capacity-Based) has had NO
  // draft field of its own since Phase 12 -- Manual took over
  // start_date_standard/start_standard_auto as ITS OWN private override
  // columns (see computeEntry's big Phase 12 comment above). Nobody
  // updated this effect after that repurposing, so it was still writing
  // a "standard"-derived suggested Start into the exact same column
  // "manual" writes its OWN, DIFFERENT suggested Start into -- whenever a
  // task's predecessor had itself been manually touched (so its Manual-
  // chain end date differs from its Capacity-Based-chain end date, which
  // is exactly what happened in Sandra's repro: Task 1 was manually
  // overridden), the two mode passes computed two different candidates
  // and each render's write clobbered the other's, forever (mode
  // "standard" needs a *dependency-respecting floor* fed into the
  // capacity queue too, but it must come from Manual's own write -- see
  // `effectiveTasksForSched` above, which already reads
  // start_date_standard for exactly this purpose -- not a second,
  // independent write of its own). Restricting this loop to the two
  // modes that actually own a persisted field ("manual" and
  // "full_capacity") removes the collision entirely; Capacity-Based
  // still gets a dependency-aware floor for free via Manual's write to
  // the same shared column.
  useEffect(() => {
    for (const t of tasks) {
      // Same fix as the parent-rollup effect above (2026-08-27) -- a
      // Done task's Start is locked server-side, so this dependency
      // auto-pilot effect must never stage a patch for one, even if its
      // live-computed suggested Start still drifts from what's stored.
      if (t.status === "Done") continue;
      const depIds = dependsOnIdsFor(t.id);
      if (!depIds.length) continue;
      for (const mode of MODES.filter((m) => m !== "standard")) {
        const autoField = mode === "full_capacity" ? "start_full_auto" : "start_standard_auto";
        const startField = mode === "full_capacity" ? "start_date_full" : "start_date_standard";
        if (t[autoField] === false) continue; // manually overridden -- leave it, warning icon covers this
        const suggested = suggestedStartFor(depIds, mode, t.id);
        const current = t[startField] ? (t[startField] as string).slice(0, 10) : null;
        if (suggested && suggested !== current) {
          saveTaskField(t.id, { [startField]: suggested } as Partial<TaskRow>);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, dependencies]);

  // Capacity-aware scheduling infra for the "standard" mode (retired its
  // old flat 4h/day Conservative-Effort math 2026-08-21 -- see
  // [[project_capaciq_wbs_capacity_based_mode]]). Reuses Utilization.tsx's
  // own buildForwardSchedule (cross-project, real-remaining-capacity
  // engine), one schedule per assignee, memoized. Deliberately placed
  // BEFORE computeEntry/buildChain below since "standard" mode's due
  // dates now depend on it. This project's own rows anchor on the PLAIN
  // `start_date_standard` field (not a chain lookup) specifically to
  // avoid a circular dependency: buildChain("standard") calls
  // computeEntry, which needs a schedule, which needs this list built
  // first -- reading the stored field directly (same field the existing
  // dependency-auto-refresh machinery already keeps up to date) breaks
  // that cycle cleanly.
  const fixedWorkTypeIds = new Set(workTypes.filter((w) => w.is_fixed_schedule).map((w) => w.id));
  const effectiveTasksForSched: SchedTaskRow[] = [
    ...allTasks
      .filter((t) => t.project_id !== projectId)
      .map((t) => ({
        id: t.id,
        project_id: t.project_id,
        parent_task_id: t.parent_task_id ?? null,
        assignee_id: t.assignee_id,
        status: t.status,
        start_date: t.start_date,
        current_due_date: t.current_due_date,
        estimated_hours: t.estimated_hours ?? null,
        sort_order: t.sort_order ?? null,
        is_fixed_schedule: !!t.work_type_id && fixedWorkTypeIds.has(t.work_type_id),
      })),
    ...tasks.map((t) => ({
      id: t.id,
      project_id: t.project_id,
      parent_task_id: t.parent_task_id,
      assignee_id: t.assignee_id,
      status: t.status,
      // Bugfix (2026-08-24, Sandra: "why is the capacity based timelines
      // changing when i change the manual dates?"): start_date_standard
      // is Manual mode's own private override column now (Phase 12
      // repurposed it from Capacity-Based's old, since-retired override
      // slot) -- reading it unconditionally here fed Manual's typed Start
      // straight into Capacity-Based's own whole-queue walk. Once a task
      // has been Manually overridden (start_standard_auto === false),
      // Capacity-Based must fall back to the task's plain start_date
      // instead, same as it already does for every OTHER project's tasks
      // above (which never look at start_date_standard at all).
      start_date: t.start_standard_auto === false ? t.start_date : (t.start_date_standard ?? t.start_date),
      current_due_date: t.current_due_date,
      estimated_hours: t.estimated_hours,
      sort_order: t.sort_order,
      is_fixed_schedule: !!t.work_type_id && fixedWorkTypeIds.has(t.work_type_id),
    })),
  ];
  const effectiveProjectsForSched: SchedProjectRow[] = [
    ...allProjects
      .filter((p) => p.id !== projectId)
      .map((p) => ({ id: p.id, owner_id: p.owner_id, start_date: p.start_date, end_date: p.end_date, wbs_status: p.wbs_status })),
    {
      id: projectId ?? "",
      owner_id: project?.owner_id ?? null,
      start_date: project?.start_date ?? null,
      end_date: project?.end_date ?? null,
      wbs_status: project?.wbs_status ?? null,
    },
  ];
  const schedAvailability: SchedAvailabilityRow[] = availability.map((a) => ({ person_id: a.person_id, date: a.date, status: a.status }));
  const schedParentTaskIds = new Set(effectiveTasksForSched.filter((t) => t.parent_task_id).map((t) => t.parent_task_id as string));
  const isCompleteStatusForSched = (status: string | null) => status === "Done";
  const schedulesByAssignee = new Map<string, ReturnType<typeof buildForwardSchedule>>();
  function scheduleFor(personId: string): ReturnType<typeof buildForwardSchedule> {
    let sched = schedulesByAssignee.get(personId);
    if (!sched) {
      const person = people.find((p) => p.id === personId);
      if (!person) return { perDay: new Map(), taskDueDates: new Map(), taskStartDates: new Map() };
      sched = buildForwardSchedule({
        personId,
        fromDateStr: today,
        tasks: effectiveTasksForSched,
        parentTaskIds: schedParentTaskIds,
        isCompleteStatus: isCompleteStatusForSched,
        projects: effectiveProjectsForSched,
        person: { id: person.id, daily_capacity_hours: person.daily_capacity_hours },
        holidaySet,
        availability: schedAvailability,
        maxDaysGuard: 365,
        // Bugfix (2026-08-26, Sandra: Task 1 started 08/03 but Forecasted
        // End showed today instead of 08/04): WBS Planning's own
        // Forecasted/Capacity-Based table should schedule from a task's
        // REAL Start date even when it's in the past, unlike
        // Utilization.tsx's "today and future" grid (this scheduler's
        // other caller, which keeps the old floor-at-today behavior on
        // purpose). Sandra confirmed it's fine for Forecasted to diverge
        // from Theoretical's flat math here -- this still runs the full
        // capacity-aware walk, it just no longer clamps a backdated
        // start up to today first.
        floorEffectiveStartAtFromDate: false,
      });
      schedulesByAssignee.set(personId, sched);
    }
    return sched;
  }

  // Theoretical/Full-Capacity same-person day-packing (2026-08-26,
  // Sandra: "if Jo still has 4.5 hours left for Aug 5, then this next
  // task can start on the same day with overflow to the following
  // day"). Deliberately project-scoped (unlike scheduleFor above, which
  // is cross-project for Capacity-Based/Utilization) -- Theoretical is
  // meant to answer "what does THIS project's own plan look like at a
  // flat full day", not fold in a person's other projects' work too.
  // See packFullCapacityQueue's own doc comment (taskScheduling.ts) for
  // why this can't just reuse buildForwardSchedule: that engine treats
  // every task's own recorded Start as a hard per-task floor (right for
  // Capacity-Based's "honor what's already been declared" semantics),
  // which is exactly what stopped Theoretical from ever pulling a later
  // sibling task earlier to fill an earlier one's same-day leftover
  // capacity.
  const theoreticalTasksForSched: FullCapacityQueueTask[] = tasks
    .filter((t) => !t.parent_task_id && t.assignee_id && t.status !== "Done" && (t.estimated_hours ?? 0) > 0 && t.start_date_full)
    .map((t) => ({
      id: t.id,
      estimatedHours: t.estimated_hours ?? 0,
      ownStartDateStr: (t.start_date_full as string).slice(0, 10),
      // Bugfix (2026-08-26, Sandra: Joseph's Task 3/4 still weren't
      // packing after the first fix): only a task that's ACTUALLY
      // dependency-linked gets a real floor here -- an ordinary,
      // unconstrained sibling's stored start_date_full is just whatever
      // default it happened to get at creation time (e.g. "day after
      // the previous row"), not a genuine constraint, so it must NOT
      // block the live packer from pulling it earlier into a
      // predecessor's same-day leftover capacity. See
      // FullCapacityQueueTask's own doc comment (taskScheduling.ts).
      floorDateStr: dependsOnIdsFor(t.id).length > 0 ? (t.start_date_full as string).slice(0, 10) : undefined,
      sortOrder: t.sort_order ?? null,
      isFixedSchedule: !!t.work_type_id && fixedWorkTypeIds.has(t.work_type_id),
    }));
  const theoreticalSchedulesByAssignee = new Map<string, ReturnType<typeof packFullCapacityQueue>>();
  function theoreticalScheduleFor(personId: string): ReturnType<typeof packFullCapacityQueue> {
    let sched = theoreticalSchedulesByAssignee.get(personId);
    if (!sched) {
      sched = packFullCapacityQueue(
        theoreticalTasksForSched.filter((t) => tasks.find((x) => x.id === t.id)?.assignee_id === personId),
        holidaySet,
        FULL_CAPACITY_DAILY_HOURS
      );
      theoreticalSchedulesByAssignee.set(personId, sched);
    }
    return sched;
  }

  function nextWorkingDayAfter(dateStr: string, holidays: HolidaySet): string {
    let d = addDays(parseLocalDate(dateStr), 1);
    while (!isWorkingDay(d, holidays)) d = addDays(d, 1);
    return toISO(d);
  }

  // Per-task, per-mode End-date calculator -- a task's own Start date
  // (stored, freely editable) plus its Estimated hours, run through
  // whichever mode's flat daily rate. Manual and Capacity-Based are
  // deliberately independent of every other task (Sandra confirmed:
  // simpler, predictable, lets tasks genuinely overlap/parallelize --
  // the utilization heat-map below is where over-allocation actually
  // shows up, not a scheduling constraint here). Full Capacity /
  // Theoretical is the one exception (2026-08-26): it packs same-person,
  // same-project siblings into each other's same-day leftover capacity
  // via theoreticalScheduleFor above, since it's meant to represent the
  // optimistic "every available hour actually gets used" reference.
  function computeEntry(t: TaskRow, mode: Mode): ChainEntry | null {
    // Phase 12 (2026-08-21): Sandra -- "add a table for Manual... the
    // manual timetable would basically reflect Capacity-Based by
    // default, meaning any changes can only be done in Manual... don't
    // allow edits in the start/end dates of Capacity-Based and Full
    // Effort." Capacity-Based is now a pure, always-computed reference
    // (no draft field, never overridable); Manual is the only place a
    // typed date wins, and it reuses the exact start_date_standard/
    // start_standard_auto columns that used to carry Capacity-Based's
    // in-place override (Phase 7) -- Capacity-Based never needed that
    // draft field for anything except the override it can no longer
    // have, so repurposing it here is zero-migration.
    if (mode === "manual") {
      // Done tasks: dates are historical fact, same as every mode.
      if (t.status === "Done" && t.current_due_date) {
        const start = (t.start_date_standard ?? t.current_due_date).slice(0, 10);
        const end = t.current_due_date.slice(0, 10);
        const durationDays = workingDaysBetween(parseLocalDate(start), parseLocalDate(end), holidaySet).length;
        return { start, end, durationDays };
      }
      const hours = t.estimated_hours;
      if (hours === null || hours === undefined) return null;
      if (!t.assignee_id) return null;
      const sched = scheduleFor(t.assignee_id);
      const schedStart = sched.taskStartDates.get(t.id);
      const schedEnd = sched.taskDueDates.get(t.id);
      // Touched -- the typed Start always wins, walked forward at a flat
      // daily rate (same math as Full Effort) rather than deferring to
      // the person's whole-queue position. Capacity-Based's own answer
      // is still carried along as suggestedStart/suggestedEnd purely so
      // the UI can flag the deviation.
      if (t.start_standard_auto === false && t.start_date_standard) {
        const start = t.start_date_standard.slice(0, 10);
        // Phase 19 (2026-08-24, Sandra: "15 planned hours but expected to
        // be done in 3 days -- should be spread across 5 hours for 3
        // days"): when an End date has also been typed, spread the
        // task's hours evenly across every working day from Start to
        // that End, instead of the flat 7.5h/day fallback below. This
        // needs no changes anywhere else -- Utilization's default
        // "Realistic" view already spreads a task's estimated hours
        // evenly across its own start_date/current_due_date window, so
        // once Save writes this End into current_due_date, the 5h/day
        // heat-map shows up automatically.
        if (t.manual_end_date) {
          const end = t.manual_end_date.slice(0, 10);
          const durationDays = Math.max(1, workingDaysBetween(parseLocalDate(start), parseLocalDate(end), holidaySet).length);
          return {
            start,
            end,
            durationDays,
            avgHoursPerDay: Math.round((hours / durationDays) * 100) / 100,
            isOverridden: true,
            suggestedStart: schedStart,
            suggestedEnd: schedEnd,
          };
        }
        const r = fullCapacityScenario(hours, start, holidaySet);
        return {
          start,
          end: r.dueDate,
          durationDays: r.wholeDays,
          rawDays: r.rawDays,
          isOverridden: true,
          suggestedStart: schedStart,
          suggestedEnd: schedEnd,
        };
      }
      // Not yet touched -- mirror Capacity-Based's live suggestion
      // exactly, so Manual always "reflects Capacity-Based by default."
      if (!schedStart || !schedEnd) return null;
      const durationDays = workingDaysBetween(parseLocalDate(schedStart), parseLocalDate(schedEnd), holidaySet).length;
      return { start: schedStart, end: schedEnd, durationDays };
    }

    if (mode === "standard") {
      // Capacity-Based: ALWAYS this assignee's whole-queue forward walk
      // (memoized per person) -- read-only, never overridable. Manual
      // (above) is the only mode where a human date can win now.
      if (t.status === "Done" && t.current_due_date) {
        const end = t.current_due_date.slice(0, 10);
        const start = (t.start_date_standard ?? end).slice(0, 10);
        const durationDays = workingDaysBetween(parseLocalDate(start), parseLocalDate(end), holidaySet).length;
        return { start, end, durationDays };
      }
      const hours = t.estimated_hours;
      if (hours === null || hours === undefined) return null;
      if (!t.assignee_id) return null;
      const sched = scheduleFor(t.assignee_id);
      const schedStart = sched.taskStartDates.get(t.id);
      const schedEnd = sched.taskDueDates.get(t.id);
      if (!schedStart || !schedEnd) return null;
      const durationDays = workingDaysBetween(parseLocalDate(schedStart), parseLocalDate(schedEnd), holidaySet).length;
      return { start: schedStart, end: schedEnd, durationDays };
    }

    // full_capacity: flat daily rate from its own auto-derived Start
    // (start_date_full/start_full_auto) -- also read-only now; it only
    // ever moves via the dependency auto-sync effect, never a direct
    // edit, so there's no override concept to worry about here either.
    const start = t.start_date_full ? t.start_date_full.slice(0, 10) : null;
    if (!start) return null;
    if (t.status === "Done" && t.current_due_date) {
      const end = t.current_due_date.slice(0, 10);
      const durationDays = workingDaysBetween(parseLocalDate(start), parseLocalDate(end), holidaySet).length;
      return { start, end, durationDays };
    }
    const hours = t.estimated_hours;
    if (hours === null || hours === undefined) return null;
    // Bugfix (2026-08-26, Sandra): an unassigned task has no one to
    // share a queue with, so it keeps the old solo flat calc. Every
    // assigned task now packs into its assignee's shared same-project
    // queue instead (theoreticalScheduleFor above) -- a person's OWN
    // leftover same-day capacity gets used by their next task rather
    // than every task getting its own untouched day regardless of how
    // little of the previous day it actually needed.
    if (!t.assignee_id) {
      const r = fullCapacityScenario(hours, start, holidaySet);
      return { start, end: r.dueDate, durationDays: r.wholeDays, rawDays: r.rawDays };
    }
    const sched = theoreticalScheduleFor(t.assignee_id);
    const schedStart = sched.starts.get(t.id);
    const schedEnd = sched.ends.get(t.id);
    if (!schedStart || !schedEnd) {
      // Shouldn't normally happen (every task with hours+assignee+start
      // gets queued above) -- defensive fallback to the old solo calc
      // rather than silently going blank.
      const r = fullCapacityScenario(hours, start, holidaySet);
      return { start, end: r.dueDate, durationDays: r.wholeDays, rawDays: r.rawDays };
    }
    const durationDays = workingDaysBetween(parseLocalDate(schedStart), parseLocalDate(schedEnd), holidaySet).length;
    return { start: schedStart, end: schedEnd, durationDays };
  }

  // Builds the full per-mode map: leaf tasks computed directly from their
  // own Start date; a parent task's entry is then derived as the
  // min(start)/max(end) span across its own sub-tasks (never computed
  // from its own Start field directly, same as Est. hrs).
  function buildChain(mode: Mode): Map<string, ChainEntry | null> {
    const result = new Map<string, ChainEntry | null>();
    for (const t of orderedTasks) {
      if (t.depth === 0 && hasChildren(t.id)) continue; // parents handled below
      result.set(t.id, computeEntry(t, mode));
    }
    for (const t of orderedTasks) {
      if (t.depth !== 0 || !hasChildren(t.id)) continue;
      const children = orderedTasks.filter((c) => c.depth === 1 && c.parent_task_id === t.id);
      const entries = children.map((c) => result.get(c.id)).filter((e): e is ChainEntry => !!e);
      if (entries.length === children.length && entries.length > 0) {
        const start = entries.reduce((min, e) => (e.start < min ? e.start : min), entries[0].start);
        const end = entries.reduce((max, e) => (e.end > max ? e.end : max), entries[0].end);
        const durationDays = workingDaysBetween(parseLocalDate(start), parseLocalDate(end), holidaySet).length;
        result.set(t.id, { start, end, durationDays });
      } else {
        result.set(t.id, null);
      }
    }
    return result;
  }

  const fullChain = buildChain("full_capacity");
  const standardChain = buildChain("standard");
  // Phase 12 (2026-08-21): Manual is now its own real Mode/column (not a
  // conditional override folded into Capacity-Based) -- see computeEntry
  // above for the mirror-then-freeze behavior.
  const manualChain = buildChain("manual");
  const chainByMode: Record<Mode, Map<string, ChainEntry | null>> = {
    full_capacity: fullChain,
    standard: standardChain,
    manual: manualChain,
  };
  // Phase 9/10 simplified by Phase 12: Capacity-Based is now ALWAYS the
  // pure queue-suggested chain (never overridable), so the Utilization
  // snapshot's "Capacity-Based" preview and "Manual" preview can just
  // point straight at chainByMode.standard/chainByMode.manual -- no
  // separate ignoreOverride variant needed anymore.
  function previewChainFor(m: UtilPreviewMode): Map<string, ChainEntry | null> | null {
    if (m === "actual") return null;
    if (m === "full_capacity") return fullChain;
    if (m === "standard_suggested") return standardChain;
    return manualChain; // "standard_committed"
  }


  // Phase 2 (2026-07-28): builds the exact per-task snapshot the
  // lock/apply/decide RPCs persist. Deliberately reuses the SAME
  // fullChain/standardChain maps already computed above for the on-screen
  // table -- rather than recomputing scheduling in SQL (which would
  // duplicate refreshDates'/computeEntry's real business logic in two
  // places and risk drift), the RPC just persists whatever is already
  // showing on screen at the moment of Lock/Apply/Close.
  // Phase 12 (2026-08-21): the baseline snapshot's JSON shape still only
  // has ONE non-Full-Effort slot (start_date_standard/end_date_standard --
  // no DB/RPC schema change made for this). When Manual is the active
  // Scoping Effort mode, that slot now carries Manual's own dates instead
  // of pure Capacity-Based's -- exactly mirroring how Manual reuses the
  // tasks table's start_date_standard/start_standard_auto columns
  // in-place rather than getting its own. decide_baseline_request's SQL
  // was updated to match (reads whichever mode is <> 'full_capacity' from
  // this same slot).
  function buildTaskSnapshotPayload() {
    const modeChain = activeMode === "manual" ? manualChain : standardChain;
    return orderedTasks.map((t) => {
      const fullEntry = fullChain.get(t.id);
      const modeEntry = modeChain.get(t.id);
      return {
        task_id: t.id,
        parent_task_id: t.parent_task_id,
        name: t.name,
        estimated_hours: t.estimated_hours,
        assignee_name: people.find((p) => p.id === t.assignee_id)?.name ?? null,
        effort: t.effort,
        depends_on: dependsOnIdsFor(t.id),
        start_date_full: fullEntry?.start ?? null,
        end_date_full: fullEntry?.end ?? null,
        start_date_standard: modeEntry?.start ?? null,
        end_date_standard: modeEntry?.end ?? null,
      };
    });
  }

  // Phase 6 (2026-08-21): replaces handleLockBaseline/handleStartRevision/
  // handleApplyRevision/handleDiscardRevision/handleRebaseline -- ONE
  // request type now covers both the first-ever baseline (from Draft) and
  // any later re-baseline (from Baseline Locked/Changed After Baseline).
  // No task snapshot built here -- decide_baseline_request needs a FRESH
  // snapshot taken at approval time (built by whoever clicks Approve, see
  // handleDecideBaselineRequest below), not at request time, same pattern
  // Close's request/decide split already uses.
  async function handleRequestBaseline() {
    if (!project) return;
    if (project.wbs_status === "draft" && orderedTasks.length === 0) {
      await alert("Add at least one task before requesting a baseline.");
      return;
    }
    // Sandra, 2026-08-26: "only push to fill in all needed info when
    // requesting for Baseline Approval" -- softIssues() (placeholder task
    // names, missing Effort/Scoped Hours, dependency-date conflicts) used
    // to gate Save itself; it now gates the baseline request instead, so
    // a draft can be saved incomplete but not baselined incomplete.
    const issues = softIssues();
    if (issues.length && !isFullAccess) {
      await alert(`Can't request a baseline yet:\n\n${issues.join("\n")}`);
      return;
    }
    if (issues.length && isFullAccess) {
      if (!(await confirm(`${issues.join("\n")}\n\nFull Access override: Start Project anyway?`))) return;
    }
    // Sandra: "make sure the output type is keyed in before saving
    // baseline, but the count can be kept optional until project is
    // closed." Output Type is a hard gate here (no Full Access override,
    // same as the "add at least one task" check above) -- Output Count
    // deliberately has no equivalent check anywhere, since it's expected
    // to often still be a guess/placeholder until the project's real work
    // is actually done.
    const missingOutputType = orderedTasks.filter((t) => !t.output_type_id);
    if (missingOutputType.length) {
      await alert(
        `Can't request a baseline yet -- ${missingOutputType.length} task(s) still need an Output Type picked. Output Count can stay blank for now; it only needs to be accurate by the time this project is closed.`
      );
      return;
    }
    // 2026-08-27 (Sandra: rename Lock Baseline -> Start Project, remove
    // Re-baseline): this action is now only ever reachable from Draft
    // (see canRequestBaseline above), so the old isFirstBaseline branch
    // that handled a second/later re-baseline request no longer applies.
    if (
      !(await confirm({
        title: "Start Project",
        message: `Request approval to lock ${MODE_LABEL[activeMode]} as this project's Baseline and start the project? Once approved, this becomes the official commitment.`,
        confirmLabel: "Request Approval",
      }))
    )
      return;
    // Same bugfix class as addTopLevelTask above -- flush staged edits
    // first so they are not silently discarded by this action's own
    // loadAll(), and so the baseline captures what is actually saved.
    const flushedBeforeRequest = await flushPendingEdits();
    if (!flushedBeforeRequest) return;
    setWorkflowBusy(true);
    const { error } = await supabase.rpc("request_baseline_approval", { p_project_id: project.id, p_reason: null });
    setWorkflowBusy(false);
    if (error) {
      await alert(`Couldn't request baseline approval: ${error.message}`);
      return;
    }
    await loadAll();
  }

  async function handleDecideBaselineRequest(approve: boolean) {
    if (!project || !pendingBaselineRequest) return;
    if (
      !(await confirm({
        title: approve ? "Start Project" : "Reject Start Project Request",
        message: approve
          ? `Confirm this baseline request? This captures the current plan as the official Baseline, marking the project as started.`
          : "Reject this Start Project request?",
        confirmLabel: approve ? "Approve" : "Reject",
        danger: !approve,
      }))
    )
      return;
    // Flush first -- same reasoning as handleRequestBaseline above: the
    // snapshot this sends should match what is actually saved, and this
    // action's own loadAll() must not discard unrelated staged edits.
    const flushedBeforeDecide = await flushPendingEdits();
    if (!flushedBeforeDecide) return;
    setWorkflowBusy(true);
    const { error } = await supabase.rpc("decide_baseline_request", {
      p_request_id: pendingBaselineRequest.id,
      p_approve: approve,
      p_reason: null,
      p_mode: activeMode,
      p_tasks: buildTaskSnapshotPayload(),
    });
    setWorkflowBusy(false);
    if (error) {
      await alert(`Couldn't decide baseline request: ${error.message}`);
      return;
    }
    await loadAll();
  }

  async function handleRequestClosure() {
    if (!project) return;
    // Sandra, 2026-08-26: "before requesting to close -- all details are
    // encoded like project status, phase, category, priority, source and
    // complexity -- technically all that requires manual input." These
    // are all set on the Projects & Tasks list (not this page), so
    // there's no in-context prompt nudging someone to fill them in
    // before they get here -- gate closure on them explicitly instead of
    // letting a project close with silently-blank properties.
    const missingProjectFields: string[] = [];
    if (!project.status) missingProjectFields.push("Status");
    if (!project.phase) missingProjectFields.push("Phase");
    if (!project.category) missingProjectFields.push("Category");
    if (!project.priority) missingProjectFields.push("Priority");
    if (!project.source_id) missingProjectFields.push("Source");
    if (!project.effort_level) missingProjectFields.push("Complexity");
    if (missingProjectFields.length) {
      await alert(
        `Can't request closure yet -- this project is still missing: ${missingProjectFields.join(", ")}. Set these on the Projects & Tasks list first.`
      );
      return;
    }
    // Sandra, 2026-08-26: "output count will be required on project close
    // request and approval" -- unlike Output Type (required at Baseline),
    // Output Count is allowed to stay blank right up until closure.
    const missingOutputCount = orderedTasks.filter((t) => t.output_count === null || t.output_count === undefined);
    if (missingOutputCount.length) {
      await alert(`Can't request closure yet -- ${missingOutputCount.length} task(s) still need an Output Count.`);
      return;
    }
    if (!(await confirm(`Request closure for "${project.name}"? This asks an approver to lock in the current plan as Final Scope.`))) return;
    const flushedBeforeClosureRequest = await flushPendingEdits();
    if (!flushedBeforeClosureRequest) return;
    setWorkflowBusy(true);
    const { error } = await supabase.rpc("request_wbs_closure", { p_project_id: project.id });
    setWorkflowBusy(false);
    if (error) {
      await alert(`Couldn't request closure: ${error.message}`);
      return;
    }
    await loadAll();
  }

  async function handleDecideClosure(approve: boolean) {
    if (!project || !pendingClosure) return;
    if (approve) {
      // Same project-level field gate as handleRequestClosure above --
      // an approver shouldn't be able to wave through a closure that's
      // still missing required properties just because the request
      // itself slipped through before this gate existed.
      const missingProjectFields: string[] = [];
      if (!project.status) missingProjectFields.push("Status");
      if (!project.phase) missingProjectFields.push("Phase");
      if (!project.category) missingProjectFields.push("Category");
      if (!project.priority) missingProjectFields.push("Priority");
      if (!project.source_id) missingProjectFields.push("Source");
      if (!project.effort_level) missingProjectFields.push("Complexity");
      if (missingProjectFields.length) {
        await alert(
          `Can't approve closure yet -- this project is still missing: ${missingProjectFields.join(", ")}. Set these on the Projects & Tasks list first.`
        );
        return;
      }
      const missingOutputCount = orderedTasks.filter((t) => t.output_count === null || t.output_count === undefined);
      if (missingOutputCount.length) {
        await alert(`Can't approve closure yet -- ${missingOutputCount.length} task(s) still need an Output Count.`);
        return;
      }
    }
    if (!(await confirm(approve ? "Approve this closure? This locks in the current plan as Final Scope -- final, no re-opening." : "Reject this closure request?"))) return;
    const flushedBeforeClosureDecide = await flushPendingEdits();
    if (!flushedBeforeClosureDecide) return;
    setWorkflowBusy(true);
    const { error } = await supabase.rpc("decide_wbs_closure", {
      p_request_id: pendingClosure.id,
      p_approve: approve,
      p_reason: null,
      p_tasks: buildTaskSnapshotPayload(),
    });
    setWorkflowBusy(false);
    if (error) {
      await alert(`Couldn't decide closure: ${error.message}`);
      return;
    }
    await loadAll();
  }

  // Round 11 (Sandra): the project's own Start date is now MANUAL again --
  // "the user can plot the start onset in the top bar. Start will no
  // longer depend on the earliest start of task." Reversing the earlier
  // "derived from earliest task Start" model was necessary once Full
  // Effort and Conservative Effort got their own independent Start
  // fields below -- there's no longer one single "earliest task start" to
  // derive from anyway (Full's earliest and Conservative's earliest can
  // differ). `project.start_date` is just a plain editable anchor now,
  // used as the fallback Start for the very first task in each mode's
  // chain when there's nothing earlier to chain from.
  const utilAnchorDate = fallbackStartDate;

  // Scroll today's column into view whenever it's part of the currently
  // shown window. Must run unconditionally on every render (React's Rules
  // of Hooks) -- this component has an early `if (loading) return ...`
  // further down, so this hook has to live BEFORE that gate, not next to
  // the `utilDays` variable it conceptually belongs with further down
  // (that placement caused a "Rendered more hooks than during the
  // previous render" crash the first time this shipped: 0 hooks ran on
  // the loading-gated first render, then 1 more once loading finished).
  // Recomputes the day window inline rather than depending on the later
  // `utilDays` variable, which isn't in scope yet at this point in the
  // component.
  useEffect(() => {
    const el = utilSnapshotScrollRef.current;
    if (!el) return;
    const windowStart = addDays(parseLocalDate(utilAnchorDate), utilWindowOffset * UTIL_WINDOW_DAYS);
    const days = Array.from({ length: UTIL_WINDOW_DAYS }, (_, i) => addDays(windowStart, i));
    const todayIso = toISO(new Date());
    const idx = days.findIndex((d) => toISO(d) === todayIso);
    if (idx === -1) return;
    // Bugfix (2026-08-26, Sandra: "when adjusting the person name [column
    // width] the scenario header moves too"): this effect used to also
    // re-run on every utilPersonColW change -- which fires on every
    // single mousemove while dragging the Person column's resize handle.
    // Each re-run redid the "is today's column still visible" check with
    // the mid-drag width and, whenever that check failed even for one
    // frame, forcibly reset el.scrollLeft -- yanking the whole date grid
    // horizontally as a side effect of resizing, which is what actually
    // looked like the Scenario column "moving." Reading the current
    // width from utilPersonColWRef (kept in sync below, but NOT a
    // dependency here) means this auto-scroll logic still uses an
    // up-to-date width whenever it legitimately runs (window navigation,
    // mount), without re-running mid-drag. Scenario visually sliding
    // along with Person's new width during the drag itself is correct,
    // intentional behavior (see the `left: utilPersonColW` styles below)
    // -- only the scroll-jumping was the bug.
    // Round 3 bugfix (2026-08-27, Sandra: "date columns are clipped --
    // looks like the Scenario column is too wide"): PERSON_COL_W/
    // SCENARIO_COL_W used to be the DECLARED widths (utilPersonColWRef,
    // and a bare 150 constant for Scenario) rather than what Chrome
    // actually renders those two sticky columns at -- confirmed live
    // that both render narrower than declared under this table's auto
    // layout (see the long comment above utilPersonThRef/
    // utilScenarioThRef). Using the REAL measured widths here keeps
    // this effect's sticky-offset math consistent with the actual
    // on-screen sticky footprint instead of a guess that's provably
    // off by ~13-14px.
    const PERSON_COL_W = utilPersonRenderedWRef.current;
    const SCENARIO_COL_W = utilScenarioRenderedWRef.current;
    const DAY_COL_W = 40;
    const targetLeft = PERSON_COL_W + SCENARIO_COL_W + idx * DAY_COL_W;
    // Bugfix (2026-08-26, Sandra: "Aug 3 can't be seen in the snapshot"):
    // this used to unconditionally re-center today's column every time,
    // which on THIS panel (anchored to the project's own start date, not
    // to today -- unlike Utilization.tsx/HoursOverview.tsx's grids,
    // which anchor to today itself) pushed the window's own leftmost
    // dates off-screen to the left whenever today sat deep into the
    // range, even though they were already comfortably visible at the
    // default scrollLeft of 0. Only scroll at all if today's column
    // ISN'T already fully visible at the current position -- keeps the
    // range's start in view whenever today already fits alongside it,
    // and still guarantees today is reachable when it genuinely doesn't.
    //
    // Round 2 bugfix (2026-08-26, Sandra: "at 90% [zoom]... when zooming
    // in it's being cut" -- a date column's own header text was visibly
    // clipped, not just scrolled out of view): PERSON_COL_W + SCENARIO_
    // COL_W (280px) is a STICKY overlay that always occupies the first
    // 280px of the VIEWPORT, regardless of scroll position -- a date
    // column can satisfy the numeric "targetLeft is within [scrollLeft,
    // scrollLeft+clientWidth)" check while actually rendering PARTLY (or
    // fully) underneath that sticky region, since sticky content draws
    // on top of whatever scrolls to those same viewport pixels. The
    // check must require the column to start AT OR AFTER the sticky
    // region's own width, not just at or after scrollLeft.
    const STICKY_OFFSET = PERSON_COL_W + SCENARIO_COL_W;
    const viewStart = el.scrollLeft + STICKY_OFFSET;
    const viewEnd = el.scrollLeft + el.clientWidth;
    if (targetLeft >= viewStart && targetLeft + DAY_COL_W <= viewEnd) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    // Same sticky-offset accounting as the visibility check above --
    // centering within the FULL clientWidth (old math) could land the
    // target column's viewport position back underneath the sticky
    // Person/Scenario columns; centering within the USABLE width
    // (clientWidth - STICKY_OFFSET) instead keeps it clear of them.
    const desired = targetLeft - el.clientWidth / 2 - STICKY_OFFSET / 2 + DAY_COL_W / 2;
    el.scrollLeft = Math.max(0, Math.min(desired, maxScroll));
  }, [utilAnchorDate, utilWindowOffset]);

  // Fixed 2026-07-24 (Sandra: "fix the glitch when adding task in WBS") --
  // the old default-Start logic for a new task only ever looked at the
  // LITERAL last task in the list, which is almost always the most
  // recently added "Untitled task" itself -- with no Est. hrs yet, its
  // chain entry is null, so every SUBSEQUENT new task silently fell back
  // to the project's own Start date instead of chaining after whichever
  // task actually has a real schedule. Walking backwards for the last
  // task that resolves to a real entry fixes this -- blank placeholder
  // rows in between no longer break the chain. Round 11: mode-parameterized
  // now that Full Effort and Conservative Effort each need their own
  // independent "what did the last real task end on" answer.
  async function addTopLevelTask() {
    if (!project) return;
    // Bugfix (2026-08-24, Sandra: "when adding a task -- all existing
    // tasks become untitled"): this used to call loadAll() right after
    // inserting the new row, which does a full fresh fetch and blows
    // away any edits still only staged in pendingTaskPatches/
    // pendingProjectPatch (name, hours, assignee, etc. typed but not yet
    // Saved) -- every unsaved field on every other task silently reverted
    // to whatever's actually in the DB, which for a freshly-added task is
    // still its literal insert defaults ("Untitled task", no hours). Now
    // flushes those staged edits first, same as Save does, so adding a
    // task can never discard in-progress work on other rows.
    const flushed = await flushPendingEdits();
    if (!flushed) return;
    const today = new Date().toISOString().slice(0, 10);
    const anchor = project.start_date ? project.start_date.slice(0, 10) : fallbackStartDate;
    let defaultStartFull = anchor;
    let defaultStartStandard = anchor;
    // Bugfix (2026-08-26, Sandra: "why is Gemma and Fritzie's task start
    // dates plotted after prior's end date -- I thought if the resource
    // is different then assume parallel work unless tagged with
    // dependencies"): this used to seed a brand-new task's Theoretical
    // default Start via packedFullEffortNextStart(lastResolvedEntry(roots,
    // "full_capacity").end, 0, roots) -- but with newHours hardcoded to 0
    // (a brand-new task has no hours yet), that packing call ALWAYS just
    // returns predecessorEnd unchanged (0 hours always "fits" in whatever
    // room is left), so in practice this simply chained every new task's
    // default Start onto the literal previous root task's END date --
    // unconditionally, regardless of assignee, purely because of list
    // order. Once created with `start_full_auto: true`, nothing ever
    // re-evaluates that default (the dependency-auto-refresh effect above
    // only runs for tasks with a REAL tagged dependency), so it read
    // exactly like a permanent finish-to-start chain between two
    // different people's tasks that were never actually linked. Same
    // reasoning and same fix as the Phase 22 bugfix already applied to
    // Capacity-Based's own default below: stop artificially advancing
    // this floor at all -- every no-dependency task just anchors to the
    // same starting point (this project's own anchor date) like
    // Capacity-Based already does, and real per-person day-packing only
    // ever applies once a task has both a real assignee AND real hours
    // (handled live by the render-time chain computation, not this
    // one-time creation default).
    // Phase 22 bugfix (2026-08-24, Sandra: "How come ... the 4th task
    // [is placed] to start on Sept 2 when there is still available hours
    // remaining on Sept 1 ... given the overlap in the 7.5 hours?"):
    // Capacity-Based used to seed a brand-new task's start_date_standard
    // floor via nextWorkingDayAfter(previous sibling's end) -- ALWAYS the
    // next calendar day, with zero regard for whether that predecessor's
    // own day still had free capacity left. Unlike Full Effort (which has
    // no real per-person queue engine and needs the local
    // packedFullEffortNextStart heuristic above), Capacity-Based already
    // has a genuine one -- buildForwardSchedule -- which does correct
    // real per-day free-capacity packing AND breaks ties by this
    // project's own row order (sort_order) once effectiveStart floors
    // tie. The fix is to stop artificially advancing this floor at all:
    // every no-dependency sibling just anchors to the same starting
    // point (this project's own anchor date), and the real scheduler
    // (buildForwardSchedule, read via computeEntry's "standard" branch)
    // does 100% of the actual packing/placement work from there. See
    // [[project_capaciq_scheduler_tiebreak_fix]] for the same fix applied
    // to the Refresh dates button, which had this exact bug independently
    // duplicated in its own re-seeding logic.
    const defaultDue = project.end_date ?? today;
    const { error } = await supabase.from("tasks").insert({
      project_id: project.id,
      name: "Untitled task",
      status: "Not Started",
      start_date: defaultStartFull, // legacy single field -- convenience placeholder for other pages until Save
      start_date_full: defaultStartFull,
      start_date_standard: defaultStartStandard,
      start_full_auto: true,
      start_standard_auto: true,
      original_due_date: defaultDue,
      current_due_date: defaultDue,
      sort_order: Date.now(),
    });
    if (error) {
      await alert(`Couldn't create task: ${error.message}`);
      return;
    }
    loadAll(true);
  }

  async function addSubtask(parent: TaskRow & { depth: number }) {
    if (parent.depth > 0) return; // only 2 layers total: parent + 1 sub-task level
    // Same bugfix as addTopLevelTask above -- flush staged edits before
    // this insert's own loadAll() can discard them.
    const flushed = await flushPendingEdits();
    if (!flushed) return;
    const projectAnchor = project?.start_date ? project.start_date.slice(0, 10) : fallbackStartDate;
    let defaultStartFull = parent.start_date_full ? parent.start_date_full.slice(0, 10) : projectAnchor;
    let defaultStartStandard = parent.start_date_standard ? parent.start_date_standard.slice(0, 10) : projectAnchor;
    // 2026-08-26 bugfix -- same fix as addTopLevelTask above, scoped to
    // this parent's own children: no longer chains a new sub-task's
    // Theoretical default Start after the last sibling's end (list-order
    // based, assignee-blind); it anchors to the parent's own Start
    // instead, matching Capacity-Based's already-fixed behavior below.
    // Phase 22 bugfix -- same fix as addTopLevelTask above, scoped to
    // this parent's own children: no longer advances past a sibling's
    // end for Capacity-Based, since the real scheduler already packs
    // correctly once floors don't artificially skip ahead.
    const { error } = await supabase.from("tasks").insert({
      project_id: parent.project_id,
      parent_task_id: parent.id,
      name: "Untitled sub-task",
      status: "Not Started",
      start_date: defaultStartFull,
      start_date_full: defaultStartFull,
      start_date_standard: defaultStartStandard,
      start_full_auto: true,
      start_standard_auto: true,
      original_due_date: parent.current_due_date,
      current_due_date: parent.current_due_date,
      sort_order: Date.now(),
    });
    if (error) {
      await alert(`Couldn't add subtask: ${error.message}`);
      return;
    }
    loadAll(true);
  }

  // Sandra, 2026-07-24: "Allow deleting of tasks in WBS. Right now we can
  // add but no option to delete." Mirrors Projects.tsx's own bulk-delete
  // convention exactly -- same `delete_tasks_and_dependents` RPC (already
  // clears task_dependencies in both FK directions as of this same
  // round's migration, see [[project_capaciq_wbs_planning]]), same
  // "deleting a parent also deletes its own sub-tasks" bundling, same
  // hard-delete confirm copy (tasks are always hard-deleted on this page,
  // never soft-archived -- only Projects get the 30-day archive/restore
  // treatment).
  async function deleteTask(t: TaskRow & { depth: number }) {
    const childIds = t.depth === 0 ? tasks.filter((x) => x.parent_task_id === t.id).map((x) => x.id) : [];
    const allIds = [t.id, ...childIds];
    const ok = await confirm({
      title: "Delete task",
      message: `Delete "${t.name}"${childIds.length ? ` (and ${childIds.length} sub-task${childIds.length > 1 ? "s" : ""})` : ""}? This can't be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    // Same bugfix as addTopLevelTask/addSubtask -- flush staged edits on
    // OTHER tasks first, so deleting one task can't silently discard
    // unsaved edits sitting on a different row.
    const flushed = await flushPendingEdits();
    if (!flushed) return;
    const { error } = await supabase.rpc("delete_tasks_and_dependents", { p_task_ids: allIds });
    if (error) {
      await alert(`Couldn't delete: ${error.message}`);
      return;
    }
    loadAll(true);
  }

  // Drag-reorder within siblings only -- see draggedTaskId comment above.
  // Purely reassigns sort_order (evenly spaced so future inserts/drags
  // have room); never touches any date field.
  function siblingsFor(t: TaskRow & { depth: number }): (TaskRow & { depth: number })[] {
    return t.depth === 0 ? orderedTasks.filter((x) => x.depth === 0) : orderedTasks.filter((x) => x.depth === 1 && x.parent_task_id === t.parent_task_id);
  }

  async function reorderTask(draggedId: string, targetId: string) {
    if (draggedId === targetId) return;
    const dragged = orderedTasks.find((x) => x.id === draggedId);
    const target = orderedTasks.find((x) => x.id === targetId);
    if (!dragged || !target) return;
    if (dragged.depth !== target.depth || dragged.parent_task_id !== target.parent_task_id) return; // different group -- ignore
    const group = siblingsFor(dragged);
    const withoutDragged = group.filter((x) => x.id !== draggedId);
    const targetIndex = withoutDragged.findIndex((x) => x.id === targetId);
    const reordered = [...withoutDragged.slice(0, targetIndex), dragged, ...withoutDragged.slice(targetIndex)];
    const updates = reordered.map((x, i) => ({ id: x.id, sort_order: (i + 1) * 1000 }));
    setTasks((prev) =>
      prev.map((x) => {
        const u = updates.find((uu) => uu.id === x.id);
        return u ? { ...x, sort_order: u.sort_order } : x;
      })
    );
    for (const u of updates) {
      await supabase.from("tasks").update({ sort_order: u.sort_order }).eq("id", u.id);
    }
  }

  // "Refresh dates" (Sandra, 2026-07-28): the grip-handle reorder above is
  // purely visual -- it doesn't recompute anyone's Start. This button
  // re-seeds Start for every task still on "auto pilot" (not manually
  // overridden) to a fresh, internally-consistent schedule: a task with a
  // "Depends on" link starts the day after that dependency's (freshly
  // recomputed) End; a task with no dependency chains after the previous
  // task in schedule order, same default-seeding math `addTopLevelTask`/
  // `addSubtask` already use for a brand-new task. Root tasks chain among
  // other root tasks; a parent's own sub-tasks chain only among their own
  // siblings (mirrors buildChain's own two-tier structure).
  async function refreshDates() {
    // Round 17 bugfix (Sandra): repeated clicks kept pushing tasks further
    // out. Round 17's first fix just froze any task that was itself a
    // dependency TARGET (e.g. "New Task Insert", depended on by "Task 3
    // Sub 1") -- stable, but frozen at whatever stale value it already
    // had, which is exactly why Task 3's whole branch kept showing
    // October dates that didn't trace back to anything on screen.
    //
    // Round 18 (this fix, Sandra: "check start and end dates... it's not
    // making sense anymore"): the real problem was re-chaining ROOT tasks
    // in raw LIST order while a "Depends on" link can point in a
    // different structural direction than that list order (a task can
    // depend on something listed AFTER it). Rather than freezing the
    // predecessor, schedule ROOT-level groups in an order that respects
    // BOTH constraints: whatever a group's members depend on (via an
    // explicit "Depends on" link crossing into another group) must be
    // computed first, before that group itself, regardless of row
    // position; ties break by the existing row order. Dependency-driven
    // tasks (a child or root with a real "Depends on" link) then get
    // their Start recomputed from that predecessor's freshly-computed End
    // in THIS SAME PASS -- not left frozen -- so Refresh always produces
    // one coherent, non-circular schedule instead of silently reusing
    // whatever value happened to be sitting in the DB before.
    const patches = new Map<string, Partial<TaskRow>>();
    function patchFor(id: string): Partial<TaskRow> {
      const existing = patches.get(id) ?? {};
      patches.set(id, existing);
      return existing;
    }
    // Any task id -> the id of its own top-level root ancestor (itself if
    // it already is one) -- used to compare a dependency's target against
    // which ROOT GROUP it structurally belongs to.
    function rootIdOf(taskId: string): string {
      const t = orderedTasks.find((x) => x.id === taskId);
      if (!t) return taskId;
      return t.depth === 0 ? t.id : t.parent_task_id ?? t.id;
    }
    const roots = orderedTasks.filter((x) => x.depth === 0);
    // Root-level dependency graph: rootId -> set of OTHER root ids it (or
    // any of its own sub-tasks) has a real "Depends on" link into.
    const rootDeps = new Map<string, Set<string>>();
    for (const root of roots) {
      const members = hasChildren(root.id)
        ? [root, ...orderedTasks.filter((c) => c.depth === 1 && c.parent_task_id === root.id)]
        : [root];
      const depSet = new Set<string>();
      for (const m of members) {
        for (const depId of dependsOnIdsFor(m.id)) {
          const depRoot = rootIdOf(depId);
          if (depRoot !== root.id) depSet.add(depRoot);
        }
      }
      rootDeps.set(root.id, depSet);
    }
    // Topological order over root groups (dependency targets first),
    // falling back to original row order whenever nothing is blocking (or
    // to break an unresolved cycle, so this can never hang).
    const scheduleOrder: typeof roots = [];
    const placed = new Set<string>();
    while (scheduleOrder.length < roots.length) {
      let pick = roots.find(
        (r) => !placed.has(r.id) && [...(rootDeps.get(r.id) ?? [])].every((d) => placed.has(d))
      );
      if (!pick) pick = roots.find((r) => !placed.has(r.id));
      if (!pick) break;
      scheduleOrder.push(pick);
      placed.add(pick.id);
    }
    for (const mode of MODES) {
      const startField = mode === "full_capacity" ? "start_date_full" : "start_date_standard";
      const autoField = mode === "full_capacity" ? "start_full_auto" : "start_standard_auto";
      function entryWithOverride(t: TaskRow, overrideStart?: string): ChainEntry | null {
        if (!overrideStart) return computeEntry(t, mode);
        if (t.estimated_hours === null || t.estimated_hours === undefined) return null;
        const isFixedSchedule = !!t.work_type_id && workTypes.find((w) => w.id === t.work_type_id)?.is_fixed_schedule;
        if (mode === "full_capacity" || isFixedSchedule) {
          // Phase 3 (2026-08-21): a Fixed-Schedule task (e.g. Training
          // Delivery) is never capacity-gated by competing work, even
          // under Capacity-Based mode -- same full-day-ceiling assumption
          // as Full Effort, so its own duration reflects its hours vs a
          // full day, not whatever's left after other people's queued
          // work. See capacityScheduler.ts's fixedQueue pass for the
          // matching change to the whole-queue walk this override
          // recomputes a hypothetical alternative to.
          const r = fullCapacityScenario(t.estimated_hours, overrideStart, holidaySet);
          return { start: overrideStart, end: r.dueDate, durationDays: r.wholeDays, rawDays: r.rawDays };
        }
        // Capacity-Based override: re-walk from this NEW proposed start
        // using the assignee's real remaining daily capacity, same idea
        // as computeEntry's "standard" branch -- but computed fresh for
        // this hypothetical start rather than reading the precomputed
        // whole-queue answer, since that precomputed schedule still
        // reflects this task's OLD (not-yet-saved) start_date_standard.
        // Adds this task's own already-counted hours back into each
        // day's free capacity so it doesn't get blocked by its own prior
        // placement.
        if (!t.assignee_id) return null;
        const sched = scheduleFor(t.assignee_id);
        const remainingHoursOnDate = (dateStr: string) => {
          const day = sched.perDay.get(dateStr);
          if (!day) return people.find((p) => p.id === t.assignee_id)?.daily_capacity_hours ?? 0;
          const own = day.taskHours.get(t.id) ?? 0;
          return Math.max(0, day.capacity - day.totalHours + own);
        };
        const r = capacityBasedScenario(t.estimated_hours, overrideStart, holidaySet, remainingHoursOnDate);
        return { start: overrideStart, end: r.dueDate, durationDays: r.wholeDays, rawDays: r.rawDays };
      }
      // Entries computed so far THIS pass, keyed by task id (root ids and
      // child ids alike) -- lets a dependency lookup see a predecessor's
      // brand-new End even when that predecessor is being recomputed in
      // this very same Refresh click.
      const entries = new Map<string, ChainEntry>();
      // Round 19 (Sandra: "Refresh dates does not reset the first task on
      // the list to follow the start date set in the project details"):
      // the very first task in the whole schedule had nothing to chain
      // from (`chainPrev` null), so it always fell back to whatever its
      // OWN stored Start field already was -- silently ignoring the
      // project's own Start date field entirely, even though
      // `addTopLevelTask`/`addSubtask` already treat that field as the
      // anchor for a brand-new first task. `anchorStart` now plays that
      // same role inside Refresh: only used the one time there's truly
      // nothing earlier (first root, or first child of the first root
      // group) to chain from.
      const projectAnchor = project?.start_date ? project.start_date.slice(0, 10) : fallbackStartDate;
      // Bugfix (2026-08-25, Sandra: "Theoretical [full effort] task are
      // not more than 7.5 hours but... say 4 working days?"): this
      // branch used to always chain a no-dependency sibling to the NEXT
      // working day after its predecessor, for BOTH Manual and
      // Theoretical (full_capacity) modes -- ignoring same-day capacity
      // left over from the predecessor. Superseded 2026-08-26: Theoretical
      // now packs same-person, same-project siblings continuously via
      // theoreticalScheduleFor/packFullCapacityQueue (with real
      // multi-day splitting, not just a same-day-fits-or-defer-whole
      // check), so Refresh no longer needs its own copy of that logic --
      // see the "full_capacity" branch below, which now just anchors the
      // very first task in a root group and leaves everyone else to the
      // live packer.
      function scheduledEntry(t: TaskRow, chainPrev: ChainEntry | null, anchorStart?: string, siblingIdsSoFar: string[] = []): ChainEntry | null {
        // Done tasks are historical -- Refresh dates should never push
        // their Start to follow a predecessor's new End, same reasoning
        // as the Done-lock in computeEntry above.
        if (t.status === "Done") return computeEntry(t, mode);
        const depIds = dependsOnIdsFor(t.id);
        const isAuto = t[autoField] !== false;
        let overrideStart: string | undefined;
        if (depIds.length && isAuto) {
          let latest: string | null = null;
          for (const depId of depIds) {
            const depEntry = entries.get(depId);
            if (!depEntry) continue;
            const candidate = nextWorkingDayAfter(depEntry.end, holidaySet);
            if (!latest || candidate > latest) latest = candidate;
          }
          if (latest) overrideStart = latest;
        } else if (!depIds.length && isAuto && mode === "full_capacity") {
          // Bugfix (2026-08-26): the live Theoretical packer
          // (computeEntry -> theoreticalScheduleFor, taskScheduling.ts's
          // packFullCapacityQueue) now handles same-person, same-project
          // day-packing continuously on every render -- writing a
          // pre-packed guess here (this used to decide "fits in the
          // predecessor's own leftover same day, or defer the WHOLE task
          // to the next day") would fight it, since the live packer
          // treats whatever's stored in start_date_full as a hard floor
          // and can't pull a task earlier than a value Refresh just
          // wrote here. Only the very first task in a root group still
          // needs an explicit anchor (nothing else to chain from); every
          // other no-dependency sibling is left alone so the live packer
          // decides its real placement, same as it already does without
          // ever clicking Refresh.
          if (!chainPrev && anchorStart) overrideStart = anchorStart;
        } else if (!depIds.length && isAuto) {
          if (mode === "standard") {
            // Phase 22 bugfix (see [[project_capaciq_scheduler_tiebreak_fix]]):
            // Refresh dates independently duplicated the same
            // day-after-predecessor advancement that addTopLevelTask/
            // addSubtask used to have -- forcing every no-dependency
            // sibling onto the NEXT calendar day regardless of same-day
            // capacity left on the predecessor's own day. Capacity-Based
            // already has a real packing-aware engine (buildForwardSchedule,
            // via computeEntry/entryWithOverride's "standard" branch
            // above), so every such sibling anchors to the SAME starting
            // point instead (the chain's own anchor date, propagated
            // forward via chainPrev.start rather than chainPrev.end) and
            // lets that engine's own sort_order tiebreak decide real
            // placement/order.
            if (anchorStart) overrideStart = anchorStart;
            else if (chainPrev) overrideStart = chainPrev.start;
          } else {
            if (chainPrev) overrideStart = nextWorkingDayAfter(chainPrev.end, holidaySet);
            else if (anchorStart) overrideStart = anchorStart;
          }
        }
        const entry = entryWithOverride(t, overrideStart);
        if (overrideStart && entry) (patchFor(t.id) as Record<string, unknown>)[startField] = overrideStart;
        return entry;
      }
      let lastRootEntry: ChainEntry | null = null;
      const rootIdsSoFar: string[] = [];
      for (const root of scheduleOrder) {
        const isFirstGroup = lastRootEntry === null;
        if (hasChildren(root.id)) {
          let lastSiblingEntry: ChainEntry | null = null;
          const children = orderedTasks.filter((c) => c.depth === 1 && c.parent_task_id === root.id);
          const childEntries: ChainEntry[] = [];
          const childIdsSoFar: string[] = [];
          for (const child of children) {
            const isFirstChild = lastSiblingEntry === null;
            const entry = scheduledEntry(child, lastSiblingEntry, isFirstGroup && isFirstChild ? projectAnchor : undefined, childIdsSoFar);
            if (entry) {
              entries.set(child.id, entry);
              lastSiblingEntry = entry;
              childEntries.push(entry);
              childIdsSoFar.push(child.id);
            }
          }
          if (childEntries.length) {
            const start = childEntries.reduce((min, e) => (e.start < min ? e.start : min), childEntries[0].start);
            const end = childEntries.reduce((max, e) => (e.end > max ? e.end : max), childEntries[0].end);
            const groupEntry = { start, end, durationDays: 0 };
            entries.set(root.id, groupEntry);
            lastRootEntry = groupEntry;
          }
        } else {
          const entry = scheduledEntry(root, lastRootEntry, isFirstGroup ? projectAnchor : undefined, rootIdsSoFar);
          if (entry) {
            entries.set(root.id, entry);
            lastRootEntry = entry;
            rootIdsSoFar.push(root.id);
          }
        }
      }
    }
    if (patches.size === 0) {
      await alert("Nothing to refresh -- every task's Start is either manually set or already tracking a dependency.");
      return;
    }
    for (const [id, patch] of patches) {
      await saveTaskField(id, patch);
    }
  }

  // Phase 6 (2026-08-21): field edits no longer write to Supabase
  // instantly -- they stage into pendingTaskPatches/pendingProjectPatch
  // (merged with any earlier unflushed edit to the same task) and mark
  // hasUnsavedChanges, same "editing session, explicit Save" model Sandra
  // asked for. The optimistic local setTasks/setProject update still
  // happens immediately so the UI reflects what you typed right away --
  // it just doesn't reach the database until Save (flushPendingEdits,
  // called from saveDraft below) runs. NOTE: this means DB-trigger-
  // computed columns (e.g. `effort`, derived from `estimated_hours` per
  // Phase 12) won't reflect the new value in the UI until Save actually
  // writes it and this page reloads -- an accepted tradeoff of staging,
  // not a regression (see [[project_capaciq_wbs_effort_staleness_fix]]
  // for the older, now-superseded instant-write version of this concern).
  function saveTaskField(taskId: string, patch: Partial<TaskRow>) {
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, ...patch } : t)));
    const existing = pendingTaskPatches.current.get(taskId) ?? {};
    pendingTaskPatches.current.set(taskId, { ...existing, ...patch });
    setHasUnsavedChanges(true);
  }

  function saveProjectField(patch: Partial<ProjectRow>) {
    if (!project) return;
    setProject((prev) => (prev ? { ...prev, ...patch } : prev));
    pendingProjectPatch.current = { ...pendingProjectPatch.current, ...patch };
    setHasUnsavedChanges(true);
  }

  // Flushes every staged field edit to Supabase -- called at the top of
  // saveDraft (the page's one Save button) before it does its own
  // schedule-computation writes. Returns false (and alerts) on failure so
  // saveDraft can bail rather than compute/snapshot dates on top of a
  // half-saved edit. Re-selects each touched task afterward for the same
  // DB-trigger-computed-column reason saveTaskField's old instant-write
  // version used to (see comment above).
  async function flushPendingEdits(): Promise<boolean> {
    const taskEntries = Array.from(pendingTaskPatches.current.entries());
    for (const [taskId, patch] of taskEntries) {
      const { data, error } = await supabase.from("tasks").update(patch).eq("id", taskId).select().single();
      if (error) {
        await alert(`Couldn't save: ${error.message}`);
        loadAll();
        return false;
      }
      if (data) {
        setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, ...(data as Partial<TaskRow>) } : t)));
      }
    }
    if (project && Object.keys(pendingProjectPatch.current).length > 0) {
      const { error } = await supabase.from("projects").update(pendingProjectPatch.current).eq("id", project.id);
      if (error) {
        await alert(`Couldn't save: ${error.message}`);
        loadAll();
        return false;
      }
    }
    pendingTaskPatches.current = new Map();
    pendingProjectPatch.current = {};
    setHasUnsavedChanges(false);
    return true;
  }

  // Soft completeness gate -- mirrors the Task name / Effort part of the
  // Projects table's own Lock policy. Round 11: conflict check now covers
  // BOTH modes always (not just whichever is toggled active), since the
  // scoping table itself shows both modes' Start/End side by side
  // regardless of the toggle now.
  function softIssues(): string[] {
    const issues: string[] = [];
    const noName = orderedTasks.filter((t) => !t.name || !t.name.trim() || t.name === "Untitled task" || t.name === "Untitled sub-task");
    // Phase 24 bugfix (2026-08-24, Sandra: "this should not be an error
    // too since it should auto"): this used to check `!t.effort`, but
    // `effort` is a DB-trigger-derived column (derive_effort_level, see
    // phase12_migration.sql) that only gets recomputed when a task's
    // estimated_hours patch actually round-trips to Postgres. Since
    // saveTaskField only STAGES edits into pendingTaskPatches now (staged
    // Save flow, see [[project_capaciq_phase6_baseline_approval]]) rather
    // than writing instantly, the local `effort` field stays stale --
    // often null on a brand-new task -- right up until Save's own
    // flushPendingEdits() round-trip, even after hours have been typed.
    // softIssues() runs BEFORE that flush, so it was flagging tasks that
    // WILL derive a correct Effort the instant Save actually writes them.
    // The real precondition is estimated_hours being set at all (NULL
    // hours -> NULL effort; any other value, including 0, always derives
    // to some level) -- so check that instead of the lagging derived
    // column.
    const noEffort = orderedTasks.filter((t) => t.estimated_hours == null && !(t.depth === 0 && hasChildren(t.id)));
    // 2026-08-26 (Sandra: "I tried to move a task with dependency to an
    // earlier date than the dependency's end date but the warning shown
    // was on the Capacity-Based start date" -- i.e. this aggregate
    // pre-Save check used to also test the now-removed "standard"
    // (Capacity-Based) mode, so a conflict only visible on that hidden
    // column still surfaced a warning with nowhere for her to actually
    // see or resolve it. Only Theoretical (full_capacity) has its own
    // real column left to check against.
    const conflicted = orderedTasks.filter((t) => dependencyConflict(t, "full_capacity"));
    if (noName.length) issues.push(`${noName.length} task(s) still have a placeholder name.`);
    if (noEffort.length) issues.push(`${noEffort.length} task(s) still need an Effort level.`);
    if (conflicted.length)
      issues.push(`${conflicted.length} task(s) start on or before a dependency's own End under at least one mode -- double-check those Start dates.`);
    return issues;
  }

  // Total effort for the whole project -- summed from top-level tasks
  // only (a parent's own Est. hrs already mirrors the sum of its
  // sub-tasks via the rollup effect above).
  const totalEffortHours = Math.round(
    orderedTasks
      .filter((t) => t.depth === 0)
      .reduce((sum, t) => sum + (t.estimated_hours ?? 0), 0) * 100
  ) / 100;

  // Project-level projected span under a given mode: earliest Start /
  // latest End among every task's entry in that mode's chain.
  function chainOverallSummary(chain: Map<string, ChainEntry | null>): { start: string | null; end: string | null; durationDays: number; complete: boolean } {
    let start: string | null = null;
    let end: string | null = null;
    let complete = true;
    for (const t of orderedTasks) {
      const entry = chain.get(t.id);
      if (!entry) {
        complete = false;
        continue;
      }
      if (!start || entry.start < start) start = entry.start;
      if (!end || entry.end > end) end = entry.end;
    }
    const durationDays = start && end ? workingDaysBetween(parseLocalDate(start), parseLocalDate(end), holidaySet).length : 0;
    return { start, end, durationDays, complete };
  }

  async function saveDraft() {
    if (!project || !projectId) return;

    const chosenChain = chainByMode[activeMode];
    const unresolved = orderedTasks.filter((t) => !chosenChain.get(t.id));
    if (unresolved.length) {
      await alert(
        `Can't save ${MODE_LABEL[activeMode]} yet -- ${unresolved.length} task(s) don't have a schedule under it. Add a Start date and Estimated hours for every task first.`
      );
      return;
    }

    // Sandra, 2026-08-26: "allow saving even WBS data is not complete
    // yet -- only push to fill in all needed info when requesting for
    // Baseline Approval." softIssues() (placeholder names, missing
    // Effort/hours, dependency-date conflicts) used to hard-block Save
    // itself; that gate now lives on handleRequestBaseline instead, so a
    // draft can be saved at any stage of completeness. See
    // [[project_capaciq_wbs_planning]].

    const verb = MODE_LABEL[activeMode];
    // Phase 6 (2026-08-21): replaces the old "applyingRevision" branch --
    // there's no more manual Start Revision, so the only status-specific
    // behavior Save needs is: if this project is Baseline Locked and
    // you're editing it (exactly what Phase 6 now allows without an
    // extra click), Save is what actually records that an edit happened
    // and flips status to Changed After Baseline (record_wbs_edit below).
    const wasBaselineLocked = project.wbs_status === "baseline_locked";
    const confirmMsg = wasBaselineLocked
      ? `Save this project's timelines using ${verb}?\n\nThis writes every task's computed End date, records both modes for reporting, and marks the project Changed After Baseline since this is an edit made after the Baseline was locked.`
      : `Save this project's timelines using ${verb}?\n\nThis writes every task's computed End date (Start dates are already saved per-task) and records both modes for reporting.${
          project.wbs_status === "draft" ? " Nothing is locked yet -- use Start Project from the actions above when you're ready." : ""
        }`;
    if (!(await confirm(confirmMsg))) return;

    setSaving(true);
    try {
      // Flush every staged field edit (name/hours/assignee/etc. -- see
      // saveTaskField/saveProjectField above) before this Save's own
      // schedule-computation writes below.
      const flushed = await flushPendingEdits();
      if (!flushed) return;

      // Bugfix (2026-08-24, found in post-ship audit): every write in this
      // loop used to be fire-and-forget -- if one task's date write failed
      // partway through (RLS hiccup, network blip), the screen still
      // showed the new dates via setTasks while the DB silently kept the
      // old ones. This is the exact "silent bad save" failure mode the
      // 2026-08-20 quality audit flagged as the single most dangerous
      // pattern in the app (Day Planner's edit/clear-hours had the same
      // bug and was fixed then) -- it just hadn't been checked here.
      // Every write below now surfaces its error and stops the loop
      // rather than continuing to optimistically update local state.
      const batchId = crypto.randomUUID();
      for (const t of orderedTasks) {
        const chosen = chosenChain.get(t.id);
        if (!chosen) continue;

        // Bugfix (2026-08-26, Sandra: "I'm trying to save output count
        // but getting [this task is Done -- its scoping fields... are
        // locked]"): this loop used to unconditionally rewrite EVERY
        // task's start_date/current_due_date on every Save, including
        // Done tasks -- so any Save at all (even one only meant to
        // persist an Output Count edit staged via saveTaskField/
        // flushPendingEdits above) collaterally tripped
        // enforce_done_task_lock the moment the freshly recomputed
        // schedule date for a Done task differed from its frozen DB
        // value. A Done task's start date is supposed to be historical
        // -- same reasoning as the rest of the scoping-field lock -- so
        // skip the actual date WRITE for Done tasks. The schedule chain
        // still computed `chosen` from their (frozen) dates for any
        // downstream dependency math, we just don't write it back; the
        // snapshot/Audit Trail recording below is unaffected either way.
        if (t.status !== "Done") {
          const patch: Partial<TaskRow> = { start_date: chosen.start, current_due_date: chosen.end };
          const { error: taskDateError } = await supabase.from("tasks").update(patch).eq("id", t.id);
          if (taskDateError) {
            await alert(`Couldn't save "${t.name}"'s dates: ${taskDateError.message}. Stopping here -- reloading to show what actually saved.`);
            await loadAll();
            return;
          }
          setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, ...patch } : x)));
        }

        const snapshotRows = MODES.map((m) => ({ m, entry: chainByMode[m].get(t.id) }))
          .filter((x): x is { m: Mode; entry: ChainEntry } => !!x.entry)
          .map(({ m, entry }) => ({
            task_id: t.id,
            finalize_batch_id: batchId,
            mode: m,
            applied: m === activeMode,
            target_start_date: entry.start,
            person_id: null,
            raw_days: entry.rawDays ?? null,
            whole_days: entry.durationDays,
            computed_due_date: entry.end,
            computed_by: me?.id ?? null,
          }));
        if (snapshotRows.length) {
          const { error: snapshotError } = await supabase.from("task_planning_snapshots").insert(snapshotRows);
          if (snapshotError) {
            // Lower stakes than the date write above (this only feeds the
            // Audit Trail's history, not live dates) -- warn but don't
            // abort the rest of the Save.
            console.error("Couldn't record planning snapshot for task", t.id, snapshotError);
          }
        }
      }
      const { error: scopingModeError } = await supabase.from("projects").update({ scoping_effort_mode: activeMode }).eq("id", project.id);
      if (scopingModeError) {
        await alert(`Timelines were saved, but the project's Scoping Effort setting couldn't be updated: ${scopingModeError.message}`);
        await loadAll();
        return;
      }

      if (wasBaselineLocked) {
        const { error } = await supabase.rpc("record_wbs_edit", { p_project_id: project.id });
        if (error) {
          await alert(`Timelines were saved, but the project's status couldn't be updated: ${error.message}`);
          await loadAll();
          return;
        }
      }

      // Bugfix (2026-08-26, Sandra: "there seems to be a bug when we are
      // updating the WBS, the scenarios view always ends up being the
      // same") -- loadAll()'s default (non-silent) mode flips `loading`
      // true/false, which unmounts this whole page behind the bare
      // "Loading..." early-return guard and remounts it fresh once data
      // arrives. That wiped every local UI-only toggle back to its
      // useState default on every single Save -- visibleScenarios (the
      // Forecasted/Capacity-Based checkboxes) chief among them, since
      // whatever Sandra had picked before Save always reset to "all
      // shown" after. Same root cause and same fix already established
      // for add/delete task (see loadAll's own comment above) -- pass
      // silent=true so state still refreshes underneath without the
      // full unmount/remount.
      await loadAll(true);
      await alert("Timelines have been saved. To lock this schedule, request Baseline.");
    } finally {
      setSaving(false);
    }
  }

  // Must run unconditionally (Rules of Hooks) -- before the loading/
  // not-found early returns below.
  useUnsavedChangesGuard(hasUnsavedChanges);

  if (loading) return <div style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>Loading…</div>;
  if (!project) return <div style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>Project not found.</div>;

  // Phase 2/3 authorization -- mirrors can_manage_wbs()/can_decide_closure()
  // on the DB side (flat tiering, Sandra 2026-07-28): Full Access or the
  // project's own owner can drive Lock/Revision/Closure-request; closure
  // DECISIONS additionally open up to anyone flagged can_approve_closures.
  const canManageWbs = isFullAccess || me?.id === project.owner_id;
  const canDecideClosure = isFullAccess || !!me?.can_approve_closures || me?.id === project.owner_id;
  // Phase 6 (2026-08-21): deciding a pending Baseline Approval request is
  // STRICTLY gated on can_approve_rebaseline -- Sandra's explicit choice,
  // unlike Close's canDecideClosure above. Owner/Full Access do NOT
  // auto-qualify here; a project with no one flagged simply has no
  // eligible approver yet.
  const canDecideBaselineRequest = !!me?.can_approve_rebaseline;
  // Sandra, 2026-08-21 (Phase 6): removed the requirement to click "Start
  // Revision" before editing a Baseline-Locked/Changed-After-Baseline
  // project -- editing is open the whole time a baseline exists, exactly
  // as it always was in Draft. Only Closed is genuinely read-only now.
  // (Editability itself has never been permission-gated on this page --
  // canEditWbs was always purely a status check, same as before.)
  const canEditWbs = project.wbs_status !== "closed";
  // Sandra, 2026-07-29: "if one task has been completed... shall we
  // still allow changing of project start date?" -- no. Once any task
  // is Done, the project has genuinely started, so the project's own
  // Start date becomes historical fact too, same reasoning as the
  // per-task Done-lock above. Locked regardless of canEditWbs/revision
  // status.
  const anyTaskDone = tasks.some((t) => t.status === "Done");

  // Design spec item 7 (Sandra, 2026-07-29): group the latest applied
  // revision's changes by task_id for the task list's Changes/Notes
  // columns, and reduce them into aggregate counts for the Revision
  // Summary panel -- see loadLatestRevisionChanges() above for how this
  // is fetched. change_type values come straight from the
  // project_revision_changes CHECK constraint (phase1_migration.sql):
  // task_added/task_removed/hours_changed/date_changed/
  // dependency_changed/assignee_changed.
  const CHANGE_DOT_COLOR: Record<string, string> = {
    task_added: "#3f9d6e",
    hours_increased: "#3f9d6e",
    hours_decreased: "#c1443c",
    date_changed: "#b8860b",
    dependency_changed: "#7b4fb0",
    assignee_changed: "#2e75b6",
  };
  const CHANGE_TYPE_SHORT_LABEL: Record<string, string> = {
    task_added: "New task",
    hours_increased: "Increased",
    hours_decreased: "Decreased",
    date_changed: "Date changed",
    dependency_changed: "Dependency changed",
    assignee_changed: "Assignee changed",
  };
  function taskChangeKind(c: RevisionChangeRow): keyof typeof CHANGE_DOT_COLOR | null {
    if (c.change_type === "task_added") return "task_added";
    if (c.change_type === "hours_changed") {
      const prev = Number(c.previous_value ?? 0);
      const next = Number(c.new_value ?? 0);
      return next > prev ? "hours_increased" : "hours_decreased";
    }
    if (c.change_type === "date_changed") return "date_changed";
    if (c.change_type === "dependency_changed") return "dependency_changed";
    if (c.change_type === "assignee_changed") return "assignee_changed";
    return null;
  }
  // Design spec item 4 (Sandra, 2026-07-29 follow-up): per-task diff
  // against the active Baseline V<n> snapshot -- this is what actually
  // drives the task list's Changes/Notes columns now (see her reference
  // mockup screenshot: "Changes vs Baseline V1" + a Notes column, NOT the
  // latest-revision log). Reuses the same CHANGE_DOT_COLOR palette/legend
  // as the revision-log-based Revision Summary panel below for visual
  // consistency, even though the two now read from different sources.
  function taskBaselineDiff(t: TaskRow & { depth: number }, isParent: boolean): { isNew: boolean; kinds: (keyof typeof CHANGE_DOT_COLOR)[]; notes: string[] } {
    const baseline = baselineTasksById[t.id];
    if (!baseline) {
      // Bugfix (2026-08-26, Sandra: "when I try to add hours, it's no
      // longer capturing it in the changes vs baseline -- I don't also
      // see added hours in a New Task after baseline. Yes it captures it
      // in the variance but not in the Change vs Baseline"): the
      // ownChanges check below (this task's own history in
      // project_revision_changes) only ever gets populated when a
      // RE-BASELINE is actually approved (see decide_baseline_request in
      // phase15/phase24_migration.sql) -- between baseline events it's
      // always empty, so this branch always fell back to a bare "New
      // task" with hours nowhere to be seen, exactly the gap Sandra
      // hit. Fixed to always show the task's current hours directly --
      // live, not dependent on the revision log -- alongside "New task":
      // there's no baseline row for a brand-new task, so its full
      // current hours ARE the "new" amount by definition, no diffing
      // needed. ownChanges is kept below (now excluding hours, which the
      // line above already covers) so anything the revision log DOES
      // capture once re-baselining is actually used again -- an
      // assignee/date/dependency change on a still-new task -- still
      // shows, instead of dropping that case entirely.
      const kinds: (keyof typeof CHANGE_DOT_COLOR)[] = ["task_added"];
      const notes: string[] = ["New task"];
      if (!isParent && (t.estimated_hours ?? 0) > 0) {
        kinds.push("hours_increased");
        notes.push(`+${t.estimated_hours}h`);
      }
      const ownChanges = (changesByTaskId[t.id] ?? [])
        .filter((c) => c.change_type !== "task_added" && c.change_type !== "hours_changed")
        .sort((a, b) => (b.changed_at ?? "").localeCompare(a.changed_at ?? ""));
      if (ownChanges.length > 0) {
        const latest = ownChanges[0];
        const kind = taskChangeKind(latest);
        if (kind) {
          kinds.push(kind);
          notes.push(CHANGE_TYPE_SHORT_LABEL[kind] ?? kind.replace(/_/g, " "));
        }
      }
      return { isNew: true, kinds, notes };
    }
    const kinds: (keyof typeof CHANGE_DOT_COLOR)[] = [];
    const notes: string[] = [];

    if (!isParent) {
      const currentHours = t.estimated_hours ?? 0;
      const baseHours = baseline.estimated_hours ?? 0;
      if (currentHours !== baseHours) {
        const delta = currentHours - baseHours;
        if (delta > 0) {
          kinds.push("hours_increased");
          notes.push(`+${delta}h`);
        } else {
          kinds.push("hours_decreased");
          notes.push(`${delta}h`);
        }
      }
    }

    const currentEnd = chainByMode.full_capacity.get(t.id)?.end;
    if (currentEnd && baseline.end_date_full && currentEnd !== baseline.end_date_full) {
      const deltaDays = Math.round((parseLocalDate(currentEnd).getTime() - parseLocalDate(baseline.end_date_full).getTime()) / 86400000);
      kinds.push("date_changed");
      notes.push(`${deltaDays > 0 ? "+" : ""}${deltaDays}d`);
    }

    const currentAssigneeName = people.find((p) => p.id === t.assignee_id)?.name ?? null;
    if ((currentAssigneeName ?? null) !== (baseline.assignee_name ?? null)) {
      kinds.push("assignee_changed");
      notes.push("Assignee changed");
    }

    const currentDeps = [...dependsOnIdsFor(t.id)].sort();
    const baseDeps = [...(baseline.depends_on ?? [])].sort();
    if (JSON.stringify(currentDeps) !== JSON.stringify(baseDeps)) {
      kinds.push("dependency_changed");
      notes.push("Dependency changed");
    }

    return { isNew: false, kinds, notes };
  }

  const revisionSummary = {
    tasksAdded: latestRevisionChanges.filter((c) => c.change_type === "task_added").length,
    tasksRemoved: latestRevisionChanges.filter((c) => c.change_type === "task_removed").length,
    hoursIncreased: latestRevisionChanges.filter((c) => taskChangeKind(c) === "hours_increased").length,
    hoursDecreased: latestRevisionChanges.filter((c) => taskChangeKind(c) === "hours_decreased").length,
    datesChanged: latestRevisionChanges.filter((c) => c.change_type === "date_changed").length,
    dependenciesChanged: latestRevisionChanges.filter((c) => c.change_type === "dependency_changed").length,
    assigneesChanged: latestRevisionChanges.filter((c) => c.change_type === "assignee_changed").length,
    totalAddedHours: latestRevisionChanges
      .filter((c) => c.change_type === "hours_changed")
      .reduce((sum, c) => sum + (Number(c.new_value ?? 0) - Number(c.previous_value ?? 0)), 0),
  };

  // Phase 10 (2026-08-21): Sandra -- "color code each: Full Effort blue,
  // Capacity-Based green, Manual yellow" so the same scheduling method
  // always reads as the same color everywhere on the page (task table
  // columns AND the snapshot rows below, via UTIL_PREVIEW_COLOR). This is
  // now a persistent identity tint, not tied to any selected/toggled
  // mode -- there's no single "active" preview anymore since all 4
  // scenarios render as simultaneous rows.
  function modeColStyle(m: Mode): CSSProperties {
    // Phase 12 (2026-08-21): now 3 real columns -- Full Effort blue,
    // Capacity-Based green, Manual yellow -- matching UTIL_PREVIEW_COLOR
    // everywhere else on the page (snapshot rows, override pin).
    const color =
      m === "full_capacity"
        ? UTIL_PREVIEW_COLOR.full_capacity
        : m === "standard"
        ? UTIL_PREVIEW_COLOR.standard_suggested
        : UTIL_PREVIEW_COLOR.standard_committed;
    return { background: `${color}14` }; // ~8% opacity tint, hex alpha suffix
  }

  // Column resizing (see WBS_TASK_COLUMN_DEFAULTS above). wbsColWidth
  // reads from the ref during/after a drag; wbsColWidthsVersion exists
  // purely to force a rerender while dragging (the ref mutation itself
  // doesn't trigger one).
  function wbsColWidth(key: string): number {
    void wbsColWidthsVersion;
    return wbsColWidthsRef.current[key] ?? WBS_TASK_COLUMN_DEFAULTS[key] ?? 120;
  }
  function startWbsColResize(key: string, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const startWidth = wbsColWidth(key);
    wbsResizeState.current = { key, startX: e.clientX, startWidth };
    function onMove(ev: MouseEvent) {
      if (!wbsResizeState.current) return;
      const delta = ev.clientX - wbsResizeState.current.startX;
      const newWidth = Math.max(WBS_MIN_COL_WIDTH, wbsResizeState.current.startWidth + delta);
      wbsColWidthsRef.current = { ...wbsColWidthsRef.current, [wbsResizeState.current.key]: newWidth };
      setWbsColWidthsVersion((n) => n + 1);
    }
    function onUp() {
      if (wbsResizeState.current) {
        try {
          localStorage.setItem(WBS_COL_WIDTHS_STORAGE_KEY, JSON.stringify(wbsColWidthsRef.current));
        } catch {
          // ignore -- private browsing / storage full, resizing still
          // works for the rest of this session, it just won't persist
        }
      }
      wbsResizeState.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }
  // One resizable header cell -- rowSpan=2 (spans both header rows, same
  // as the plain <th>s it replaces), a drag handle on its right edge.
  // Freeze-pane sticky positioning, generalized to any resizable column
  // (2026-08-27) -- a column is sticky whenever a freeze point is set
  // AND this column sits at or before it in WBS_TASK_COLUMN_ORDER (the
  // table's current, fixed display order -- there's no column drag-
  // reorder on this page, unlike task rows). `left` is the cumulative
  // width of the gutter plus every earlier resizable column, so it
  // tracks live resizing exactly like the old Task-only freeze did.
  // Only the pinned column itself (the rightmost sticky one) gets the
  // boundary boxShadow; earlier sticky columns don't need their own,
  // same as before.
  function wbsColStickyStyle(colKey: string, isTd: boolean, rowLocked?: boolean): CSSProperties | undefined {
    const idx = WBS_TASK_COLUMN_ORDER.indexOf(colKey);
    const frozenIdx = wbsFreezeColKey ? WBS_TASK_COLUMN_ORDER.indexOf(wbsFreezeColKey) : -1;
    if (frozenIdx < 0 || idx < 0 || idx > frozenIdx) return undefined;
    let left = wbsFrozenGutterW;
    for (let i = 0; i < idx; i++) left += wbsColWidth(WBS_TASK_COLUMN_ORDER[i]);
    return {
      position: "sticky",
      left,
      zIndex: isTd ? 2 : 3,
      background: rowLocked ? "var(--hover-bg)" : "var(--surface)",
      ...(idx === frozenIdx ? { boxShadow: "1px 0 0 0 var(--border)" } : {}),
    };
  }
  // Same idea for the row-gutter column itself (always index -1, i.e.
  // "before" every resizable column) -- sticky whenever ANY column is
  // pinned, never carries the boundary boxShadow itself (that belongs to
  // whichever real column is actually the pinned one).
  function wbsGutterStickyStyle(isTd: boolean, rowLocked?: boolean): CSSProperties | undefined {
    if (!wbsFreezeColKey) return undefined;
    return { position: "sticky", left: 0, zIndex: isTd ? 2 : 3, background: rowLocked ? "var(--hover-bg)" : "var(--surface)" };
  }
  function ResizableTh({ colKey, title, children }: { colKey: string; title?: string; children: React.ReactNode }) {
    const w = wbsColWidth(colKey);
    // `position:relative` on an unfrozen header would break
    // `position:sticky` freezing that relies on the nearest scrolling
    // ancestor being the `.card` container, so it's only applied when
    // actually needed for the resize-handle overlay below (still fine to
    // combine with sticky -- sticky elements can be positioning contexts
    // too).
    const sticky = wbsColStickyStyle(colKey, false);
    const isPinned = wbsFreezeColKey === colKey;
    return (
      <th
        rowSpan={2}
        style={{
          width: w,
          minWidth: WBS_MIN_COL_WIDTH,
          maxWidth: w,
          position: sticky ? "sticky" : "relative",
          ...(sticky ?? {}),
        }}
        title={title}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          {children}
          {/* Freeze panes (2026-08-26, Sandra: "I want the freeze task
              pin to be in the column headers in the table"; generalized
              2026-08-27, Sandra: "can we pin any column, not just Task")
              -- every resizable column gets its own pin, mutually
              exclusive with every other column's. stopPropagation so it
              doesn't also trigger the resize-handle span, its sibling in
              this same <th>. */}
          <span
            onClick={(e) => {
              e.stopPropagation();
              toggleWbsFreezeCol(colKey);
            }}
            title={isPinned ? "Unfreeze this column" : "Freeze this column (and every column to its left) so it stays visible while scrolling"}
            style={{
              display: "inline-flex",
              alignItems: "center",
              cursor: "pointer",
              color: isPinned ? "var(--accent, #4f46e5)" : "var(--muted)",
            }}
          >
            <Pin size={12} />
          </span>
        </span>
        <span
          onMouseDown={(e) => startWbsColResize(colKey, e)}
          title="Drag to resize"
          style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 8, cursor: "col-resize", zIndex: 1 }}
        />
      </th>
    );
  }

  // A visible box around the header's editable fields (Project name,
  // Owner) -- Sandra: "make it evident that thos fields needs to be
  // filled." Plain `.inline-cell` inputs only show a border on
  // hover/focus, so an empty one (no Owner picked yet) looked
  // indistinguishable from static text. A permanent, subtle border makes
  // clear these are fillable fields even at rest; an unfilled field gets
  // a dashed border in the muted/warning tone as a nudge to fill it in.
  function fieldBoxStyle(isFilled: boolean, minWidth = 110, locked = false): CSSProperties {
    if (locked) {
      return {
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: "1px 4px",
        minWidth,
        background: "var(--surface-muted, #f3f4f6)",
        color: "var(--muted)",
      };
    }
    return {
      border: `1px ${isFilled ? "solid" : "dashed"} ${isFilled ? "var(--border)" : "var(--warning-text, #b45309)"}`,
      borderRadius: 6,
      padding: "1px 4px",
      minWidth,
      background: "var(--surface)",
    };
  }

  // Round 11: each mode now renders its OWN Start cell (editable, with its
  // own conflict warning) alongside End/Duration -- replaces the old
  // single shared Start column entirely. `field` picks which of the two
  // per-mode columns this cell reads/writes.
  // Phase 12 (2026-08-21): Sandra -- "the manual time table would
  // basically reflect the capacity based by default, meaning any changes
  // can only be done in the manual... don't allow edits in the start
  // dates and end dates of capacity based [or full effort]." Full Effort
  // and Capacity-Based Start cells are now plain read-only display (no
  // InlineDate, no conflict-edit affordance); only Manual keeps the old
  // editable behavior (reusing the same start_date_standard/
  // start_standard_auto columns Capacity-Based used to own -- see
  // computeEntry's "manual" branch, which mirrors Capacity-Based until
  // touched, then freezes).
  function renderModeCells(t: TaskRow & { depth: number }, mode: Mode, isParent: boolean) {
    const entry = chainByMode[mode].get(t.id);
    const conflict = dependencyConflict(t, mode);
    const style = { fontSize: 12, ...modeColStyle(mode) };

    if (mode !== "manual") {
      return (
        <>
          {/* Bugfix (2026-08-26, round 2 -- Sandra's follow-up screenshot
              showed the SAME overlap after round 1's fix, now clearly
              landing in the END-date column's space): the real cause was
              never the date TEXT squeezing against the icon -- it's that
              a `<td>` has no overflow clipping of its own, and while a
              Start cell is being actively edited, `InlineDate` renders a
              native `<input type="date">` with a browser-enforced
              ~150px min-width (see InlineCell.tsx's own comment on this)
              that's WIDER than this column's actual width (~110px
              default). With nothing clipping it, that overflow -- input
              AND whatever icon(s) sit after it in the flex row -- spills
              rightward past this cell's own boundary and visually lands
              on top of the NEXT column (End Date), which is exactly what
              looked like "icon overlapping the End date". `overflow:
              hidden` on the `<td>` itself (not just an inner span) is
              what actually stops that bleed. */}
          <td style={{ ...style, overflow: "hidden" }}>
            <span
              title={
                isParent
                  ? `Computed from this task's own sub-tasks (earliest Start under ${MODE_LABEL[mode]})`
                  : `${MODE_LABEL[mode]} is read-only -- edit dates under Forecasted instead.`
              }
              style={{ display: "inline-flex", alignItems: "center", gap: 4, minWidth: 0 }}
            >
              {/* Bugfix (2026-08-26, Sandra: warning/pin icons overlapping
                  the date text in a narrow column): the date text had no
                  minWidth:0/overflow handling of its own, so a flex-item
                  squeeze (icon(s) + a full date string all fighting for a
                  ~100px date column) rendered as visual overlap instead of
                  the icon(s) reliably keeping their own space and the date
                  truncating gracefully if it ever runs out of room. */}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                {entry ? formatDate(entry.start) : "—"}
              </span>
              {conflict && <AlertTriangle size={12} style={{ color: "var(--warning-text, #b45309)", flexShrink: 0 }} />}
            </span>
          </td>
          <td style={entry ? style : { ...style, color: "var(--muted)" }}>{entry ? formatDate(entry.end) : "—"}</td>
          <td style={entry ? style : { ...style, color: "var(--muted)" }}>{entry ? entry.durationDays : "—"}</td>
        </>
      );
    }

    const field = "start_date_standard";
    const autoField = "start_standard_auto";
    return (
      <>
        <td style={{ ...style, overflow: "hidden" }}>
          <span
            title={
              isParent
                ? `Computed from this task's own sub-tasks (earliest Start under ${MODE_LABEL[mode]})`
                : conflict
                ? `Starts on or before "${conflict.name}" finishes (${formatDate(conflict.end)}) under ${MODE_LABEL[mode]} -- double-check this Start date.`
                : undefined
            }
            style={{ display: "inline-flex", alignItems: "center", gap: 4, minWidth: 0 }}
          >
            {/* Bugfix (2026-08-26, Sandra: warning/pin icons overlapping
                the date text in a narrow column): wrap InlineDate in a
                shrinkable, truncating flex item (minWidth:0 -- flex items
                default to minWidth:auto, i.e. "never shrink below my own
                content's width", which is exactly what let a squeeze here
                render as icons overlapping the date instead of the date
                truncating and the icon(s) keeping their own reserved
                space) and mark both icons flexShrink:0 so they're never
                the ones that give up room. */}
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              <InlineDate
                value={t[field]}
                // Start Date lock (2026-08-26): once the project's
                // baseline is locked, direct edits are blocked at the DB
                // level (enforce_start_date_lock trigger) -- turn the
                // field read-only here too so a save attempt doesn't
                // silently fail against that trigger. Per-task change
                // requests were removed 2026-08-27 the same day Re-baseline
                // itself was removed entirely, so once locked a Start Date
                // never moves again for the life of the project.
                editable={canEditWbs && !isParent && !project!.timelines_locked}
                onCommit={(v) =>
                  // A manual edit here freezes this task's Manual date --
                  // it stops mirroring Capacity-Based from now on. Re-adding/
                  // re-selecting a dependency turns auto-pilot back on, same
                  // as before (Round 10).
                  saveTaskField(t.id, { [field]: v, [autoField]: false } as Partial<TaskRow>)
                }
              />
            </span>
            {conflict && <AlertTriangle size={12} style={{ color: "var(--warning-text, #b45309)", flexShrink: 0 }} />}
            {entry?.isOverridden && (
              <span
                title={
                  entry.suggestedStart && entry.suggestedStart !== entry.start
                    ? `Committed manually -- Capacity-Based would suggest ${formatDate(entry.suggestedStart)}${
                        entry.suggestedEnd ? ` → ${formatDate(entry.suggestedEnd)}` : ""
                      }.`
                    : "Committed manually -- this date overrides the Capacity-Based suggestion."
                }
                style={{ display: "inline-flex", flexShrink: 0 }}
              >
                <Pin size={11} style={{ color: UTIL_PREVIEW_COLOR.standard_committed }} />
              </span>
            )}
          </span>
        </td>
        <td style={entry ? style : { ...style, color: "var(--muted)" }}>
          {/* Phase 19 (2026-08-24): End is now freely typable too, but
              only once Start has been manually committed -- editing End
              before Start is touched wouldn't have a fixed point to
              spread hours from. Typing an End date here is what turns on
              the even-hours-per-day spread (see computeEntry's "manual"
              branch); clearing it (native date-input "clear") reverts to
              the flat 7.5h/day fallback from Start. */}
          {entry?.isOverridden ? (
            <span title={entry.avgHoursPerDay != null ? `${entry.avgHoursPerDay}h/day, spread evenly across this window` : "Flat 7.5h/day from Start -- type an End date to spread hours evenly instead"} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <InlineDate
                // Bugfix (2026-08-24, found in post-ship audit): when no
                // End has been typed yet, this must still show the
                // computed flat-rate End (entry.end) -- falling back to
                // t.manual_end_date alone rendered a BLANK date box the
                // moment Start was overridden, hiding a real computed
                // date behind an empty-looking input. Typing a new value
                // still only ever writes manual_end_date.
                value={t.manual_end_date ?? entry.end}
                editable={canEditWbs && !isParent}
                onCommit={(v) => saveTaskField(t.id, { manual_end_date: v || null } as Partial<TaskRow>)}
              />
            </span>
          ) : (
            <span>{entry ? formatDate(entry.end) : "—"}</span>
          )}
        </td>
        <td style={entry ? style : { ...style, color: "var(--muted)" }}>
          {entry ? entry.durationDays : "—"}
          {entry?.avgHoursPerDay != null && (
            <span style={{ color: "var(--muted)", marginLeft: 4, fontSize: 11 }}>({entry.avgHoursPerDay}h/day)</span>
          )}
        </td>
      </>
    );
  }

  const summaries: Record<Mode, ReturnType<typeof chainOverallSummary>> = {
    full_capacity: chainOverallSummary(fullChain),
    standard: chainOverallSummary(standardChain),
    manual: chainOverallSummary(manualChain),
  };

  // Real-time utilization heat-map (Sandra, 2026-07-24): "when we
  // temporarily plot tasks to someone and select effort - the
  // utilization preview updates real time." Every OTHER project's tasks
  // count exactly as committed in the DB; THIS project's own tasks are
  // overridden with whatever the ACTIVE mode currently computes for
  // start/due (falling back to the task's real dates if it doesn't have
  // a computed entry yet, e.g. missing Est. hrs or Start date) -- so
  // editing a Start date, assignee, or effort level (all autosave
  // immediately into `tasks` state) or switching modes recomputes the
  // heat-map instantly, with no Save required.
  // NOTE (fixed 2026-07-24, found live on "Project 1" right after Round 7
  // shipped): the earlier version of this merged computed start/due dates
  // onto `allTasks`' own per-task object, which kept THAT snapshot's
  // assignee_id/effort/status -- fine for dates, but any Assignee/Effort
  // edited live (no full-page reload since) never made it into the
  // heat-map, since `allTasks` is fetched once at page load and never
  // refetched after a plain field save. Fixed by rebuilding this
  // project's own rows entirely fresh from live local state every
  // render, same fix already applied once before for a narrower version
  // of this same staleness bug -- only OTHER projects' tasks (not being
  // edited in this session) still come from the `allTasks` snapshot.
  // Phase 9 (2026-08-21): "Actual" shows today's real committed state --
  // THIS project's own tasks are read as-is from the `allTasks` snapshot
  // (their last-Saved dates), not recomputed from any draft chain, so the
  // heat-map reflects what's genuinely true right now. The other three
  // preview options keep the original live-draft substitution below.
  // Phase 10 (2026-08-21): pulled into a per-mode function so the
  // snapshot can render all 4 scenarios as simultaneous rows instead of
  // computing just the one currently-toggled mode -- identical logic to
  // the Phase 9 version, just callable once per scenario.
  function buildEffectiveForMode(mode: UtilPreviewMode): { tasks: UtilTaskRow[]; projects: UtilProjectRow[] } {
    const chain = previewChainFor(mode);
    // Phase 23 (2026-08-24) bugfix: estimated_hours now carried through
    // onto these rows -- see previewDailyHoursFor below for why this
    // matters (the old points-based dailyPointsFor never used it at all,
    // which was the actual bug Sandra reported).
    const tasks: UtilTaskRow[] =
      mode === "actual"
        ? allTasks.map((t) => ({
            id: t.id,
            project_id: t.project_id,
            assignee_id: t.assignee_id,
            status: t.status,
            start_date: t.start_date,
            current_due_date: t.current_due_date,
            effort: t.effort,
            estimated_hours: t.estimated_hours,
          }))
        : [
            ...allTasks.filter((t) => t.project_id !== projectId),
            // Parent rows (tasks with their own sub-tasks) are excluded here
            // on purpose -- see parentAssigneeState/the Effort "N/A" cell
            // above. A parent's own span is just the union of its
            // children's, so counting it too would double the
            // points/utilization contribution for whoever it's
            // (rolled-up-)assigned to.
            ...orderedTasks
              .filter((t) => !(t.depth === 0 && hasChildren(t.id)))
              .map((t) => {
                const entry = chain?.get(t.id);
                return {
                  id: t.id,
                  project_id: t.project_id,
                  assignee_id: t.assignee_id,
                  status: t.status,
                  start_date: entry?.start ?? t.start_date,
                  current_due_date: entry?.end ?? t.current_due_date,
                  effort: t.effort,
                  estimated_hours: t.estimated_hours,
                };
              }),
          ];

    // Same live-draft idea for THIS project's own row in the PM-overhead
    // calculation (Sandra: "when project owner has been selected and start
    // date - fill out the heat map based on how we have set up PM
    // overheads... update the PM overhead utilization to fill as the dates
    // progress while building the WBS"). `allProjects` is a one-time
    // snapshot fetched at page load -- swap this project's row for a live
    // one built from the current draft Owner + derived Start/End span, so
    // picking an Owner or extending the schedule (adding/replanning tasks)
    // updates PM-overhead points immediately, same pattern as tasks above.
    const summary = mode !== "actual" && chain ? chainOverallSummary(chain) : null;
    // Narrowing note: `project` was already confirmed non-null by the
    // early `if (!project) return ...` guard above this whole render --
    // TS just can't see across this nested function's boundary, hence
    // the assertions.
    const proj = project!;
    const projects: UtilProjectRow[] = [
      ...allProjects.filter((p) => p.id !== projectId),
      mode === "actual"
        // Actual: use this project's own already-committed row verbatim
        // (falls back to the live draft Owner/Start only if it's somehow
        // missing from the snapshot, e.g. a brand-new unsaved project).
        ? allProjects.find((p) => p.id === projectId) ?? {
            id: projectId ?? "",
            owner_id: proj.owner_id,
            start_date: proj.start_date,
            end_date: proj.start_date,
          }
        : {
            id: projectId ?? "",
            owner_id: proj.owner_id,
            start_date: proj.start_date,
            end_date: summary?.end ?? proj.start_date,
          },
    ];
    return { tasks, projects };
  }

  const effectiveForMode: Record<UtilPreviewMode, { tasks: UtilTaskRow[]; projects: UtilProjectRow[] }> = {
    actual: buildEffectiveForMode("actual"),
    full_capacity: buildEffectiveForMode("full_capacity"),
    standard_suggested: buildEffectiveForMode("standard_suggested"),
    standard_committed: buildEffectiveForMode("standard_committed"),
  };

  // Phase 23 (2026-08-24) bugfix: Sandra -- "the utilization snapshot
  // only captures the PM overhead... does not actually capture the
  // foreseen utilization if ever the tasks will be plotted." Root cause:
  // this snapshot panel was calling utilizationCalc.ts's dailyPointsFor,
  // a leftover from BEFORE the Phase 1/2 hours-based Utilization/Day
  // Planner refactor (2026-08-20) -- it only reads a task's coarse
  // `effort` tier (Light/Moderate/Heavy -> a fixed 0.5/1/2 points/day via
  // TASK_EFFORT_POINTS) and completely ignores estimated_hours, plus its
  // own separate PM-overhead constant (PROJECT_PM_POINTS_PER_DAY = 0.1pt
  // ~= 0.75h) that was never updated when the real one
  // (PROJECT_PM_DAILY_HOURS) got lowered to 0.25h. That's exactly why
  // Fritzie's row showed a flat 10%/0.8h no matter what hours were typed
  // on her tasks -- it was PM overhead alone; the task's real hours never
  // factored in at all.
  //
  // Fix: mirror Utilization.tsx's own hours-based even-spread math
  // (taskHoursOnDate/pmHoursFor/dailyHoursFor) instead -- a task's real
  // estimated_hours spread evenly across its own (mode-resolved) working
  // days, plus PROJECT_PM_DAILY_HOURS per owned project per working day.
  // No history-awareness needed here (same as before) -- this previews
  // the CURRENT draft plan, not historical truth.
  function previewTaskHoursOnDate(t: UtilTaskRow, dateStr: string, forPersonId?: string): number {
    const hours = t.estimated_hours ?? 0;
    if (hours === 0) return 0;
    const workingDays = taskWorkingDays(t);
    if (!workingDays.includes(dateStr)) return 0;
    if (forPersonId && t.assignee_id !== forPersonId) return 0;
    return hours / workingDays.length;
  }
  function previewPmHoursFor(personId: string, dateStr: string, projects: UtilProjectRow[]): number {
    const owned = projects.filter((p) => p.owner_id === personId && projectWorkingDays(p).includes(dateStr));
    return owned.length * PROJECT_PM_DAILY_HOURS;
  }
  function previewDailyHoursFor(personId: string, dateStr: string, tasks: UtilTaskRow[], projects: UtilProjectRow[]): number {
    const taskHours = tasks
      .filter((t) => t.assignee_id === personId && statusGroupOf(TASK_STATUS_GROUPED, t.status) !== "complete")
      .reduce((sum, t) => sum + previewTaskHoursOnDate(t, dateStr, personId), 0);
    return taskHours + previewPmHoursFor(personId, dateStr, projects);
  }

  const utilWindowStart = addDays(parseLocalDate(utilAnchorDate), utilWindowOffset * UTIL_WINDOW_DAYS);
  const utilDays: Date[] = Array.from({ length: UTIL_WINDOW_DAYS }, (_, i) => addDays(utilWindowStart, i));

  function utilAvailability(personId: string, dateStr: string): AvailabilityRow | undefined {
    return availability.find((a) => a.person_id === personId && a.date === dateStr);
  }

  const owner = people.find((p) => p.id === project.owner_id);

  // Gantt chart (Sandra, 2026-07-24): a visual timeline below the task
  // table, built LAST and deliberately after every scheduling-logic
  // change above so it renders the final, settled model. Shows whichever
  // mode is currently toggled active (same "Save using" control the rest
  // of the page already uses) -- one timeline at a time, not both modes
  // overlaid. Bars are colored by ASSIGNEE (not by mode) so a person with
  // several overlapping bars in the same window is an immediate visual
  // flag of over-allocation -- the actual motivation Sandra gave for
  // wanting per-person colors at all.
  // Round (2026-07-28): widened 28->34 (matches TimelineView's own day-cell
  // width elsewhere in the app) and switched from "one Gantt, whichever
  // mode is toggled" to "both Gantts, always" -- see ganttMetricsFor/
  // renderGantt below. Sandra flagged the single-mode Gantt read as
  // cramped/hard to follow, especially with dependency connector lines
  // layered on top -- the wider day column gives the elbow lines more
  // room to read clearly, on top of just being less crowded on its own.
  const GANTT_DAY_WIDTH = 34;
  const GANTT_NAME_COL_WIDTH = 220;
  const GANTT_HEADER_HEIGHT = 24; // matches the date-label row's own height
  const GANTT_ROW_HEIGHT = 26; // matches each task row's own height

  function ganttMetricsFor(chain: Map<string, ChainEntry | null>) {
    const summary = chainOverallSummary(chain);
    const startDate = summary.start ? addDays(parseLocalDate(summary.start), -1) : null;
    const endDate = summary.end ? addDays(parseLocalDate(summary.end), 1) : null;
    const days: Date[] =
      startDate && endDate
        ? (() => {
            const out: Date[] = [];
            for (let d = new Date(startDate); d <= endDate; d = addDays(d, 1)) out.push(new Date(d));
            return out;
          })()
        : [];
    const widthPx = days.length * GANTT_DAY_WIDTH;
    return { startDate, days, widthPx };
  }
  function ganttDayOffsetPx(startDate: Date | null, dateStr: string): number {
    if (!startDate) return 0;
    const diffDays = Math.round((parseLocalDate(dateStr).getTime() - startDate.getTime()) / 86400000);
    return diffDays * GANTT_DAY_WIDTH;
  }
  function ganttBarWidthPx(startStr: string, endStr: string): number {
    const diffDays = Math.round((parseLocalDate(endStr).getTime() - parseLocalDate(startStr).getTime()) / 86400000) + 1;
    return Math.max(diffDays, 1) * GANTT_DAY_WIDTH;
  }

  // Sandra, 2026-07-24: "is it ok if we show dependencies via a light broken
  // or thin line just to show relationship?" -- confirmed as a READ-ONLY
  // visual only (drawn from the existing "Depends on" data, using whichever
  // mode's chain is currently active, same as the bars themselves). This is
  // NOT the deferred "Gantt drag-linking" feature (creating/editing a
  // dependency by dragging between bars) -- that's a separate, bigger
  // interaction design still not started. An elbow (horizontal-vertical-
  // horizontal) path reads more like a real Gantt tool than a straight
  // diagonal and avoids visually cutting across unrelated bars in between.
  // Sandra confirmed she wants conflict-awareness: a normal edge is a
  // light dashed gray line ("light broken ... thin line"); an edge where
  // the successor starts on or before the predecessor's own End under the
  // active mode (the same test `dependencyConflict` already uses) turns
  // solid amber, matching the existing warning-triangle icon's color, so
  // the same conflict is visible on the Gantt without checking the table.
  function ganttConnectors(chain: Map<string, ChainEntry | null>, markerKey: string, startDate: Date | null) {
    const rowIndexOf = new Map(orderedTasks.map((t, i) => [t.id, i]));
    const elems: JSX.Element[] = [];
    for (const t of orderedTasks) {
      const depIds = dependsOnIdsFor(t.id);
      if (!depIds.length) continue;
      const succEntry = chain.get(t.id);
      const succRow = rowIndexOf.get(t.id);
      if (!succEntry || succRow === undefined) continue;
      for (const depId of depIds) {
        const predEntry = chain.get(depId);
        const predRow = rowIndexOf.get(depId);
        if (!predEntry || predRow === undefined) continue;
        const x1 = GANTT_NAME_COL_WIDTH + ganttDayOffsetPx(startDate, predEntry.end) + GANTT_DAY_WIDTH;
        const y1 = GANTT_HEADER_HEIGHT + predRow * GANTT_ROW_HEIGHT + GANTT_ROW_HEIGHT / 2;
        const x2 = GANTT_NAME_COL_WIDTH + ganttDayOffsetPx(startDate, succEntry.start);
        const y2 = GANTT_HEADER_HEIGHT + succRow * GANTT_ROW_HEIGHT + GANTT_ROW_HEIGHT / 2;
        // Sandra flagged this connector was rendering but essentially
        // invisible in practice: (1) `var(--border)` (#e3e7ec) is a
        // near-white hairline color meant for subtle table borders, far
        // too faint for a line drawn over a plain white Gantt background;
        // (2) a Finish-to-Start dependency's successor almost always
        // starts the very next working day after its predecessor ends --
        // there's rarely any real horizontal gap between the two bars, so
        // the old 6px-minimum elbow jog was too small to read as anything
        // more than a stray pixel. Fixed by switching the neutral color to
        // `var(--muted)` (a real medium gray already used elsewhere on
        // this page for secondary text -- still reads as "light/quiet"
        // next to the bold amber conflict color, just not literally
        // invisible) and widening the minimum jog to 14px.
        //
        // Round 16 (Sandra, after arrowheads shipped): the strict H-V-H
        // elbow above looked "crooked"/boxy whenever the predecessor and
        // successor sit several rows apart (e.g. routing past an
        // in-between parent row) while their bars are horizontally close
        // -- a long vertical run bookended by two short horizontal jogs
        // reads as an awkward rectangle rather than a connector. Sandra
        // confirmed she doesn't need the line to originate from the exact
        // pixel of the bar's own edge if that's what it takes to look
        // cleaner, so this switched to a smooth cubic-bezier S-curve
        // instead of a rigid right-angle path -- no jog-length tuning
        // needed, and it naturally looks fine regardless of how many rows
        // apart the two tasks are. Control points pull the curve
        // horizontally out from each endpoint by up to a third of the
        // total horizontal gap (min 14px, same floor as before) before
        // bending toward the other end.
        const conflict = succEntry.start <= predEntry.end;
        const dx = Math.max((x2 - x1) / 3, 14);
        const path = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
        elems.push(
          <path
            key={`${depId}->${t.id}`}
            d={path}
            fill="none"
            stroke={conflict ? "var(--warning-text, #b45309)" : "var(--muted, #8a94a6)"}
            strokeWidth={conflict ? 1.1 : 0.9}
            strokeDasharray={conflict ? undefined : "4,3"}
            markerEnd={`url(#${conflict ? `gantt-arrow-conflict-${markerKey}` : `gantt-arrow-neutral-${markerKey}`})`}
          />
        );
      }
    }
    return elems;
  }

  return (
    <div>
      {dialog}
      <Link to={`/projects/${projectId}`} className="back-link" style={{ display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 8, fontSize: 12.5 }}>
        <ArrowLeft size={13} /> Back to {project.name}
      </Link>
      <h1>WBS Planning — {project.name}</h1>

      {/* Phase 3 (2026-07-28): status banner for the Draft/Baseline/
          Revision/Final-Scope workflow -- see [[project_capaciq_wbs_planning]].
          Colors/labels mirror WBS_STATUS_META below. */}
      <div
        className="card"
        style={{
          padding: "8px 14px",
          marginBottom: 10,
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          background: WBS_STATUS_META[project.wbs_status]?.bg,
          borderColor: WBS_STATUS_META[project.wbs_status]?.border,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 700, color: WBS_STATUS_META[project.wbs_status]?.color }}>
          {WBS_STATUS_META[project.wbs_status]?.label ?? project.wbs_status}
        </span>
        <span style={{ fontSize: 11.5, color: "var(--muted)" }}>{WBS_STATUS_META[project.wbs_status]?.hint}</span>
        {activeBaseline && (
          <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
            Baseline V{activeBaseline.version_number} (locked {formatDate(activeBaseline.captured_at.slice(0, 10))})
          </span>
        )}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, position: "relative" }}>
          {/* 2026-08-27 (Sandra: "can we just add an action button
              instead and from there pick Re-Baseline and Close project")
              -- single Actions menu replaces the separate Request Baseline
              Approval button that used to render here AND the Close
              Project button that used to render in its own button down in
              the bottom status bar. Later the same day (Sandra: rename to
              "Start Project" and remove Re-baseline entirely) -- the
              request/approve RPCs (request_baseline_approval/
              decide_baseline_request) and can_approve_rebaseline flag stay
              as-is under the hood (still gate approving the first-ever
              Start Project request via canDecideBaselineRequest below),
              but canRequestBaseline is now draft-only so there is no UI
              path left to invoke them a second time. */}
          {(() => {
            // 2026-08-27 (Sandra: re-baseline removed) -- Start Project (the
            // renamed first-ever "Request Baseline Approval") is only
            // reachable from Draft now; baseline_locked/changed_after_baseline
            // projects no longer get a way to re-trigger this RPC.
            const canRequestBaseline = canManageWbs && project.wbs_status === "draft" && !pendingBaselineRequest;
            const canRequestClosure =
              canManageWbs && (project.wbs_status === "baseline_locked" || project.wbs_status === "changed_after_baseline") && !pendingClosure;
            if (!canRequestBaseline && !canRequestClosure) return null;
            return (
              <>
                <button
                  className="btn-secondary"
                  disabled={workflowBusy}
                  onClick={() => setWbsActionsMenuOpen((v) => !v)}
                  style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
                >
                  Actions <ChevronDown size={13} />
                </button>
                {wbsActionsMenuOpen && (
                  <>
                    {/* Transparent click-outside-to-close backdrop, same
                        trick used elsewhere for lightweight popovers in
                        this app (see DependsOnPicker below) rather than a
                        document-level event listener. */}
                    <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setWbsActionsMenuOpen(false)} />
                    <div
                      className="card"
                      style={{
                        position: "absolute",
                        top: "calc(100% + 4px)",
                        right: 0,
                        zIndex: 41,
                        minWidth: 220,
                        padding: 4,
                        boxShadow: "0 4px 14px rgba(0,0,0,0.18)",
                        display: "flex",
                        flexDirection: "column",
                        gap: 2,
                      }}
                    >
                      {canRequestBaseline && (
                        <button
                          className="row-menu-item"
                          disabled={workflowBusy}
                          onClick={() => {
                            setWbsActionsMenuOpen(false);
                            handleRequestBaseline();
                          }}
                          style={{ display: "flex", width: "100%", textAlign: "left", background: "none", border: "none", borderRadius: 4, padding: "6px 8px", fontSize: 12.5, cursor: "pointer", color: "var(--text)" }}
                        >
                          Start Project
                        </button>
                      )}
                      {canRequestClosure && (
                        <button
                          className="row-menu-item"
                          disabled={workflowBusy}
                          onClick={() => {
                            setWbsActionsMenuOpen(false);
                            handleRequestClosure();
                          }}
                          style={{ display: "flex", width: "100%", textAlign: "left", background: "none", border: "none", borderRadius: 4, padding: "6px 8px", fontSize: 12.5, cursor: "pointer", color: "var(--text)" }}
                        >
                          Close Project
                        </button>
                      )}
                    </div>
                  </>
                )}
              </>
            );
          })()}
        </div>
      </div>

      {pendingBaselineRequest && (
        <div
          className="card"
          style={{ padding: "8px 14px", marginBottom: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", background: "var(--warning-bg, #fff7ed)" }}
        >
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--warning-text, #b45309)" }}>Start Project requested</span>
          <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
            Awaiting approval from someone flagged to approve baselines (User Management).
          </span>
          {canDecideBaselineRequest && (
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button className="btn-secondary" disabled={workflowBusy} onClick={() => handleDecideBaselineRequest(false)}>
                Reject
              </button>
              <button className="btn-primary" disabled={workflowBusy} onClick={() => handleDecideBaselineRequest(true)}>
                Start Project
              </button>
            </div>
          )}
        </div>
      )}

      {pendingClosure && (
        <div
          className="card"
          style={{ padding: "8px 14px", marginBottom: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", background: "var(--warning-bg, #fff7ed)" }}
        >
          <span style={{ fontSize: 12, fontWeight: 700, color: "var(--warning-text, #b45309)" }}>Closure requested</span>
          <span style={{ fontSize: 11.5, color: "var(--muted)" }}>Awaiting approval to lock in Final Scope.</span>
          {canDecideClosure && (
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button className="btn-secondary" disabled={workflowBusy} onClick={() => handleDecideClosure(false)}>
                Reject
              </button>
              <button className="btn-primary" disabled={workflowBusy} onClick={() => handleDecideClosure(true)}>
                Approve &amp; Close
              </button>
            </div>
          )}
        </div>
      )}

      {/* Sandra, 2026-07-29: previously this whole section (fields, effort
          summary, task table, Gantt, Utilization) only rendered when NOT
          locked -- a locked/closed project showed nothing but a one-line
          message instead of its actual plan. Now the message is a slim
          banner and the full content always renders underneath, with
          canEditWbs gating individual field/control editability instead
          of gating visibility of the whole page. */}
      {/* Sandra, 2026-07-29: removed the separate locked/closed message
          card that used to sit here -- redundant with the top status
          banner's own colored bg + hint text right above it. */}
      {/* Design spec item 6 follow-up (Sandra, 2026-07-29): Revision
          Summary + Revision History now live in a genuine right rail
          alongside the main content (not a full-width toggle panel like
          before), matching her reference mockup. Main content is the
          flex:1 left column; the rail is a fixed-width sibling. */}
          <div className="card" style={{ padding: 14, marginBottom: 12, display: "flex", alignItems: "center", gap: 16, flexWrap: "nowrap", overflowX: "auto" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy)" }}>Project:</span>
              <div className="wbs-field-box" style={fieldBoxStyle(!!project.name, 170, !canEditWbs)}>
                <InlineText value={project.name} editable={canEditWbs} onCommit={(v) => saveProjectField({ name: v })} />
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy)" }}>Owner:</span>
              <div className="wbs-field-box" style={fieldBoxStyle(true, 110, !canEditWbs)}>
                <InlineSelect
                  value={owner?.name ?? ""}
                  editable={canEditWbs}
                  allowEmpty
                  emptyLabel="No owner"
                  options={people.map((p) => p.name)}
                  onCommit={(name) => {
                    const p = people.find((pp) => pp.name === name);
                    saveProjectField({ owner_id: p?.id ?? null });
                  }}
                />
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy)" }}>Start date:</span>
              <div className="wbs-field-box" style={fieldBoxStyle(true, 110, !canEditWbs || anyTaskDone)}>
                <InlineDate
                  value={project.start_date}
                  editable={canEditWbs && !anyTaskDone}
                  onCommit={(v) => saveProjectField({ start_date: v })}
                />
              </div>
              <span
                title={
                  anyTaskDone
                    ? "Locked -- at least one task is already Done, so the project has genuinely started and this date is now historical."
                    : "Your own plotted anchor -- used as the default Start for the very first task in each mode when there's nothing earlier to chain from. No longer auto-pulled from tasks."
                }
                style={{ display: "inline-flex", cursor: "help", flexShrink: 0 }}
              >
                <Info size={13} style={{ color: "var(--muted)" }} />
              </span>
            </div>
            {activeBaseline && (
              // Design spec item 2 (Sandra, 2026-07-29): Baseline version
              // shown in the Project Details strip, but READ-ONLY --
              // unlike Project/Owner/Start date/Scoping Effort, there's no
              // direct-edit path for this (it only changes via Start
              // Project in the Actions menu -- Re-baseline removed
              // 2026-08-27, so this stays V1 for the life of the project),
              // so it renders as plain text in a muted box rather than an
              // InlineX field.
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy)" }}>Baseline:</span>
                <div className="wbs-field-box" style={fieldBoxStyle(true, 90, true)}>
                  <span style={{ fontSize: 12.5 }}>
                    V{activeBaseline.version_number} ({formatDate(activeBaseline.captured_at.slice(0, 10))})
                  </span>
                </div>
              </div>
            )}
            <div style={{ marginLeft: "auto", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 3, flexShrink: 0 }}>
              {/* Phase 21 (2026-08-24): Sandra -- "there should no longer
                  be an option to choose which effort will be used, it
                  will always capture the planned one." The Scoping
                  Effort picker (InlineSelect over MODES) is gone --
                  Save always operates on Forecasted (activeMode is now a
                  fixed constant, see its declaration above), so this is
                  a plain static label instead of an editable field. */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy)" }}>Scoping Effort:</span>
                <div className="wbs-field-box" style={fieldBoxStyle(true, 150, true)}>
                  <span style={{ fontSize: 12.5, color: SCENARIO_COLOR.forecasted, fontWeight: 600 }}>{MODE_LABEL[activeMode]}</span>
                </div>
                <span
                  title="Save always records this project's Forecasted (planned) schedule -- the mode where a real committed date can be typed. Full and Capacity-Based are reference/comparison views only and can never be saved as the official plan."
                  style={{ display: "inline-flex", cursor: "help", flexShrink: 0 }}
                >
                  <Info size={13} style={{ color: "var(--muted)" }} />
                </span>
                {canEditWbs && (
                  <button className="btn-primary" disabled={saving} onClick={saveDraft} style={{ flexShrink: 0 }}>
                    {saving ? "Saving…" : "Save"}
                  </button>
                )}
              </div>
              {project.scoping_effort_mode && project.scoping_effort_mode !== activeMode ? (
                <span style={{ fontSize: 11, color: "var(--warning-text)", fontWeight: 600 }}>
                  Unsaved -- currently saved as {MODE_LABEL[project.scoping_effort_mode as Mode] ?? project.scoping_effort_mode}
                </span>
              ) : project.scoping_effort_mode ? (
                <span style={{ fontSize: 11, color: "var(--muted)" }}>
                  Saved as {MODE_LABEL[project.scoping_effort_mode as Mode] ?? project.scoping_effort_mode}
                </span>
              ) : (
                <span style={{ fontSize: 11, color: "var(--muted)" }}>Not saved yet</span>
              )}
            </div>
          </div>

          {/* Project-level summary: fixed total effort (left) + a
              duration comparison bar per mode (right) -- redesigned per
              Sandra's own mockup (2026-07-24): a big "Total Effort
              Needed" number that never changes between modes (a
              "Fixed total effort" pill makes that explicit), next to a
              horizontal bar per mode sized by its own working-day
              duration so the Full Effort vs Conservative Effort
              tradeoff reads visually, not just as two numbers. */}
          {/* Design spec item 5 (Sandra, 2026-07-29): second-row layout --
              this existing Total Effort/Effort Comparison card (Timeline
              Projection) on the LEFT, the new Overall Variance table
              (formerly the toggle-only Compare-with-Baseline panel) on
              the RIGHT, once there's a baseline to compare against. Draft
              projects (no baseline yet) keep the single full-width card
              as before -- there's nothing to show variance against. */}
          <div
            style={{
              display: "grid",
              // Phase 13 (2026-08-21): Sandra -- "once the baseline is
              // locked... the width... decreases because there is a
              // place order for version history in the second column...
              // lock the version history size to match the first row...
              // keep the width at full window view." Revision
              // Summary/History used to be a page-spanning flex sibling
              // (shrinking the ENTIRE main content -- table, both
              // Gantts, Utilization snapshot -- for the whole page
              // height once a baseline existed). Moved into THIS grid
              // row only, as a 3rd fixed-width column, so everything
              // below reclaims full page width unconditionally.
              gridTemplateColumns: project.wbs_status === "draft" ? "1fr" : "1fr 1fr 260px",
              gap: 12,
              marginBottom: 12,
              // Sandra, 2026-07-29: "align the overall variance box
              // height with the timelines" -- was "start" (each card
              // sized to its own content, so Overall Variance's shorter
              // table left visible extra whitespace/mismatch next to
              // the taller Effort Comparison card). "stretch" makes
              // both grid cells -- and therefore both .card children --
              // the same height as whichever is tallest.
              alignItems: "stretch",
            }}
          >
          <div className="card" style={{ padding: 16, display: "flex", gap: 28, flexWrap: "wrap" }}>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                gap: 6,
                minWidth: 150,
                paddingRight: 28,
                borderRight: "1px solid var(--border)",
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.3 }}>
                Total Effort Needed
              </div>
              <div style={{ fontSize: 30, fontWeight: 700, color: "var(--navy)", lineHeight: 1.1 }}>
                {totalEffortHours}
                <span style={{ fontSize: 15, fontWeight: 600, marginLeft: 3 }}>h</span>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
                across {orderedTasks.filter((t) => t.depth === 0).length} task(s)
              </div>
            </div>

            <div style={{ flex: 1, minWidth: 340 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--navy)", marginBottom: 12 }}>Effort Comparison (by Duration)</div>
              {MODES.map((m, i) => {
                const s = summaries[m];
                // Phase 12 (2026-08-21): 3rd mode added -- reuse the same
                // blue/green/yellow identity everywhere else on the page.
                const color =
                  m === "full_capacity" ? UTIL_PREVIEW_COLOR.full_capacity : m === "standard" ? UTIL_PREVIEW_COLOR.standard_suggested : UTIL_PREVIEW_COLOR.standard_committed;
                const rate = m === "full_capacity" ? "7.5 h/day" : null;
                const maxDuration = Math.max(summaries.full_capacity.durationDays, summaries.manual.durationDays, 1);
                const widthPct = s.durationDays ? Math.max(18, Math.round((s.durationDays / maxDuration) * 100)) : 0;
                // Sandra, 2026-07-29 follow-up: label moved ABOVE the bar
                // (was to its left) per her reference mockup -- same
                // colors, just the layout direction changed.
                return (
                  <div key={m} style={{ marginBottom: i === MODES.length - 1 ? 0 : 14 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color, marginBottom: 6 }}>
                      {MODE_LABEL[m]}{rate ? ` (${rate})` : ""}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                      <div style={{ flex: 1, minWidth: 100 }}>
                        {s.durationDays ? (
                          <div
                            style={{
                              width: `${widthPct}%`,
                              minWidth: 90,
                              background: color,
                              color: "#fff",
                              fontSize: 11,
                              fontWeight: 600,
                              textAlign: "center",
                              padding: "6px 8px",
                              borderRadius: 4,
                              whiteSpace: "nowrap",
                            }}
                          >
                            {s.durationDays} working day{s.durationDays === 1 ? "" : "s"}
                          </div>
                        ) : (
                          <span style={{ fontSize: 11.5, color: "var(--muted)" }}>no schedule yet</span>
                        )}
                      </div>
                      <div style={{ width: 85, fontSize: 11.5, flexShrink: 0 }}>
                        <div style={{ fontWeight: 600, color: "var(--muted)", fontSize: 10 }}>Start</div>
                        <div>{formatDate(s.start)}</div>
                      </div>
                      <div style={{ width: 85, fontSize: 11.5, flexShrink: 0 }}>
                        <div style={{ fontWeight: 600, color: "var(--muted)", fontSize: 10 }}>End</div>
                        <div>{formatDate(s.end)}</div>
                      </div>
                      {!s.complete && s.end && (
                        <div style={{ fontSize: 11.5, color: "var(--muted)", flexShrink: 0 }}>incomplete</div>
                      )}
                    </div>
                  </div>
                );
              })}
              {/* Sandra, 2026-07-29 follow-up: removed the "Total Effort
                  reflects the current plan..." helper line entirely. */}
            </div>
          </div>
          {project.wbs_status !== "draft" && (
            <CompareWithBaselinePanel projectId={project.id} liveTasks={buildTaskSnapshotPayload()} />
          )}
        {project.wbs_status !== "draft" && (
          <div style={{ width: 260, flexShrink: 0 }}>
            <div className="card" style={{ padding: 14 }}>
              {/* Sandra, 2026-07-29 follow-up: plain icon+label+value rows,
                  no per-row card/box (per her reference mockup). */}
              {latestRevisionChanges.length > 0 && (
                <div style={{ marginBottom: 12, paddingBottom: 12, borderBottom: "1px solid var(--border)" }}>
                  <strong style={{ fontSize: 12.5, color: "var(--navy)" }}>Revision Summary</strong>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8, fontSize: 11.5 }}>
                    {[
                      { icon: <Clock size={13} />, label: "Total effort change", value: `${revisionSummary.totalAddedHours > 0 ? "+" : ""}${revisionSummary.totalAddedHours}h` },
                      { icon: <ListPlus size={13} />, label: "Total tasks added", value: revisionSummary.tasksAdded },
                      { icon: <Trash2 size={13} />, label: "Total tasks removed", value: revisionSummary.tasksRemoved },
                      { icon: <TrendingUp size={13} />, label: "Estimates increased", value: revisionSummary.hoursIncreased },
                      { icon: <TrendingDown size={13} />, label: "Estimates decreased", value: revisionSummary.hoursDecreased },
                      { icon: <Calendar size={13} />, label: "Dates changed", value: revisionSummary.datesChanged },
                      { icon: <Link2 size={13} />, label: "Dependencies changed", value: revisionSummary.dependenciesChanged },
                      { icon: <User size={13} />, label: "Assignees changed", value: revisionSummary.assigneesChanged },
                    ].map((row) => (
                      <div key={row.label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ color: "var(--muted)", flexShrink: 0, display: "inline-flex" }}>{row.icon}</span>
                        <span style={{ flex: 1, color: "var(--text-secondary)" }}>{row.label}</span>
                        <strong>{row.value}</strong>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {/* Round (2026-08-26): the old "Revision History" panel here
                  read from project_revisions/project_revision_changes --
                  the Phase 6 Start Revision/Apply Revision flow, which had
                  gone dead when re-baselining was disabled (see
                  project_capaciq_rebaseline_disabled memory) and always
                  showed "No changes made yet" even on projects with real,
                  visible changes. It was replaced with a "Start Date
                  Change Requests" log; that per-task request/approval
                  feature was itself removed 2026-08-27 (Sandra: start
                  dates only change via Re-baseline now), so this whole
                  panel is gone too. Phase 24 (2026-08-26) revived
                  re-baselining, so project_revision_changes is written to
                  again on each approved re-baseline (see
                  decide_baseline_request) -- the Revision Summary panel
                  above (latestRevisionChanges) and the dedicated Audit
                  Trail page below are the current source of history. */}
              <button
                className="btn-secondary"
                style={{ width: "100%", marginTop: 12 }}
                onClick={() => navigate(`/projects/${project.id}/audit-trail`)}
              >
                View Full Audit Trail
              </button>
            </div>
          </div>
        )}
          </div>

          {/* Phase 10 (2026-08-21): redesigned per Sandra's spec -- all 4
              scenarios (Committed/Full Effort/Capacity-Based/Manual) now
              render as simultaneous rows per person instead of a tab you
              switch between, so they can be compared at a glance. Pure
              presentation change -- every cell still comes from the exact
              same dailyPointsFor/tierOf formula as before and as the
              standalone Utilization page, just called once per scenario
              via effectiveForMode instead of once for a toggled mode. */}
          <div className="card" style={{ padding: 14, marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4, flexWrap: "wrap" }}>
              <strong style={{ fontSize: 12.5, color: "var(--navy)" }}>Utilization snapshot</strong>
              <span
                title="Preview how this project's draft plan would land on top of everyone's real committed workload, under each scheduling method."
                style={{ display: "inline-flex", cursor: "help", color: "var(--muted)" }}
              >
                <Info size={13} />
              </span>
              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
                <button className="planner-nav-btn" title="Previous 4 weeks" onClick={() => setUtilWindowOffset((o) => o - 1)}>
                  <ChevronLeft size={14} />
                </button>
                <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--navy)" }}>
                  {formatDate(toISO(utilDays[0]))} – {formatDate(toISO(utilDays[utilDays.length - 1]))}
                </span>
                <button className="planner-nav-btn" title="Next 4 weeks" onClick={() => setUtilWindowOffset((o) => o + 1)}>
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 8 }}>
              Projected rows are previews only -- not saved to schedules until you click Save.
            </div>
            {/* Phase 11 (2026-08-21): Sandra -- "show/hide hours, show/hide
                Full Effort, select which people to show." All three are
                display-only controls; nothing below changes what's
                computed, only what's rendered and to whom.
                Phase 21 (2026-08-24): the single Full-Effort-only toggle
                is now 3 scenario checkboxes -- Forecasted/Capacity-Based/
                Full, colored to match everywhere else on the page. This
                SAME `visibleScenarios` state also filters the Timeline
                (Gantt) sections further down -- "a centralized toggle...
                select which views he wants to see... scenarios and gantt
                will only show forecasted ones." Actual/Committed is
                intentionally NOT one of these checkboxes -- it always
                stays visible as the ground-truth reference row. */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
              <button
                onClick={() => setUtilShowHours((v) => !v)}
                className={`timeline-segmented-btn${utilShowHours ? " active" : ""}`}
                style={{ borderRadius: "var(--radius-sm)", border: "1px solid var(--border)" }}
                title="Show/hide planned and capacity hours under each percentage"
              >
                <Clock size={12} style={{ marginRight: 4, verticalAlign: -2 }} />
                Hours
              </button>
              <span style={{ width: 1, height: 20, background: "var(--border)", margin: "0 2px" }} />
              <span style={{ fontSize: 11, fontWeight: 600, color: "var(--muted)" }}>Scenarios shown:</span>
              {SCENARIO_ORDER.map((key) => {
                const checked = visibleScenarios.has(key);
                return (
                  <label
                    key={key}
                    className={`timeline-segmented-btn${checked ? " active" : ""}`}
                    style={{
                      borderRadius: "var(--radius-sm)",
                      border: `1px solid ${checked ? SCENARIO_COLOR[key] : "var(--border)"}`,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      cursor: "pointer",
                    }}
                    title={`Show/hide ${SCENARIO_LABEL[key]} in the scenario rows below and in the Timeline (Gantt) sections`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setVisibleScenarios((prev) => {
                          const next = new Set(prev);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })
                      }
                      style={{ margin: 0, accentColor: SCENARIO_COLOR[key] }}
                    />
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: SCENARIO_COLOR[key], flexShrink: 0 }} />
                    {SCENARIO_LABEL[key]}
                  </label>
                );
              })}
              <UtilPersonFilterButton
                people={people}
                selected={utilPersonFilter}
                open={utilPersonFilterOpen}
                setOpen={setUtilPersonFilterOpen}
                search={utilPersonSearch}
                setSearch={setUtilPersonSearch}
                onChange={setUtilPersonFilter}
              />
            </div>
            <div ref={utilSnapshotScrollRef} style={{ overflowX: "auto" }}>
              {/* NOTE (2026-08-26): table-layout:fixed + a <colgroup> was
                  tried here to make Person/Scenario's sticky `left`
                  offsets match their real rendered width, but it
                  interacted badly with `position:sticky` on this
                  particular table -- Chrome computed the Scenario
                  column's width as roughly half its declared 150px even
                  though both the <col> and the <th> agreed on 150px
                  (confirmed live via getComputedStyle; root cause not
                  fully isolated, not worth more time chasing a browser
                  quirk). Reverted to plain auto table layout -- every
                  Person/Scenario header AND body cell already carries its
                  own explicit width + maxWidth + overflow:hidden (see
                  below), which is what actually keeps them from growing
                  past their declared size under auto layout regardless of
                  a long person name or the "Committed (Existing)" label. */}
              <table ref={utilSnapshotTableCallbackRef} className="data-table" style={{ borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    <th
                      ref={utilPersonThRef}
                      style={{
                        width: utilPersonColW,
                        maxWidth: utilPersonColW,
                        position: "sticky",
                        left: 0,
                        background: "var(--surface)",
                        zIndex: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      Person
                      {/* Resizable + always-frozen (2026-08-26, Sandra: "resize the
                          person name columns and freeze it too") -- drag handle on
                          the right edge, same pattern as the WBS table's ResizableTh. */}
                      <span
                        onMouseDown={startUtilPersonColResize}
                        title="Drag to resize"
                        style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 8, cursor: "col-resize", zIndex: 2 }}
                      />
                    </th>
                    <th
                      ref={utilScenarioThRef}
                      style={{
                        width: 150,
                        position: "sticky",
                        left: utilPersonRenderedW,
                        background: "var(--surface)",
                        zIndex: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      Scenario
                    </th>
                    {utilDays.map((d) => {
                      const iso = toISO(d);
                      const weekend = d.getDay() === 0 || d.getDay() === 6;
                      const holiday = holidaySet.has(iso);
                      return (
                        <th
                          key={iso}
                          style={{ width: 40, minWidth: 40, fontSize: 10, textAlign: "center", color: weekend || holiday ? "var(--muted)" : undefined }}
                          title={iso}
                        >
                          {String(d.getMonth() + 1).padStart(2, "0")}/{String(d.getDate()).padStart(2, "0")}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {(utilPersonFilter ? people.filter((p) => utilPersonFilter.has(p.id)) : people).map((p) => {
                    const visibleModes = UTIL_PREVIEW_MODES.filter((m) => {
                      const key = UTIL_MODE_TO_SCENARIO[m];
                      return !key || visibleScenarios.has(key); // "actual" (no key) always shown
                    });
                    const isExpanded = expandedUtilPeople.has(p.id);
                    function toggleExpanded() {
                      setExpandedUtilPeople((prev) => {
                        const next = new Set(prev);
                        if (next.has(p.id)) next.delete(p.id);
                        else next.add(p.id);
                        return next;
                      });
                    }
                    if (!isExpanded) {
                      // Bugfix (2026-08-26, Sandra: "confusing to click on
                      // View scenarios then the collapse will be in the
                      // name"): the expand trigger (chevron + "View
                      // scenarios") used to live in the SECOND column,
                      // separate from the person's name -- but the
                      // collapse trigger (chevron right before the name)
                      // lives in the FIRST column once expanded, so the
                      // clickable chevron visually jumped to a different
                      // spot depending on state. Both states now put the
                      // chevron in the exact same place, right before the
                      // name in the Person column, so there's one
                      // consistent click target regardless of expanded/
                      // collapsed -- "View scenarios" stays as a plain
                      // (still-clickable, the whole row has onClick) hint
                      // in the second column rather than owning the icon.
                      return (
                        <tr key={p.id} style={{ borderTop: "2px solid var(--border)", cursor: "pointer" }} onClick={toggleExpanded}>
                          <td
                            style={{
                              fontSize: 12,
                              fontWeight: 600,
                              position: "sticky",
                              left: 0,
                              width: utilPersonColW,
                              maxWidth: utilPersonColW,
                              background: "var(--surface)",
                              overflow: "hidden",
                            }}
                          >
                            <span
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 4,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              <ChevronRight size={12} style={{ flexShrink: 0 }} />
                              {p.name}
                            </span>
                          </td>
                          <td colSpan={utilDays.length + 1} style={{ fontSize: 11, color: "var(--muted)" }}>
                            View scenarios
                          </td>
                        </tr>
                      );
                    }
                    return (
                      <Fragment key={p.id}>
                        {visibleModes.map((mode, mi) => {
                          const { tasks: modeTasks, projects: modeProjects } = effectiveForMode[mode];
                          return (
                            <tr key={mode} style={mi === 0 ? { borderTop: "2px solid var(--border)" } : undefined}>
                              {mi === 0 && (
                                <td
                                  rowSpan={visibleModes.length}
                                  style={{
                                    fontSize: 12,
                                    fontWeight: 600,
                                    position: "sticky",
                                    left: 0,
                                    width: utilPersonColW,
                                    maxWidth: utilPersonColW,
                                    background: "var(--surface)",
                                    verticalAlign: "top",
                                    paddingTop: 8,
                                    cursor: "pointer",
                                    overflow: "hidden",
                                  }}
                                  onClick={toggleExpanded}
                                >
                                  <span
                                    style={{
                                      display: "inline-flex",
                                      alignItems: "flex-start",
                                      gap: 4,
                                    }}
                                  >
                                    <ChevronDown size={12} style={{ flexShrink: 0, marginTop: 1 }} />
                                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
                                  </span>
                                </td>
                              )}
                              <td
                                style={{
                                  fontSize: 10.5,
                                  position: "sticky",
                                  left: utilPersonRenderedW,
                                  width: 150,
                                  maxWidth: 150,
                                  background: "var(--surface)",
                                  color: UTIL_PREVIEW_COLOR[mode],
                                  fontWeight: 600,
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                }}
                              >
                                <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: UTIL_PREVIEW_COLOR[mode], flexShrink: 0 }} />
                                  {UTIL_PREVIEW_LABEL[mode]}
                                </span>
                              </td>
                              {utilDays.map((d) => {
                                const iso = toISO(d);
                                if (!isWorkingDay(d, holidaySet)) {
                                  return (
                                    <td key={iso} style={{ textAlign: "center", fontSize: 10.5, color: "var(--muted)", background: "var(--hover-bg)" }}>
                                      –
                                    </td>
                                  );
                                }
                                const av = utilAvailability(p.id, iso);
                                if (av?.status === "off") {
                                  return (
                                    <td key={iso} style={{ textAlign: "center", fontSize: 10, color: "var(--muted)", background: "#f1f2f4" }}>
                                      Off
                                    </td>
                                  );
                                }
                                // Phase 23: hours-based now (see
                                // previewDailyHoursFor above) -- `points`
                                // is kept as a name purely so the
                                // capacity/pct/tier math below (which
                                // expects a points-shaped ratio) didn't
                                // need touching, but the VALUE feeding it
                                // is now a real hours/STANDARD_DAILY_HOURS
                                // conversion, not the old effort-tier
                                // lookup.
                                const hoursTotal = previewDailyHoursFor(p.id, iso, modeTasks, modeProjects);
                                const points = hoursTotal / STANDARD_DAILY_HOURS;
                                const capacity = dailyCapacityFor(p as UtilPersonRow, av?.status === "half_day");
                                const pct = capacity > 0 ? (points / capacity) * 100 : points > 0 ? 999 : 0;
                                const tier = tierOf(pct);
                                // Hours are purely a display conversion of
                                // the SAME points/capacity already used for
                                // pct above (x STANDARD_DAILY_HOURS) -- not
                                // a new calculation.
                                const plannedHours = points * STANDARD_DAILY_HOURS;
                                const capacityHours = capacity * STANDARD_DAILY_HOURS;
                                return (
                                  <td
                                    key={iso}
                                    style={{ textAlign: "center", fontSize: 10.5, background: tier.bg, color: tier.fg, fontWeight: 600, lineHeight: 1.35 }}
                                    title={`${p.name} · ${UTIL_PREVIEW_LABEL[mode]} · ${iso} · ${tier.label}${av?.status === "half_day" ? " (half day)" : ""}`}
                                  >
                                    {tier.key === "none" ? (
                                      "–"
                                    ) : (
                                      <>
                                        {Math.round(pct)}%
                                        {utilShowHours && (
                                          <div style={{ fontSize: 8.5, fontWeight: 500, opacity: 0.85 }}>
                                            {plannedHours.toFixed(1)}h / {capacityHours.toFixed(1)}h
                                          </div>
                                        )}
                                      </>
                                    )}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </Fragment>
                    );
                  })}
                  {people.length === 0 && (
                    <tr>
                      <td colSpan={UTIL_WINDOW_DAYS + 2} style={{ padding: 10, color: "var(--muted)", fontSize: 12 }}>
                        No active people to show.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Sandra, 2026-07-29: "move the refresh dates button a bit
              lower, aligned with the legends" -- was its own right-
              aligned row above the legend; now shares one row with the
              legend (legend left, button right) so they read as a
              single control strip instead of two stacked ones. */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, marginBottom: 8, flexWrap: "wrap" }}>
            {Object.keys(baselineTasksById).length > 0 ? (
              // Design spec item 4/7 (Sandra, 2026-07-29): change-type
              // legend for the Changes vs Baseline column below.
              <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", fontSize: 11, color: "var(--text-secondary)" }}>
                {([
                  ["task_added", "New"],
                  ["hours_increased", "Increased"],
                  ["hours_decreased", "Decreased"],
                  ["date_changed", "Date changed"],
                  ["dependency_changed", "Dependency changed"],
                  ["assignee_changed", "Assignee changed"],
                ] as const).map(([key, label]) => (
                  <span key={key} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: CHANGE_DOT_COLOR[key], flexShrink: 0 }} />
                    {label}
                  </span>
                ))}
              </div>
            ) : (
              <span />
            )}
            <button
              onClick={refreshDates}
              title="Recompute Start dates for tasks that are still on auto-pilot (no dependency set, not manually overridden) based on the current row order -- useful after dragging a task into a new position."
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                padding: "5px 10px",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-sm, 6px)",
                background: "var(--surface)",
                color: "var(--text)",
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              <RefreshCw size={13} /> Refresh dates
            </button>
          </div>
          <div className="card" style={{ padding: 0, overflowX: "auto", overflowY: "visible" }}>
            <table
              className="data-table"
              style={{
                width:
                  22 +
                  WBS_TASK_COLUMN_ORDER.reduce((sum, k) => sum + wbsColWidth(k), 0) +
                  WBS_DATE_COLUMN_WIDTHS.reduce((sum, w) => sum + w, 0),
                tableLayout: "fixed",
              }}
            >
              {/* colgroup drives the actual rendered column widths under
                  table-layout:fixed -- more reliable than per-<th> widths
                  alone given this header spans two rows (rowSpan/colSpan
                  mixed), where browsers can be inconsistent about which
                  row's widths "win". */}
              <colgroup>
                <col style={{ width: 22 }} />
                {WBS_TASK_COLUMN_ORDER.map((k) => (
                  <col key={k} style={{ width: wbsColWidth(k) }} />
                ))}
                {WBS_DATE_COLUMN_WIDTHS.map((w, i) => (
                  <col key={i} style={{ width: w }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  <th
                    rowSpan={2}
                    className="row-gutter-cell"
                    style={{ width: 22, minWidth: 22, ...(wbsGutterStickyStyle(false) ?? {}) }}
                  />
                  <ResizableTh colKey="task">Task</ResizableTh>
                  <ResizableTh colKey="depends_on">Depends on</ResizableTh>
                  <ResizableTh colKey="assignee">Assignee</ResizableTh>
                  <ResizableTh colKey="work_type">Work Type</ResizableTh>
                  <ResizableTh colKey="output_type">Output Type</ResizableTh>
                  <ResizableTh colKey="output_count">Output Count</ResizableTh>
                  <ResizableTh colKey="effort_hours">Scoped Hours</ResizableTh>
                  <ResizableTh colKey="spent_hrs">Logged Hours</ResizableTh>
                  <ResizableTh colKey="effort">Effort</ResizableTh>
                  <ResizableTh colKey="changes" title="vs the active Baseline">
                    Changes vs Baseline
                  </ResizableTh>
                  {/* Phase 21 (2026-08-24): column order now Forecasted,
                      Capacity-Based, Full everywhere (was Full,
                      Capacity-Based, Manual) -- matches MODES' new order. */}
                  <th colSpan={3} style={{ textAlign: "center", ...modeColStyle("manual") }} title="Mirrors Capacity-Based until edited, then freezes -- this is what Save always records">
                    Forecasted
                  </th>
                  <th colSpan={3} style={{ textAlign: "center", ...modeColStyle("full_capacity") }} title="Read-only reference -- edit dates under Forecasted instead">
                    Theoretical
                  </th>
                </tr>
                <tr>
                  <th style={{ width: 110, ...modeColStyle("manual") }}>Start</th>
                  <th style={{ width: 100, ...modeColStyle("manual") }}>End Date</th>
                  <th style={{ width: 90, ...modeColStyle("manual") }}>Duration (days)</th>
                  <th style={{ width: 110, ...modeColStyle("full_capacity") }}>Start</th>
                  <th style={{ width: 100, ...modeColStyle("full_capacity") }}>End Date</th>
                  <th style={{ width: 90, ...modeColStyle("full_capacity") }}>Duration (days)</th>
                </tr>
              </thead>
              <tbody>
                {orderedTasks.length === 0 && (
                  <tr>
                    <td colSpan={17} style={{ padding: 14, color: "var(--muted)", fontSize: 12.5 }}>
                      No tasks in this project yet.
                    </td>
                  </tr>
                )}
                {orderedTasks.map((t) => {
                  const isParent = t.depth === 0 && hasChildren(t.id);
                  const assignee = people.find((p) => p.id === t.assignee_id);
                  const dependsOnIds = dependsOnIdsFor(t.id);
                  const draggedTask = draggedTaskId ? orderedTasks.find((x) => x.id === draggedTaskId) : undefined;
                  const validDropTarget =
                    !!draggedTask && draggedTask.id !== t.id && draggedTask.depth === t.depth && draggedTask.parent_task_id === t.parent_task_id;
                  // Sandra, 2026-07-29: a Done task's fields are frozen
                  // here too, not just its dates (see the computeEntry
                  // Done-lock above) -- during a revision canEditWbs is
                  // true for the whole page, but a completed task
                  // shouldn't still look editable. rowEditable gates
                  // every editable control in this row; the row itself
                  // gets a light gray fill so it visually reads as
                  // locked even while the rest of the table is open.
                  const rowLocked = t.status === "Done";
                  const rowEditable = canEditWbs && !rowLocked;
                  const glyph = statusGlyph(t.status);
                  return (
                    <tr
                      key={t.id}
                      className={dragOverTaskId === t.id && validDropTarget ? "row-drop-target" : undefined}
                      style={rowLocked ? { background: "var(--hover-bg)" } : undefined}
                      onDragOver={(e) => {
                        e.preventDefault();
                        if (dragOverTaskId !== t.id) setDragOverTaskId(t.id);
                      }}
                      onDragLeave={() => setDragOverTaskId((prev) => (prev === t.id ? null : prev))}
                      onDrop={() => {
                        if (draggedTaskId && validDropTarget) reorderTask(draggedTaskId, t.id);
                        setDraggedTaskId(null);
                        setDragOverTaskId(null);
                      }}
                    >
                      {/* Round 18 (2026-07-28): removed the dragged row's
                          own opacity restyle -- DataTable.tsx's proven
                          row-drag (used on Projects & Tasks, where the
                          grip works) never restyles the SOURCE row mid-
                          drag, only the drop target; re-rendering the
                          dragged element's own style while its native
                          drag is in flight is a plausible reason a
                          structurally-identical gutter column still
                          didn't drag on this page. Also: the drop-target
                          highlight now only lights up on a row that's
                          actually a valid target (same depth + same
                          parent -- reorder is siblings-only), so hovering
                          over an invalid target (e.g. a different
                          task's sub-task) no longer looks like a normal
                          drop zone that silently does nothing. */}
                      <td
                        className="row-gutter-cell"
                        onClick={(e) => e.stopPropagation()}
                        style={wbsGutterStickyStyle(true, rowLocked)}
                      >
                        <div className="row-gutter-inner" style={{ opacity: 1, paddingLeft: 4 }}>
                          <span
                            className="row-grip-btn"
                            draggable={rowEditable}
                            onDragStart={() => rowEditable && setDraggedTaskId(t.id)}
                            onDragEnd={() => {
                              setDraggedTaskId(null);
                              setDragOverTaskId(null);
                            }}
                            title={rowEditable ? "Drag to reorder (among its own siblings)" : rowLocked ? "Done -- locked" : undefined}
                            style={rowEditable ? undefined : { opacity: 0.35, cursor: "default" }}
                          >
                            <GripVertical size={13} />
                          </span>
                        </div>
                      </td>
                      <td style={{ overflow: "hidden", ...(wbsColStickyStyle("task", true, rowLocked) ?? {}) }}>
                        <div style={{ paddingLeft: t.depth * 16, fontWeight: t.depth === 0 ? 600 : 400, display: "flex", alignItems: "center", gap: 4 }}>
                          <span title={glyph.title} style={{ display: "inline-flex", flexShrink: 0 }}>
                            <glyph.Icon size={13} color={glyph.color} />
                          </span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <InlineText value={t.name} editable={rowEditable} bold={t.depth === 0} onCommit={(v) => saveTaskField(t.id, { name: v })} />
                          </div>
                          {rowEditable && t.depth === 0 && (
                            <button className="add-subtask-btn" onClick={() => addSubtask(t)} title="Add sub-task">
                              <Plus size={14} />
                            </button>
                          )}
                          {rowEditable && (
                            <button className="add-subtask-btn" onClick={() => deleteTask(t)} title={isParent ? "Delete task (and its sub-tasks)" : "Delete task"}>
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      </td>
                      <td style={{ position: "relative", ...(wbsColStickyStyle("depends_on", true, rowLocked) ?? {}) }}>
                        <DependsOnPicker
                          task={t}
                          allTasks={orderedTasks}
                          dependsOnIds={dependsOnIds}
                          isOpen={depPickerOpenFor === t.id}
                          editable={rowEditable}
                          onToggle={() => setDepPickerOpenFor((prev) => (prev === t.id ? null : t.id))}
                          onClose={() => setDepPickerOpenFor(null)}
                          onAdd={(depId) => addDependency(t.id, depId)}
                          onRemove={(depId) => removeDependency(t.id, depId)}
                        />
                      </td>
                      <td style={wbsColStickyStyle("assignee", true, rowLocked)}>
                        {isParent ? (
                          (() => {
                            const { multiple } = parentAssigneeState(t.id);
                            if (multiple) {
                              return (
                                <span
                                  style={{ fontSize: 11.5, color: "var(--muted)", fontStyle: "italic" }}
                                  title="This task's own sub-tasks are assigned to more than one person -- pick a single Assignee on each sub-task instead."
                                >
                                  Multiple
                                </span>
                              );
                            }
                            return assignee ? (
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }} title="Mirrors its sub-tasks -- all currently assigned to the same person.">
                                <span style={{ width: 8, height: 8, borderRadius: "50%", background: colorForPerson(assignee), flexShrink: 0 }} />
                                {assignee.name}
                              </span>
                            ) : (
                              <span style={{ fontSize: 11.5, color: "var(--muted)" }}>Unassigned</span>
                            );
                          })()
                        ) : (
                          <InlineSelect
                            value={assignee?.name ?? ""}
                            editable={rowEditable}
                            allowEmpty
                            emptyLabel="Unassigned"
                            options={people.map((p) => p.name)}
                            renderReadOnly={(v) =>
                              v ? (
                                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                  <span
                                    style={{
                                      width: 8,
                                      height: 8,
                                      borderRadius: "50%",
                                      background: colorForPerson(assignee),
                                      flexShrink: 0,
                                    }}
                                  />
                                  {v}
                                </span>
                              ) : (
                                "Unassigned"
                              )
                            }
                            onCommit={(name) => {
                              const p = people.find((pp) => pp.name === name);
                              saveTaskField(t.id, { assignee_id: p?.id ?? null });
                            }}
                          />
                        )}
                      </td>
                      <td style={wbsColStickyStyle("work_type", true, rowLocked)}>
                        {isParent ? (
                          <span style={{ fontSize: 11.5, color: "var(--muted)" }} title="Not applicable -- a parent task's own Work Type is already represented by its sub-tasks.">
                            N/A
                          </span>
                        ) : (
                          (() => {
                            const currentWt = workTypes.find((w) => w.id === t.work_type_id);
                            // Active work types for the picker, plus the
                            // task's own currently-set Work Type even if it
                            // was since deactivated, so its historical
                            // label doesn't just vanish from the dropdown.
                            const pickable = workTypes.filter((w) => w.is_active || w.id === t.work_type_id);
                            return (
                              <InlineSelect
                                value={currentWt?.name ?? ""}
                                editable={rowEditable}
                                allowEmpty
                                emptyLabel="Pick work type"
                                options={pickable.map((w) => w.name)}
                                onCommit={(v) => {
                                  const match = pickable.find((w) => w.name === v);
                                  saveTaskField(t.id, { work_type_id: match?.id ?? null });
                                }}
                              />
                            );
                          })()
                        )}
                      </td>
                      <td style={wbsColStickyStyle("output_type", true, rowLocked)}>
                        {(() => {
                          const currentOt = outputTypes.find((o) => o.id === t.output_type_id);
                          // Phase 23 (2026-08-25): conditional Output Type --
                          // Sandra: "I want the output be conditional based
                          // on task type." Once a Work Type is mapped to at
                          // least one Output Type, only those (plus the
                          // active-or-already-set rule from before) are
                          // pickable; with no Work Type set, or a Work Type
                          // that has zero mapped rows, every active Output
                          // Type is offered so nothing is ever unpickable.
                          const mappedOutputTypeIds = t.work_type_id
                            ? new Set(workTypeOutputTypes.filter((m) => m.work_type_id === t.work_type_id).map((m) => m.output_type_id))
                            : null;
                          const pickableOt = outputTypes.filter(
                            (o) =>
                              (o.is_active || o.id === t.output_type_id) &&
                              (!mappedOutputTypeIds || mappedOutputTypeIds.size === 0 || mappedOutputTypeIds.has(o.id) || o.id === t.output_type_id)
                          );
                          // Sandra, 2026-08-26: Output Type shouldn't be
                          // pickable at all until a Work Type is chosen
                          // first (leaf tasks only -- parent rows never
                          // carry a Work Type, that's N/A by design, so
                          // they stay open per the "every task gets
                          // Output Type" rule from the original Materials
                          // Output ship).
                          const needsWorkTypeFirst = !isParent && !t.work_type_id;
                          if (needsWorkTypeFirst) {
                            return (
                              <span style={{ fontSize: 11.5, color: "var(--muted)" }} title="Pick a Work Type first -- Output Type options depend on it.">
                                Pick Work Type first
                              </span>
                            );
                          }
                          return (
                            <InlineSelect
                              value={currentOt?.name ?? ""}
                              editable={rowEditable}
                              allowEmpty
                              emptyLabel="Pick output type"
                              options={pickableOt.map((o) => o.name)}
                              onCommit={(v) => {
                                const match = pickableOt.find((o) => o.name === v);
                                saveTaskField(t.id, { output_type_id: match?.id ?? null });
                              }}
                            />
                          );
                        })()}
                      </td>
                      <td style={wbsColStickyStyle("output_count", true, rowLocked)}>
                        <InlineNumber
                          value={t.output_count}
                          // Sandra, 2026-08-26: "I can't edit output count.
                          // I think it's locked because all tasks are
                          // done." Correct diagnosis -- the DB's own
                          // enforce_done_task_lock trigger only locks
                          // scoping fields (name/hours/effort/work
                          // type/assignee/start date), NOT output_count,
                          // so this was purely a frontend over-lock: every
                          // WBS cell used the same blanket `rowEditable`
                          // (canEditWbs && status!=='Done'). Output Count
                          // is deliberately the CLOSURE-time gate (see
                          // handleRequestClosure's missingOutputCount
                          // check) -- it's supposed to stay fillable right
                          // up through Done, only Project Closed
                          // (!canEditWbs) or a parent row should disable
                          // it.
                          editable={canEditWbs && !isParent}
                          onCommit={(v) => saveTaskField(t.id, { output_count: v })}
                        />
                      </td>
                      <td style={wbsColStickyStyle("effort_hours", true, rowLocked)}>
                        <span title={isParent ? "Computed from this task's own sub-tasks (sum of their Scoped Hours)" : undefined}>
                          <InlineNumber
                            value={t.estimated_hours}
                            editable={rowEditable && !isParent}
                            onCommit={(v) => saveTaskField(t.id, { estimated_hours: v })}
                          />
                        </span>
                      </td>
                      <td style={{ fontVariantNumeric: "tabular-nums", ...(wbsColStickyStyle("spent_hrs", true, rowLocked) ?? {}) }}>{formatHours(spentHoursFor(t.id))}</td>
                      <td style={wbsColStickyStyle("effort", true, rowLocked)}>
                        {isParent ? (
                          <span style={{ fontSize: 11.5, color: "var(--muted)" }} title="Not applicable -- a parent task's own effort is already represented by its sub-tasks' own Effort/points, so it doesn't carry a separate value.">
                            N/A
                          </span>
                        ) : (
                          // Phase 12 (2026-08-20): Effort is no longer
                          // independently pickable -- it's always computed
                          // from Scoped Hours by the DB trigger
                          // (derive_task_effort, supabase/phase12_migration.sql),
                          // so this is now a plain read-only chip, same as
                          // the main Tasks page. A "Very Heavy" result gets
                          // a small non-blocking hint suggesting the task
                          // be split up -- purely informational.
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                            {t.effort ? (
                              <span className={`status-pill ${TASK_EFFORT_DEFAULT_TONES[t.effort] ?? "neutral"}`}>{t.effort}</span>
                            ) : (
                              <span style={{ fontSize: 11.5, color: "var(--muted)" }}>—</span>
                            )}
                            {t.effort === "Very Heavy" && (
                              <span title="Very Heavy (over 24 planned effort hours) -- consider breaking this task into smaller sub-tasks.">
                                <AlertTriangle size={12} color="var(--warning-text)" />
                              </span>
                            )}
                          </span>
                        )}
                      </td>
                      <td style={wbsColStickyStyle("changes", true, rowLocked)}>
                        {(() => {
                          // Sandra, 2026-07-29: "omit the notes column and
                          // just put the values in the changes vs baseline,
                          // following the legend colors in the text" --
                          // merged the old dot-only Changes column and the
                          // separate Notes column into one: each note now
                          // renders as text colored by its own change kind
                          // (same CHANGE_DOT_COLOR palette as the legend),
                          // instead of a row of plain dots plus a second
                          // column repeating the same info as gray text.
                          if (Object.keys(baselineTasksById).length === 0) return <span style={{ color: "var(--muted)" }}>—</span>;
                          const { kinds, notes } = taskBaselineDiff(t, isParent);
                          if (kinds.length === 0) return <span style={{ color: "var(--muted)" }}>No change</span>;
                          return (
                            <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap" }}>
                              {kinds.map((k, i) => (
                                <span key={`${k}-${i}`} style={{ fontSize: 11.5, fontWeight: 600, color: CHANGE_DOT_COLOR[k] }} title={k.replace(/_/g, " ")}>
                                  {notes[i]}
                                </span>
                              ))}
                            </span>
                          );
                        })()}
                      </td>
                      {/* Phase 21: render order matches the reordered
                          header above -- Forecasted, Capacity-Based, Full. */}
                      {renderModeCells(t, "manual", isParent)}
                      {/* Capacity-Based column removed 2026-08-26 */}
                      {renderModeCells(t, "full_capacity", isParent)}
                    </tr>
                  );
                })}
                {canEditWbs && (
                  <tr>
                    <td colSpan={17} className="add-row-cell">
                      <div className="add-row-trigger" onClick={addTopLevelTask}>
                        <Plus size={12} />
                        New task
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Timeline (Gantt) -- all 3 scenarios stacked (2026-07-28:
              previously just whichever mode was toggled active; Sandra
              asked for all side by side since the scoping table above
              already shows all 3 regardless of toggle). renderGantt(mode)
              below is the same markup as before, just parameterized
              instead of reading `activeMode` directly, called once per
              MODE. Phase 21 (2026-08-24): now filtered by the same
              `visibleScenarios` centralized toggle that filters the
              Utilization snapshot rows -- "select which views he wants
              to see... scenarios and gantt will only show forecasted
              ones." Order comes for free from MODES' own Phase 21
              reorder (Forecasted, Capacity-Based, Full). */}
          {MODES.filter((mode) => visibleScenarios.has(MODE_TO_SCENARIO[mode])).map((mode) => {
            const { startDate: ganttStartDate, days: ganttDays, widthPx: ganttWidthPx } = ganttMetricsFor(chainByMode[mode]);
            return (
              <div key={mode} className="card" style={{ padding: 14, marginTop: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <strong style={{ fontSize: 12.5, color: "var(--navy)" }}>Timeline (Gantt) — {MODE_LABEL[mode]}</strong>
                </div>
                {ganttDays.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--muted)", padding: "6px 0" }}>
                    No schedule yet -- add a Start date and Estimated hours to at least one task to see the timeline.
                  </div>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    {/* Sandra, 2026-07-24: "is it ok if we show dependencies via
                        a light broken or thin line just to show relationship?"
                        -- a single SVG overlay (`ganttConnectors()` below)
                        spans the whole header+rows area so an elbow line can be
                        drawn from any predecessor row to any successor row
                        (they're rarely adjacent). This wrapping div is what
                        that overlay is absolutely positioned against; nothing
                        else changed about the header/row markup below, just
                        moved their shared `minWidth` up onto this one wrapper
                        instead of repeating it on every row. Read-only lines
                        only -- NOT the deferred drag-to-create-a-dependency
                        feature, which is a separate, bigger interaction and
                        still not started. */}
                    <div style={{ position: "relative", minWidth: GANTT_NAME_COL_WIDTH + ganttWidthPx }}>
                    <div style={{ display: "flex" }}>
                      <div style={{ width: GANTT_NAME_COL_WIDTH, flexShrink: 0, position: "sticky", left: 0, background: "var(--surface)", zIndex: 1 }} />
                      <div style={{ position: "relative", width: ganttWidthPx, height: 24, flexShrink: 0 }}>
                        {ganttDays.map((d, i) => {
                          const iso = toISO(d);
                          const offDay = !isWorkingDay(d, holidaySet);
                          const isFirstOfMonth = d.getDate() === 1 || i === 0;
                          return (
                            <div
                              key={iso}
                              title={iso}
                              style={{
                                position: "absolute",
                                left: i * GANTT_DAY_WIDTH,
                                top: 0,
                                width: GANTT_DAY_WIDTH,
                                height: "100%",
                                fontSize: 9.5,
                                textAlign: "center",
                                color: offDay ? "var(--muted)" : "var(--text)",
                                background: offDay ? "var(--hover-bg)" : undefined,
                                fontWeight: isFirstOfMonth ? 700 : 400,
                                borderLeft: isFirstOfMonth ? "1px solid var(--border)" : undefined,
                              }}
                            >
                              {String(d.getMonth() + 1).padStart(2, "0")}/{String(d.getDate()).padStart(2, "0")}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    {orderedTasks.map((t) => {
                      const entry = chainByMode[mode].get(t.id);
                      const isParent = t.depth === 0 && hasChildren(t.id);
                      const assignee = people.find((p) => p.id === t.assignee_id);
                      const barColor = assignee ? colorForPerson(assignee) : UNASSIGNED_BAR_COLOR;
                      return (
                        <div key={t.id} style={{ display: "flex" }}>
                          <div
                            style={{
                              width: GANTT_NAME_COL_WIDTH,
                              flexShrink: 0,
                              position: "sticky",
                              left: 0,
                              background: "var(--surface)",
                              zIndex: 1,
                              fontSize: 11.5,
                              fontWeight: t.depth === 0 ? 600 : 400,
                              paddingLeft: 8 + t.depth * 16,
                              paddingRight: 8,
                              height: 26,
                              display: "flex",
                              alignItems: "center",
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              borderBottom: "1px solid var(--hover-bg)",
                            }}
                            title={assignee ? `${t.name} \u00b7 ${assignee.name}` : t.name}
                          >
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{t.name}</span>
                            {assignee && (
                              <span
                                style={{
                                  marginLeft: 5,
                                  flexShrink: 0,
                                  fontSize: 10,
                                  fontWeight: 400,
                                  color: "var(--muted)",
                                }}
                              >
                                &middot; {assignee.name}
                              </span>
                            )}
                          </div>
                          <div style={{ position: "relative", width: ganttWidthPx, height: 26, flexShrink: 0, borderBottom: "1px solid var(--hover-bg)" }}>
                            {ganttDays.map((d) => {
                              const iso = toISO(d);
                              if (isWorkingDay(d, holidaySet)) return null;
                              return (
                                <div
                                  key={iso}
                                  style={{
                                    position: "absolute",
                                    left: ganttDayOffsetPx(ganttStartDate, iso),
                                    top: 0,
                                    bottom: 0,
                                    width: GANTT_DAY_WIDTH,
                                    background: "var(--hover-bg)",
                                  }}
                                />
                              );
                            })}
                            {entry ? (
                              <div
                                title={`${t.name} · ${assignee?.name ?? "Unassigned"} · ${formatDate(entry.start)} → ${formatDate(entry.end)}`}
                                style={{
                                  position: "absolute",
                                  left: ganttDayOffsetPx(ganttStartDate, entry.start),
                                  width: ganttBarWidthPx(entry.start, entry.end),
                                  top: isParent ? 9 : 4,
                                  height: isParent ? 8 : 18,
                                  background: barColor,
                                  opacity: isParent ? 0.55 : 1,
                                  borderRadius: 4,
                                  display: "flex",
                                  alignItems: "center",
                                  paddingLeft: 5,
                                  color: "#fff",
                                  fontSize: 9.5,
                                  fontWeight: 600,
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                }}
                              >
                                {!isParent && entry.durationDays}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                    <svg
                      width={GANTT_NAME_COL_WIDTH + ganttWidthPx}
                      height={GANTT_HEADER_HEIGHT + orderedTasks.length * GANTT_ROW_HEIGHT}
                      style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }}
                    >
                      {/* Sandra, 2026-07-28: wants the dependency connectors
                          to read as arrows, not bare lines -- two markers
                          (neutral gray / conflict amber, matching each
                          path's own stroke) so the arrowhead color always
                          matches the line it's attached to. */}
                      <defs>
                        <marker id={`gantt-arrow-neutral-${mode}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                          <path d="M0,0 L8,4 L0,8 Z" fill="var(--muted, #8a94a6)" />
                        </marker>
                        <marker id={`gantt-arrow-conflict-${mode}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                          <path d="M0,0 L8,4 L0,8 Z" fill="var(--warning-text, #b45309)" />
                        </marker>
                      </defs>
                      {ganttConnectors(chainByMode[mode], mode, ganttStartDate)}
                    </svg>
                    </div>
                  </div>
                )}
              </div>
            );
          })}


      {/* Design spec item 8 (Sandra, 2026-07-29): bottom status bar --
          mirrors the top banner's status chip but adds forward-looking
          "what's next" copy and the workflow's next actions, so someone
          scrolled to the bottom of a long task list/Gantt doesn't have to
          scroll back up to see what to do next. Deliberately kept
          alongside the top banner rather than replacing it (decision #3
          in [[project_capaciq_wbs_ui_redesign_plan]]). */}
      <div
        className="card"
        style={{
          marginTop: 12,
          padding: "12px 14px",
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          background: WBS_STATUS_META[project.wbs_status]?.bg,
          borderColor: WBS_STATUS_META[project.wbs_status]?.border,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 700, color: WBS_STATUS_META[project.wbs_status]?.color }}>
          {WBS_STATUS_META[project.wbs_status]?.label ?? project.wbs_status}
        </span>
        <span style={{ fontSize: 11.5, color: "var(--muted)" }}>
          {project.wbs_status === "draft" && "Start Project once scoping is final to start tracking against it."}
          {project.wbs_status === "baseline_locked" && "This is the official commitment. You can keep editing -- close the project once work is complete."}
          {project.wbs_status === "changed_after_baseline" &&
            "This plan differs from the original baseline. Baselines are locked once by design -- variance tracking measures against the original. Close the project once work is complete."}
          {project.wbs_status === "revision_in_progress" && "This project has a legacy revision in progress -- view the audit trail for its history."}
          {project.wbs_status === "closed" && "Final Scope is locked. View the audit trail for a full history of every change."}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          {project.wbs_status !== "draft" && (
            <button className="btn-secondary" onClick={() => navigate(`/projects/${project.id}/audit-trail`)}>
              View Audit Trail
            </button>
          )}
          {/* Close Project moved into the top banner's Actions menu
              (2026-08-27, Sandra: "add an action button instead and from
              there pick Re-Baseline and Close project") -- same
              handleRequestClosure handler, same visibility condition,
              just no longer duplicated as its own button down here. */}
        </div>
      </div>
    </div>
  );
}

// "Depends on" picker -- a lightweight multi-select popover, built local to
// this file since no shared multi-select component exists yet elsewhere in
// the app (InlineSelect is single-value only). Round 1 of task dependencies
// (2026-07-24): Finish-to-Start only, same-project only, set via this
// dropdown -- drag-linking directly on the Gantt chart is a deferred
// follow-up, not built here. Selecting a predecessor does NOT lock or
// compute this task's own Start date; it only feeds the conflict-warning
// check back in the parent (dependencyConflict), since Sandra chose to
// keep Start freely editable rather than making it computed like a
// parent-task rollup.
//
// Round 12 fix (Sandra: "the dependency list is hidden. Unable to see the
// rest of the list. Scroll is not working either"): the popover used to be
// `position: absolute` inside this cell's own `<td>`, which sits inside the
// table's `overflowX: auto` wrapper card -- any ancestor with `overflow`
// set clips an absolutely-positioned descendant to its own box once the
// popover would otherwise extend past it (same class of bug already
// documented once before for a different table, see
// [[feedback_table_cell_popover_clipping]]). Fixed by portaling the
// popover straight to `document.body` with `position: fixed`, positioned
// from the trigger button's own `getBoundingClientRect()` at open time --
// nothing about it lives inside the table's DOM subtree anymore, so no
// ancestor's overflow/clipping rule can touch it. Also flips to render
// ABOVE the button instead of below when there isn't enough room left in
// the viewport underneath it.
// Phase 3 (2026-07-28): generalized "Compare with Baseline" -- unlike
// BaselineReport.tsx (which only ever compares against the FINAL close-out
// snapshot), this can be opened at any point once a baseline exists, and
// diffs the active Baseline (project_baselines, is_active = true) against
// whatever is live on screen right now (passed in as `liveTasks`, the same
// snapshot shape the lock/apply/decide RPCs persist -- see
// buildTaskSnapshotPayload above).
interface BaselineTaskSnapshot {
  task_id: string;
  name: string;
  estimated_hours: number | null;
}
interface LiveTaskSnapshot {
  task_id: string;
  name: string;
  estimated_hours: number | null;
  parent_task_id: string | null;
}
function CompareWithBaselinePanel({ projectId, liveTasks }: { projectId: string; liveTasks: LiveTaskSnapshot[] }) {
  const [baseline, setBaseline] = useState<{ version_number: number; total_est_hours: number; task_count: number; captured_at: string } | null>(null);
  const [baselineTasks, setBaselineTasks] = useState<BaselineTaskSnapshot[]>([]);
  // Sandra, 2026-07-29: "Overall Variance" was hardcoding the Current Plan
  // label as baseline.version_number + 1 -- always "V2" no matter how many
  // revisions had actually been applied since that baseline was locked
  // (she was on Revision 5 but the panel still said "Current Plan V2").
  // Fix: count APPLIED revisions whose applied_at is after this baseline's
  // captured_at, and add that count on top of the baseline version instead
  // of always assuming exactly one change.
  const [appliedSinceBaseline, setAppliedSinceBaseline] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      const { data: bl } = await supabase
        .from("project_baselines")
        .select("id,version_number,total_est_hours,task_count,captured_at")
        .eq("project_id", projectId)
        .eq("is_active", true)
        .maybeSingle();
      if (!active) return;
      if (bl) {
        const baselineRow = bl as { id: string; version_number: number; total_est_hours: number; task_count: number; captured_at: string };
        setBaseline(baselineRow);
        const [{ data: blt }, { data: appliedRevs }] = await Promise.all([
          supabase.from("project_baseline_tasks").select("task_id,name,estimated_hours").eq("baseline_id", baselineRow.id),
          supabase
            .from("project_revisions")
            .select("id")
            .eq("project_id", projectId)
            .eq("status", "applied")
            .gt("applied_at", baselineRow.captured_at),
        ]);
        if (active) {
          setBaselineTasks((blt as BaselineTaskSnapshot[]) ?? []);
          setAppliedSinceBaseline((appliedRevs ?? []).length);
        }
      } else {
        setBaseline(null);
        setBaselineTasks([]);
        setAppliedSinceBaseline(0);
      }
      if (active) setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [projectId]);

  const liveTotalHours = liveTasks.filter((t) => !t.parent_task_id).reduce((sum, t) => sum + (t.estimated_hours ?? 0), 0);
  const liveTaskCount = liveTasks.length;

  const baselineIds = new Set(baselineTasks.map((t) => t.task_id));
  const liveIds = new Set(liveTasks.map((t) => t.task_id));
  const added = liveTasks.filter((t) => !baselineIds.has(t.task_id));
  const removed = baselineTasks.filter((t) => !liveIds.has(t.task_id));
  const changed = liveTasks
    .filter((t) => baselineIds.has(t.task_id))
    .map((t) => ({ live: t, base: baselineTasks.find((b) => b.task_id === t.task_id)! }))
    .filter(({ live, base }) => (live.estimated_hours ?? 0) !== (base.estimated_hours ?? 0));

  const hoursVariance = baseline ? liveTotalHours - baseline.total_est_hours : 0;
  const taskVariance = baseline ? liveTaskCount - baseline.task_count : 0;
  const currentPlanLabel = baseline ? `Current Plan V${baseline.version_number + appliedSinceBaseline}` : "Current Plan";

  function varianceCell(delta: number, suffix: string) {
    if (delta === 0) return <span style={{ color: "var(--muted)" }}>No variance</span>;
    return (
      <span style={{ color: "var(--warning-text, #b45309)", fontWeight: 600 }}>
        {delta > 0 ? "+" : ""}
        {delta}
        {suffix}
      </span>
    );
  }

  return (
    // Design spec item 5 (Sandra, 2026-07-29): renamed from "Compare with
    // Baseline" to "Overall Variance", restyled from stat-pair blocks to
    // the reference's more literal Metric/Baseline/Current-Plan/Variance
    // table layout. Same underlying data/logic (Phase 3's baseline vs
    // live-tasks diff) -- this is a presentation change only, per decision
    // #2 in [[project_capaciq_wbs_ui_redesign_plan]] (full per-field diff
    // depth stays deferred; this is still the aggregate-only comparison).
    <div className="card" style={{ padding: 14 }}>
      <strong style={{ fontSize: 12.5, color: "var(--navy)" }}>Overall Variance</strong>
      {loading ? (
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6 }}>Loading…</div>
      ) : !baseline ? (
        <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6 }}>No baseline locked yet.</div>
      ) : (
        <>
          <table style={{ width: "100%", marginTop: 8, fontSize: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "4px 6px", color: "var(--muted)", fontSize: 11, fontWeight: 600 }}>Metric</th>
                <th style={{ textAlign: "left", padding: "4px 6px", color: "var(--muted)", fontSize: 11, fontWeight: 600 }}>Baseline V{baseline.version_number}</th>
                <th style={{ textAlign: "left", padding: "4px 6px", color: "var(--muted)", fontSize: 11, fontWeight: 600 }}>{currentPlanLabel}</th>
                <th style={{ textAlign: "left", padding: "4px 6px", color: "var(--muted)", fontSize: 11, fontWeight: 600 }}>Variance</th>
              </tr>
            </thead>
            <tbody>
              <tr style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "5px 6px" }}>Est. hours</td>
                <td style={{ padding: "5px 6px" }}>{baseline.total_est_hours}h</td>
                <td style={{ padding: "5px 6px" }}>{liveTotalHours}h</td>
                <td style={{ padding: "5px 6px" }}>{varianceCell(hoursVariance, "h")}</td>
              </tr>
              <tr style={{ borderTop: "1px solid var(--border)" }}>
                <td style={{ padding: "5px 6px" }}>Task count</td>
                <td style={{ padding: "5px 6px" }}>{baseline.task_count}</td>
                <td style={{ padding: "5px 6px" }}>{liveTaskCount}</td>
                <td style={{ padding: "5px 6px" }}>{varianceCell(taskVariance, "")}</td>
              </tr>
            </tbody>
          </table>
          {/* Sandra, 2026-07-29 follow-up: removed the per-task
              added/removed/changed detail list that used to sit below
              this table -- redundant now that the task list's own
              Changes vs Baseline + Notes columns show the same
              per-task detail directly. */}
        </>
      )}
    </div>
  );
}

// Round 2 of the WBS UI redesign (Sandra, 2026-07-29): consolidates the
// header's growing button row (Start Revision/Re-baseline/Revision
// History/Compare with Baseline) into one "Actions" dropdown, leaving
// just the single primary CTA (Lock Baseline / Close Project / Apply
// Revision, whichever applies to the current status) visible directly.
// Same portal-to-document.body pattern as DependsOnPicker below, since a
// locally `absolute` popover risks the same table/card clipping issue
// noted in [[feedback_table_cell_popover_clipping]].
function ActionsMenu({ items }: { items: { label: string; onClick: () => void; disabled?: boolean }[] }) {
  const [isOpen, setIsOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const MENU_WIDTH = 200;

  if (items.length === 0) return null;

  function handleToggle() {
    if (!isOpen && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const left = Math.max(4, Math.min(rect.right - MENU_WIDTH, document.documentElement.clientWidth - MENU_WIDTH - 4));
      setPos({ top: rect.bottom + 4, left });
    }
    setIsOpen((v) => !v);
  }

  return (
    <div style={{ position: "relative" }}>
      <button ref={btnRef} className="btn-secondary" onClick={handleToggle}>
        Actions <ChevronDown size={14} />
      </button>
      {isOpen &&
        pos &&
        createPortal(
          <>
            <div style={{ position: "fixed", inset: 0, zIndex: 1000 }} onClick={() => setIsOpen(false)} />
            <div
              className="card"
              style={{
                position: "fixed",
                top: pos.top,
                left: pos.left,
                width: MENU_WIDTH,
                padding: 4,
                zIndex: 1001,
                boxShadow: "0 4px 14px rgba(0,0,0,0.18)",
              }}
            >
              {items.map((it) => (
                <button
                  key={it.label}
                  disabled={it.disabled}
                  onClick={() => {
                    setIsOpen(false);
                    it.onClick();
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    padding: "7px 10px",
                    fontSize: 12,
                    borderRadius: 6,
                    cursor: it.disabled ? "default" : "pointer",
                    color: it.disabled ? "var(--muted)" : "var(--text)",
                  }}
                  onMouseEnter={(e) => {
                    if (!it.disabled) e.currentTarget.style.background = "var(--hover-bg)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                  }}
                >
                  {it.label}
                </button>
              ))}
            </div>
          </>,
          document.body
        )}
    </div>
  );
}

function DependsOnPicker({
  task,
  allTasks,
  dependsOnIds,
  isOpen,
  editable = true,
  onToggle,
  onClose,
  onAdd,
  onRemove,
}: {
  task: TaskRow & { depth: number };
  allTasks: (TaskRow & { depth: number })[];
  dependsOnIds: string[];
  isOpen: boolean;
  editable?: boolean;
  onToggle: () => void;
  onClose: () => void;
  onAdd: (depId: string) => void;
  onRemove: (depId: string) => void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; openUp: boolean } | null>(null);
  const candidates = allTasks.filter((t) => t.id !== task.id);
  const selectedNames = dependsOnIds
    .map((id) => allTasks.find((t) => t.id === id)?.name)
    .filter((n): n is string => !!n);

  const PANEL_WIDTH = 240;
  const PANEL_MAX_HEIGHT = 260;

  function handleToggle() {
    if (!isOpen && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      const roomBelow = window.innerHeight - rect.bottom;
      const openUp = roomBelow < PANEL_MAX_HEIGHT && rect.top > roomBelow;
      setPos({
        top: openUp ? rect.top - 4 : rect.bottom + 4,
        left: Math.min(rect.left, window.innerWidth - PANEL_WIDTH - 8),
        openUp,
      });
    }
    onToggle();
  }

  return (
    <div style={{ position: "relative" }}>
      <button
        ref={btnRef}
        type="button"
        disabled={!editable}
        onClick={editable ? handleToggle : undefined}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          width: "100%",
          textAlign: "left",
          background: "transparent",
          border: "none",
          cursor: editable ? "pointer" : "default",
          padding: "3px 4px",
          borderRadius: 4,
          fontSize: 11.5,
          color: selectedNames.length ? "var(--text)" : "var(--muted)",
        }}
        title={editable ? (selectedNames.length ? selectedNames.join(", ") : "No dependencies -- click to add") : selectedNames.join(", ") || undefined}
      >
        <Link2 size={12} style={{ flexShrink: 0, color: "var(--muted)" }} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selectedNames.length ? selectedNames.join(", ") : "None"}
        </span>
      </button>

      {editable &&
        isOpen &&
        pos &&
        createPortal(
          <>
            {/* Transparent click-outside-to-close backdrop, same trick used
                elsewhere for lightweight popovers in this app rather than a
                document-level event listener. */}
            <div style={{ position: "fixed", inset: 0, zIndex: 1000 }} onClick={onClose} />
            <div
              className="card"
              style={{
                position: "fixed",
                top: pos.openUp ? undefined : pos.top,
                bottom: pos.openUp ? window.innerHeight - pos.top : undefined,
                left: pos.left,
                width: PANEL_WIDTH,
                maxHeight: PANEL_MAX_HEIGHT,
                overflowY: "auto",
                zIndex: 1001,
                padding: 6,
                boxShadow: "0 4px 14px rgba(0,0,0,0.18)",
              }}
            >
              {candidates.length === 0 && <div style={{ fontSize: 11.5, color: "var(--muted)", padding: 4 }}>No other tasks yet.</div>}
              {candidates.map((c) => {
                const checked = dependsOnIds.includes(c.id);
                return (
                  <label
                    key={c.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "4px 4px",
                      fontSize: 11.5,
                      cursor: "pointer",
                      borderRadius: 3,
                    }}
                  >
                    <input type="checkbox" checked={checked} onChange={() => (checked ? onRemove(c.id) : onAdd(c.id))} />
                    <span style={{ paddingLeft: c.depth * 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                  </label>
                );
              })}
            </div>
          </>,
          document.body
        )}
    </div>
  );
}
