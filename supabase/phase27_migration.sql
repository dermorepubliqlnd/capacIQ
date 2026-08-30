-- ---------------------------------------------------------------------
-- Phase 27 migration (2026-08-31): completes Phase 26's Fix 2.
--
-- Phase 26 established that WBS Planning's Save is the AUTHORITATIVE
-- scheduling surface: it may move a started project's dates, because the
-- plan itself is what is changing and every change is captured in the
-- Audit Trail. It routed saveDraft's own schedule write through
-- wbs_save_task_schedule, which sets app.bypass_due_date_lock for exactly
-- `start_date` and `current_due_date`.
--
-- It missed a sibling column. saveDraft's write is not the only date
-- write in a Save: the dependency auto-pilot effect (and the parent
-- rollup / add-dependency / remove-dependency helpers) stage
-- `start_date_standard` -- Forecasted's own persisted Start floor --
-- via saveTaskField, and flushPendingEdits() writes those staged patches
-- with a plain `tasks` UPDATE at the very TOP of saveDraft, before
-- wbs_save_task_schedule is ever reached.
--
-- `start_date_standard` is guarded by enforce_start_date_lock, which
-- raises whenever it changes while projects.timelines_locked is true.
-- That trigger was dormant for the same reason enforce_due_date_lock was:
-- record_wbs_edit used to clear timelines_locked. Phase 26 correctly made
-- the flag permanent and correctly re-pointed this trigger's error text,
-- but never gave the WBS Save path a way through it.
--
-- Live symptom (reproduced 2026-08-31 on a scratch project, 3 tasks
-- chained T1 -> T2 -> T3): Start Project, raise T1's Estimated hours so
-- T2/T3 must shift, Save ->
--   "Couldn't save: this task's Start date is part of the project's
--    baseline and can no longer be changed now that the project has
--    been started"
-- and the Save aborts. Any started project with a dependency chain
-- cannot be re-planned at all. Phase 26's own fix is unreachable because
-- this fires first.
--
-- Fix: the same sanctioned, narrowly-scoped bypass Phase 26 introduced,
-- for the one remaining locked column. wbs_save_task_start writes ONLY
-- start_date_standard, is restricted to can_manage_wbs (Full Access or
-- the project owner -- assignees, and therefore the Projects & Tasks
-- page, gain nothing), and refuses closed projects and Done tasks.
--
-- Deliberately NOT done here: dropping enforce_start_date_lock. It is
-- now the last line of defence for every OTHER surface, and the Projects
-- & Tasks page has no Start-date editor to lose. See the note in the
-- hand-off about whether it should survive at all, given the task-level
-- "Start Date change request" flow it was written for was removed on
-- 2026-08-27.
-- ---------------------------------------------------------------------

create or replace function wbs_save_task_start(p_task_id uuid, p_start_standard date)
returns void
language plpgsql security definer as $$
declare
  v_project_id uuid;
  v_task_status text;
  v_wbs_status text;
begin
  select project_id, status into v_project_id, v_task_status from tasks where id = p_task_id;
  if v_project_id is null then
    raise exception 'task not found';
  end if;
  if not can_manage_wbs(v_project_id) then
    raise exception 'not authorized to change this project''s schedule';
  end if;

  select wbs_status into v_wbs_status from projects where id = v_project_id;
  if v_wbs_status = 'closed' then
    raise exception 'this project is closed -- its plan is final and can no longer be changed';
  end if;
  if v_task_status = 'Done' then
    raise exception 'this task is Done -- its dates are historical and can no longer be moved';
  end if;

  perform set_config('app.bypass_start_date_lock', 'on', true);
  update tasks set start_date_standard = p_start_standard where id = p_task_id;
end;
$$;

grant execute on function wbs_save_task_start(uuid, date) to authenticated;
