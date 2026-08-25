-- ---------------------------------------------------------------------
-- Phase 22 migration (2026-08-25): server-side enforcement of the
-- baseline-lock gate added client-side earlier today (status changes,
-- time logging/tracking, and extension requests all require the
-- project's baseline to be locked -- see Projects.tsx's isProjectLocked
-- gating on the Status column, timer button, and TimeTracking.tsx's
-- manual-log task picker). That round was UI-only; this migration makes
-- the same rule authoritative at the database layer, mirroring the
-- existing enforce_due_date_lock/enforce_done_task_lock/
-- tasks_validation_rpc_lock pattern (a trigger is the source of truth;
-- the UI gate is just a courtesy that avoids a round-trip error).
--
-- Also adds the "validation date can't be earlier than actual
-- completion date" rule Sandra asked for, inside validate_task_completion
-- itself (the sole approved path to set validated_completion_date, per
-- tasks_validation_rpc_lock).
-- ---------------------------------------------------------------------

-- 1. Task status changes require a locked baseline -----------------------

create or replace function enforce_status_baseline_lock() returns trigger
language plpgsql as $$
declare
  v_locked boolean;
begin
  if TG_OP = 'UPDATE' and NEW.status is distinct from OLD.status then
    if coalesce(current_setting('app.bypass_status_baseline_lock', true), '') <> 'on' then
      select timelines_locked into v_locked from projects where id = NEW.project_id;
      if not coalesce(v_locked, false) then
        raise exception 'task status can only be changed once this project''s baseline is locked (WBS Planning -> Request Baseline Approval)';
      end if;
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists tasks_status_baseline_lock on tasks;
create trigger tasks_status_baseline_lock
  before update on tasks
  for each row execute function enforce_status_baseline_lock();

-- reopen_task legitimately flips status back to 'In Progress' as part of
-- clearing a validation -- by the time a task was validated its project
-- was already locked (status could only have reached 'Done' post-lock,
-- per the trigger above), so this bypass is a formality, not a real
-- loophole, but it keeps reopen_task from needing to care about lock
-- state at all.
create or replace function reopen_task(p_task_id uuid) returns void
language plpgsql security definer as $$
declare
  v_assignee_id uuid;
  v_authorized boolean;
begin
  select assignee_id into v_assignee_id from tasks where id = p_task_id;
  if not found then
    raise exception 'task not found';
  end if;

  select
    my_access_level() = 'full'
    or (v_assignee_id is not null and exists (select 1 from people where id = v_assignee_id and reports_to = my_person_id()))
    or (v_assignee_id is not null and nearest_active_manager(v_assignee_id) = my_person_id())
  into v_authorized;

  if not coalesce(v_authorized, false) then
    raise exception 'not authorized to reopen this task';
  end if;

  perform set_config('app.bypass_validation_rpc', 'on', true);
  perform set_config('app.bypass_status_baseline_lock', 'on', true);
  update tasks set
    validated_completion_date = null,
    validated_by = null,
    status = 'In Progress',
    submitted_on = null,
    submitted_by = null
  where id = p_task_id;
end;
$$;

grant execute on function reopen_task(uuid) to authenticated;

-- 2. Time logging/tracking requires a locked baseline ---------------------
-- A direct trigger on time_entries (not just a check inside start_timer/
-- submit_manual_time_entry) so this holds even against the existing
-- permissive time_entries_insert RLS policy (person_id = my_person_id()),
-- not only the two RPCs the current UI happens to call through.

create or replace function enforce_time_entry_baseline_lock() returns trigger
language plpgsql as $$
declare
  v_locked boolean;
begin
  if TG_OP = 'INSERT' then
    select pr.timelines_locked into v_locked
      from tasks t join projects pr on pr.id = t.project_id
      where t.id = NEW.task_id;
    if not coalesce(v_locked, false) then
      raise exception 'hours can only be logged/tracked once this project''s baseline is locked (WBS Planning -> Request Baseline Approval)';
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists time_entries_baseline_lock on time_entries;
create trigger time_entries_baseline_lock
  before insert on time_entries
  for each row execute function enforce_time_entry_baseline_lock();

-- 3. Extension requests require a locked baseline -------------------------
-- Covers both the task-level and project-level extension_requests rows
-- (task_id XOR project_id, see the extension_requests_task_xor_project
-- constraint) -- resolves whichever one is set to find the project, then
-- checks timelines_locked the same way.

create or replace function enforce_extension_request_baseline_lock() returns trigger
language plpgsql as $$
declare
  v_locked boolean;
  v_project_id uuid;
begin
  if TG_OP = 'INSERT' then
    v_project_id := NEW.project_id;
    if v_project_id is null and NEW.task_id is not null then
      select project_id into v_project_id from tasks where id = NEW.task_id;
    end if;
    select timelines_locked into v_locked from projects where id = v_project_id;
    if not coalesce(v_locked, false) then
      raise exception 'an extension can only be requested once this project''s baseline is locked (WBS Planning -> Request Baseline Approval)';
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists extension_requests_baseline_lock on extension_requests;
create trigger extension_requests_baseline_lock
  before insert on extension_requests
  for each row execute function enforce_extension_request_baseline_lock();

-- 4. Validation date can't be earlier than actual completion date --------
-- Sandra, 2026-08-25: "Validation date can not be earlier than the
-- actual completion date." Enforced inside validate_task_completion
-- itself (the sole approved path to set validated_completion_date, per
-- tasks_validation_rpc_lock) rather than a separate trigger, since this
-- function already owns all of validated_completion_date's write rules.

create or replace function validate_task_completion(p_task_id uuid, p_validated_date timestamptz default null) returns void
language plpgsql security definer as $$
declare
  v_assignee_id uuid;
  v_project_id uuid;
  v_status text;
  v_authorized boolean;
  v_actual_completion date;
  v_submitted_on timestamptz;
  v_completion_ref date;
  v_new_date date;
begin
  select assignee_id, project_id, status, actual_completion_date, submitted_on
    into v_assignee_id, v_project_id, v_status, v_actual_completion, v_submitted_on
    from tasks where id = p_task_id;
  if v_project_id is null then
    raise exception 'task not found';
  end if;
  if v_status <> 'Done' then
    raise exception 'only a Done task can be validated';
  end if;

  select
    my_access_level() = 'full'
    or exists (select 1 from projects where id = v_project_id and owner_id = my_person_id())
    or (v_assignee_id is not null and exists (select 1 from people where id = v_assignee_id and reports_to = my_person_id()))
    or (v_assignee_id is not null and nearest_active_manager(v_assignee_id) = my_person_id())
  into v_authorized;

  if not coalesce(v_authorized, false) then
    raise exception 'not authorized to validate this task';
  end if;

  v_new_date := coalesce(p_validated_date, now())::date;
  v_completion_ref := coalesce(v_actual_completion, v_submitted_on::date);
  if v_completion_ref is not null and v_new_date < v_completion_ref then
    raise exception 'validation date (%) can''t be earlier than the actual completion date (%)', v_new_date, v_completion_ref;
  end if;

  perform set_config('app.bypass_validation_rpc', 'on', true);
  update tasks set validated_completion_date = coalesce(p_validated_date, now()), validated_by = my_person_id() where id = p_task_id;
end;
$$;

grant execute on function validate_task_completion(uuid, timestamptz) to authenticated;
