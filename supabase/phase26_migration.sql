-- ---------------------------------------------------------------------
-- Phase 26 migration (2026-08-28): P0 governance regressions introduced
-- by 91ccc4f ("rename Lock Baseline -> Start Project, remove Re-baseline
-- flow"), plus two long-standing closure bugs found in the same audit.
--
-- Background: before 91ccc4f, `projects.timelines_locked` meant "the
-- plan is frozen right now". A Baseline-Locked project could be reopened
-- into a temporary revision window (timelines_locked = false), edited,
-- and then re-baselined (timelines_locked = true again). Removing
-- re-baselining removed every path that ever set the flag back to true:
-- lock_wbs_baseline and discard_wbs_revision are gone from the database
-- entirely, decide_baseline_request only takes its first-lock branch now
-- (canRequestBaseline is draft-only), and set_project_timelines_locked
-- has no callers left in the client. record_wbs_edit(uuid) kept setting
-- it FALSE, so the flag became a one-way flip.
--
-- Three governance triggers key off that flag (phase22_migration.sql):
-- task status changes, time logging, and extension requests all require
-- timelines_locked. So the first WBS edit after Start Project silently
-- and permanently disabled all three -- with error text pointing at a
-- "Request Baseline Approval" button that no longer exists.
--
-- Fix: under the current model there is no revision window any more --
-- editing the plan after Start Project is explicitly allowed and
-- permanent. So `timelines_locked` now simply tracks "has this project
-- been started": true for baseline_locked / changed_after_baseline /
-- closed, false only for draft. record_wbs_edit stops clearing it.
-- ---------------------------------------------------------------------

-- 1. record_wbs_edit(uuid): stop clearing timelines_locked -------------
-- Identical to phase15_migration.sql's version except for the final
-- UPDATE, which no longer touches timelines_locked. (The 2-arg overload
-- from phase25_migration.sql calls this one and is unchanged.)

create or replace function record_wbs_edit(p_project_id uuid)
returns void
language plpgsql security definer as $$
declare
  v_status text;
  v_source_version_id uuid;
  v_revision_number integer;
begin
  if not can_see_project(p_project_id) then
    raise exception 'not authorized';
  end if;

  select wbs_status into v_status from projects where id = p_project_id;
  if v_status is null then
    raise exception 'project not found';
  end if;

  -- Already open (changed_after_baseline with an in-progress revision,
  -- or draft/closed where this concept doesn't apply) -- nothing to do.
  if v_status <> 'baseline_locked' then
    return;
  end if;

  if exists (select 1 from project_revisions where project_id = p_project_id and status = 'in_progress') then
    update projects set wbs_status = 'changed_after_baseline' where id = p_project_id;
    return;
  end if;

  select id into v_source_version_id from project_plan_versions
    where project_id = p_project_id order by version_number desc limit 1;
  select coalesce(max(revision_number), 0) + 1 into v_revision_number from project_revisions where project_id = p_project_id;

  insert into project_revisions (project_id, revision_number, reason, status, source_plan_version_id, started_by)
  values (p_project_id, v_revision_number, 'Auto-opened on first edit after Baseline (Phase 6)', 'in_progress', v_source_version_id, my_person_id());

  -- Phase 26: timelines_locked deliberately NOT touched here. It means
  -- "this project has been started", and an edit after Start Project
  -- does not un-start it.
  update projects set wbs_status = 'changed_after_baseline' where id = p_project_id;
end;
$$;

grant execute on function record_wbs_edit(uuid) to authenticated;

-- 2. Backfill any project already bricked by the one-way flip ----------
-- (Bypasses projects_date_lock only in the sense that it doesn't touch
-- start_date/end_date, so no bypass GUC is needed.)

update projects
set timelines_locked = true
where wbs_status in ('baseline_locked', 'changed_after_baseline', 'closed')
  and coalesce(timelines_locked, false) = false;

-- 3. WBS Save is the authoritative scheduling surface ------------------
-- saveDraft (WbsPlanning.tsx) writes each task's recomputed start_date /
-- current_due_date. On a started project that write hits
-- enforce_due_date_lock ("current_due_date can only be changed via an
-- approved extension request") -- which exists to force AD-HOC due-date
-- edits (Projects & Tasks page) through the Extension Request flow, not
-- to block the WBS plan itself from being re-planned. Before Phase 26
-- that trigger happened to be dormant after the first edit, because
-- record_wbs_edit had already cleared timelines_locked; with the flag
-- now staying true, every schedule-shifting Save would fail.
--
-- This RPC is the one sanctioned bypass: it only ever writes the two
-- schedule columns, it is restricted to the people who drive WBS
-- planning (can_manage_wbs = Full Access or the project owner -- NOT
-- assignees, so the Projects & Tasks page gains no new hole), it
-- refuses closed projects and Done tasks, and every change it makes is
-- captured in the Audit Trail by record_wbs_edit(uuid, jsonb) in the
-- same Save.

create or replace function wbs_save_task_schedule(p_task_id uuid, p_start date, p_due date)
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

  perform set_config('app.bypass_due_date_lock', 'on', true);
  update tasks set start_date = p_start, current_due_date = p_due where id = p_task_id;
end;
$$;

grant execute on function wbs_save_task_schedule(uuid, date, date) to authenticated;

-- 4. Closure is final: block task writes on a closed project -----------
-- WbsPlanning.tsx's canEditWbs (wbs_status !== 'closed') was the ONLY
-- enforcement of closure anywhere; no trigger referenced
-- wbs_status = 'closed'. Everything the Projects & Tasks page still
-- allows on a task (Status, Actual Completion Date, validation/reopen,
-- deletion) stayed open on a closed project. Same trigger convention as
-- enforce_done_task_lock / enforce_due_date_lock: the trigger is the
-- source of truth, the UI gate is a courtesy.
--
-- Archive/restore of the parent project is deliberately still allowed
-- (is_archived / archived_at) -- archiving a closed project is
-- housekeeping, not a change to its record. DELETE is deliberately NOT
-- covered by this trigger: the 30-day archive purge
-- (purgeExpiredArchives -> delete_tasks_and_dependents ->
-- delete_project_and_dependents) has to be able to remove a closed
-- project's rows eventually. Deleting a LIVE (non-archived) closed
-- project's tasks is blocked inside delete_tasks_and_dependents instead,
-- see 4b below.

create or replace function enforce_closed_project_lock() returns trigger
language plpgsql as $$
declare
  v_status text;
begin
  if coalesce(current_setting('app.bypass_closed_project_lock', true), '') = 'on' then
    return NEW;
  end if;

  select wbs_status into v_status from projects where id = NEW.project_id;
  if v_status is distinct from 'closed' then
    return NEW;
  end if;

  if TG_OP = 'UPDATE'
     and (to_jsonb(NEW) - 'is_archived' - 'archived_at')
         is not distinct from (to_jsonb(OLD) - 'is_archived' - 'archived_at') then
    return NEW;
  end if;

  raise exception 'this project is closed -- its tasks are final and can no longer be added or changed';
end;
$$;

drop trigger if exists tasks_closed_project_lock on tasks;
create trigger tasks_closed_project_lock
  before insert or update on tasks
  for each row execute function enforce_closed_project_lock();

-- 4b. Same rule for hard deletes, minus the archive-purge path ---------
-- Re-creates policies.sql's delete_tasks_and_dependents with one added
-- guard. Archived tasks are exempt so the 30-day purge (and permanent
-- deletion of an archived project) still works.

create or replace function delete_tasks_and_dependents(p_task_ids uuid[]) returns void
language plpgsql security definer as $$
declare
  tid uuid;
begin
  if exists (
    select 1 from tasks t
    left join projects pr on pr.id = t.project_id
    where t.id = any(p_task_ids)
      and not (
        my_access_level() = 'full'
        or pr.owner_id = my_person_id()
      )
  ) then
    raise exception 'not authorized to delete one or more of these tasks';
  end if;

  if exists (
    select 1 from tasks t
    join projects pr on pr.id = t.project_id
    where t.id = any(p_task_ids)
      and pr.wbs_status = 'closed'
      and not coalesce(t.is_archived, false)
  ) then
    raise exception 'this project is closed -- its tasks are final and can no longer be deleted';
  end if;

  foreach tid in array p_task_ids loop
    perform archive_task_utilization(tid);
  end loop;

  delete from extension_requests where task_id = any(p_task_ids);
  delete from task_effort_changes where task_id = any(p_task_ids);
  delete from time_entries where task_id = any(p_task_ids);
  delete from task_collaborators where task_id = any(p_task_ids);
  delete from task_planning_snapshots where task_id = any(p_task_ids);
  delete from task_dependencies where task_id = any(p_task_ids) or depends_on_task_id = any(p_task_ids);
  delete from tasks where id = any(p_task_ids);
end;
$$;

grant execute on function delete_tasks_and_dependents(uuid[]) to authenticated;

-- 5. Phase 22 gates: "started" now also means "not closed", and the -----
--    error text no longer names buttons that were removed.
-- (Bodies are otherwise byte-for-byte the phase22 versions.)

create or replace function enforce_status_baseline_lock() returns trigger
language plpgsql as $$
declare
  v_locked boolean;
  v_wbs_status text;
begin
  if TG_OP = 'UPDATE' and NEW.status is distinct from OLD.status then
    if coalesce(current_setting('app.bypass_status_baseline_lock', true), '') <> 'on' then
      select timelines_locked, wbs_status into v_locked, v_wbs_status from projects where id = NEW.project_id;
      if v_wbs_status = 'closed' then
        raise exception 'this project is closed -- task statuses are final and can no longer be changed';
      end if;
      if not coalesce(v_locked, false) then
        raise exception 'task status can only be changed once this project has been started (WBS Planning -> Start Project)';
      end if;
    end if;
  end if;
  return NEW;
end;
$$;

create or replace function enforce_time_entry_baseline_lock() returns trigger
language plpgsql as $$
declare
  v_locked boolean;
  v_wbs_status text;
begin
  if TG_OP = 'INSERT' then
    select pr.timelines_locked, pr.wbs_status into v_locked, v_wbs_status
      from tasks t join projects pr on pr.id = t.project_id
      where t.id = NEW.task_id;
    if v_wbs_status = 'closed' then
      raise exception 'this project is closed -- no more hours can be logged against its tasks';
    end if;
    if not coalesce(v_locked, false) then
      raise exception 'hours can only be logged/tracked once this project has been started (WBS Planning -> Start Project)';
    end if;
  end if;
  return NEW;
end;
$$;

create or replace function enforce_extension_request_baseline_lock() returns trigger
language plpgsql as $$
declare
  v_locked boolean;
  v_wbs_status text;
  v_project_id uuid;
begin
  if TG_OP = 'INSERT' then
    v_project_id := NEW.project_id;
    if v_project_id is null and NEW.task_id is not null then
      select project_id into v_project_id from tasks where id = NEW.task_id;
    end if;
    select timelines_locked, wbs_status into v_locked, v_wbs_status from projects where id = v_project_id;
    if v_wbs_status = 'closed' then
      raise exception 'this project is closed -- extensions can no longer be requested for it';
    end if;
    if not coalesce(v_locked, false) then
      raise exception 'an extension can only be requested once this project has been started (WBS Planning -> Start Project)';
    end if;
  end if;
  return NEW;
end;
$$;

-- 6. enforce_start_date_lock: message only ------------------------------
-- This trigger has only ever existed live (applied straight through the
-- SQL editor on 2026-08-26, never committed as a migration) -- recorded
-- here for the first time, unchanged apart from its error text: the
-- "Start Date change request" flow it pointed at was removed on
-- 2026-08-27 along with re-baselining.

create or replace function enforce_start_date_lock() returns trigger
language plpgsql as $$
declare
  v_locked boolean;
begin
  if TG_OP = 'UPDATE' and NEW.start_date_standard is distinct from OLD.start_date_standard then
    if coalesce(current_setting('app.bypass_start_date_lock', true), '') <> 'on' then
      select timelines_locked into v_locked from projects where id = NEW.project_id;
      if coalesce(v_locked, false) then
        raise exception 'this task''s Start date is part of the project''s baseline and can no longer be changed now that the project has been started';
      end if;
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists tasks_start_date_lock on tasks;
create trigger tasks_start_date_lock
  before update on tasks
  for each row execute function enforce_start_date_lock();

-- 7. decide_wbs_closure: right scheduling mode + close the revision -----
-- (a) Mode bug: the rollup compared `v_mode = 'standard'`. phase16
--     corrected the equivalent comparison in decide_baseline_request to
--     `<> 'full_capacity'` (Forecasted lives in the *_standard columns,
--     and 'manual' is Forecasted's mode value -- activeMode is hard-coded
--     'manual') but never touched closure. Result: every closeout
--     captured THEORETICAL dates while its baseline captured FORECASTED
--     ones, so BaselineReport's endDaysDelta reported a fabricated
--     schedule variance on every closed project.
-- (b) decide_wbs_closure never closed the open project_revisions row, so
--     a closed project kept showing "Revision N -- in_progress" in the
--     Audit Trail forever. Closure freezes the plan, so the revision's
--     changes are now permanent: mark it 'applied'.
-- Everything else is unchanged from phase2_migration.sql.

create or replace function decide_wbs_closure(p_request_id uuid, p_approve boolean, p_reason text, p_tasks jsonb)
returns uuid
language plpgsql security definer as $$
declare
  v_project_id uuid;
  v_status text;
  v_mode text;
  v_task_count integer;
  v_total_hours numeric;
  v_start date;
  v_end date;
  v_closeout_id uuid;
begin
  select project_id, status into v_project_id, v_status from project_closure_requests where id = p_request_id;
  if v_project_id is null then
    raise exception 'closure request not found';
  end if;
  if not can_decide_closure(p_request_id) then
    raise exception 'not authorized to decide this closure request';
  end if;
  if v_status <> 'pending' then
    raise exception 'closure request is not pending (current status: %)', v_status;
  end if;

  if not p_approve then
    update project_closure_requests set status = 'rejected', decided_by = my_person_id(), decided_at = now(), decision_reason = p_reason
      where id = p_request_id;
    return p_request_id;
  end if;

  select mode into v_mode from project_plan_versions where project_id = v_project_id order by version_number desc limit 1;
  v_mode := coalesce(v_mode, 'full_capacity');

  select count(*) into v_task_count from jsonb_array_elements(p_tasks);
  select
    coalesce(sum((t->>'estimated_hours')::numeric) filter (where t->>'parent_task_id' is null), 0),
    min(case when v_mode <> 'full_capacity' then (t->>'start_date_standard')::date else (t->>'start_date_full')::date end),
    max(case when v_mode <> 'full_capacity' then (t->>'end_date_standard')::date else (t->>'end_date_full')::date end)
  into v_total_hours, v_start, v_end
  from jsonb_array_elements(p_tasks) t;

  insert into project_closeouts (project_id, closed_by, mode, total_est_hours, task_count, start_date, end_date)
  values (v_project_id, my_person_id(), v_mode, v_total_hours, v_task_count, v_start, v_end)
  on conflict (project_id) do update set
    closed_at = now(), closed_by = excluded.closed_by, mode = excluded.mode,
    total_est_hours = excluded.total_est_hours, task_count = excluded.task_count,
    start_date = excluded.start_date, end_date = excluded.end_date
  returning id into v_closeout_id;

  delete from project_closeout_tasks where closeout_id = v_closeout_id;
  insert into project_closeout_tasks (closeout_id, task_id, name, estimated_hours)
  select v_closeout_id, (t->>'task_id')::uuid, t->>'name', (t->>'estimated_hours')::numeric
  from jsonb_array_elements(p_tasks) t;

  update project_closure_requests set status = 'approved', decided_by = my_person_id(), decided_at = now(),
    decision_reason = p_reason, resulting_closeout_id = v_closeout_id
    where id = p_request_id;

  -- Phase 26: close out the revision that record_wbs_edit left open, so
  -- the Audit Trail stops showing "Revision N -- in_progress" on a
  -- project that is finished.
  update project_revisions
    set status = 'applied', applied_by = my_person_id(), applied_at = now()
    where project_id = v_project_id and status = 'in_progress';

  update projects set wbs_status = 'closed' where id = v_project_id;

  return v_closeout_id;
end;
$$;

grant execute on function decide_wbs_closure(uuid, boolean, text, jsonb) to authenticated;
