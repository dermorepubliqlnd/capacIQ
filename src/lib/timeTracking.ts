import { supabase } from "./supabaseClient";

// Shared types + helpers for the Task Timer / Time Tracking feature.
// Mirrors the extension_requests governance model (see
// [[project_capaciq_extension_requests]]): owner decides a manual entry
// unless the owner is the one who logged it, in which case it escalates
// to the owner's manager. Full Access can always decide, and can also
// correct an already-finalized entry (never silently -- corrections leave
// original_duration_minutes + corrected_by/at behind).

export type TimeEntrySource = "timer" | "manual" | "legacy";
export type TimeEntryStatus = "running" | "pending_confirm" | "confirmed" | "pending_approval" | "approved" | "rejected";

export interface TimeEntryRow {
  id: string;
  task_id: string;
  person_id: string;
  started_at: string;
  ended_at: string | null;
  duration_minutes: number | null;
  source: TimeEntrySource;
  status: TimeEntryStatus;
  requested_by: string | null;
  reason_notes: string | null;
  auto_stopped: boolean;
  confirmed_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_notes: string | null;
  corrected_by: string | null;
  corrected_at: string | null;
  original_duration_minutes: number | null;
  correction_notes: string | null;
  created_at: string;
}

// Only these statuses represent finalized, real time -- Spent Hrs (and any
// rollup of it) should only ever sum these three.
const COUNTED_STATUSES: TimeEntryStatus[] = ["confirmed", "approved", "legacy"] as unknown as TimeEntryStatus[];
// (legacy entries are inserted with status 'confirmed' + source 'legacy',
// so in practice this is just ['confirmed', 'approved'] -- kept as a
// named constant so the intent reads clearly at call sites.)

export function isCountedEntry(e: Pick<TimeEntryRow, "status">): boolean {
  return e.status === "confirmed" || e.status === "approved";
}

export function minutesFor(entries: TimeEntryRow[], taskId: string): number {
  return entries.filter((e) => e.task_id === taskId && isCountedEntry(e)).reduce((sum, e) => sum + (e.duration_minutes ?? 0), 0);
}

// Own hours only (rounded to 2dp hours) -- used by leaf tasks and as the
// "own" component of a parent's rollup total.
export function ownHoursFor(entries: TimeEntryRow[], taskId: string): number {
  return Math.round((minutesFor(entries, taskId) / 60) * 100) / 100;
}

// Parent rollup: own entries + every descendant's total, mirroring the
// existing date rollup pattern (taskDatesFromSubtasks) but summed instead
// of min/maxed. childrenOf should return direct sub-task ids for a given
// parent id (callers already have this via `tasks.filter(...)`).
export function rollupHoursFor(taskId: string, entries: TimeEntryRow[], childrenOf: (id: string) => string[]): number {
  const own = minutesFor(entries, taskId);
  const childMinutes = childrenOf(taskId).reduce((sum, childId) => sum + minutesFor(entries, childId), 0);
  return Math.round(((own + childMinutes) / 60) * 100) / 100;
}

export function formatDuration(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return "—";
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function formatHours(hours: number): string {
  if (hours === 0) return "0";
  return hours.toFixed(hours % 1 === 0 ? 0 : 2);
}

export async function startTimer(taskId: string): Promise<{ id?: string; error?: string }> {
  const { data, error } = await supabase.rpc("start_timer", { p_task_id: taskId });
  if (error) return { error: error.message };
  return { id: data as unknown as string };
}

export async function stopTimer(entryId: string): Promise<{ error?: string }> {
  const { error } = await supabase.rpc("stop_timer", { p_entry_id: entryId });
  if (error) return { error: error.message };
  return {};
}

export async function confirmTimeEntry(
  entryId: string,
  overrides: { startedAt?: string; endedAt?: string; notes?: string } = {}
): Promise<{ error?: string }> {
  const { error } = await supabase.rpc("confirm_time_entry", {
    p_entry_id: entryId,
    p_started_at: overrides.startedAt ?? null,
    p_ended_at: overrides.endedAt ?? null,
    p_notes: overrides.notes ?? null,
  });
  if (error) return { error: error.message };
  return {};
}

export async function submitManualTimeEntry(
  taskId: string,
  startedAt: string,
  endedAt: string,
  notes: string
): Promise<{ id?: string; error?: string }> {
  const { data, error } = await supabase.rpc("submit_manual_time_entry", {
    p_task_id: taskId,
    p_started_at: startedAt,
    p_ended_at: endedAt,
    p_notes: notes,
  });
  if (error) return { error: error.message };
  return { id: data as unknown as string };
}

export async function decideTimeEntry(entryId: string, status: "approved" | "rejected", notes: string | null): Promise<{ error?: string }> {
  const { error } = await supabase.rpc("decide_time_entry", { p_entry_id: entryId, p_status: status, p_decision_notes: notes });
  if (error) return { error: error.message };
  return {};
}

export async function correctTimeEntry(entryId: string, durationMinutes: number, notes: string): Promise<{ error?: string }> {
  const { error } = await supabase.rpc("correct_time_entry", { p_entry_id: entryId, p_duration_minutes: durationMinutes, p_notes: notes });
  if (error) return { error: error.message };
  return {};
}
