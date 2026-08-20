-- ---------------------------------------------------------------------
-- Phase 10 migration (2026-08-20): manager-chain fallback for extension
-- approval, broadened + hardened task validation authority, a new
-- assignee-self-reported actual_completion_date, and dependent-task
-- Start-date cascading on approved due-date extensions.
--
-- Follow-on to Sandra's questions the same day (2026-08-20), each
-- answered via AskUserQuestion:
--
-- 1. Extension-request approval: was immediate-manager-only, with no
--    fallback if that manager's account is inactive. Sandra: "skip-level
--    only as fallback." New nearest_active_manager() helper walks up the
--    reports_to chain, skipping inactive accounts, and is now used
--    everywhere an "escalates to the owner's manager" decision was
--    previously a flat reports_to match.
--
-- 2. Task validation authority: was project owner or Full Access only --
--    no manager-chain concept existed at all. Sandra: "project owner,
--    also allow immediate manager and skip level as fallback" (of the
--    ASSIGNEE's chain, not the owner's -- validation is about confirming
--    the assignee's own work). Since a manager who isn't the project
--    owner has no row-level UPDATE access to the task at all today, this
--    needed a real SECURITY DEFINER RPC (validate_task_completion), not
--    just a broadened client-side check -- and since the assignee
--    currently has unrestricted tasks_update access and could already
--    self-validate via a direct write with nothing stopping them, a new
--    trigger now forces ALL validated_completion_date/validated_by
--    writes through validate_task_completion/reopen_task specifically.
--
-- 3. New tasks.actual_completion_date (plain date, assignee self-
--    reported) -- Sandra: "self-reported + locks once validated." Slotted
--    into the Days +/- / Timing fallback chain ahead of submitted_on
--    (validated_completion_date still wins if present), and added to the
--    same "frozen once validated" field-lock set as
--    assignee/status/effort/estimated_hours/start_date.
--
-- 4. decide_extension_request/request_and_approve_extension now call a
--    new cascade_dependent_starts() after an approval, which pushes a
--    DIRECT dependent task's Start (start_date, plus start_date_full/
--    start_date_standard for whichever mode(s) are still on auto-pilot)
--    to the next working day after the extended task's new due date, if
--    it would otherwise start on or before that new due date. Deliberately
--    NOT recursive (direct dependents only, not their own dependents in
--    turn) and deliberately does NOT touch a dependent's own
--    current_due_date (that stays governed by its own, separate
--    extension-request process) -- pushing a dependent's Start later
--    while its due date stays fixed will surface as a real, visible
--    schedule conflict in WBS Planning, which is the honest signal that
--    someone now needs to request a further extension for THAT task too,
--    rather than silently cascading an unapproved change to it. Skips
--    Done tasks (their dates are historical/frozen) and, like
--    archive_task_utilization elsewhere in this codebase, deliberately
--    does not consult a holidays table (weekends only) -- same
--    documented "acceptable simplification for a backstop" precedent.
-- ---------------------------------------------------------------------

-- 1. Manager-chain fallback helper -------------------------------------

create or replace function nearest_active_manager(p_person_id uuid) returns uuid
language plpgsql stable security definer as $$
declare
  v_current uuid;
  v_is_active boolean;
  v_depth int := 0;
begin
  select reports_to into v_current from people where id = p_person_id;
  while v_current is not null and v_depth < 20 loop
    select is_active into v_is_active from people where id = v_current;
    if coalesce(v_is_active, false) then
      return v_current;
    end if;
    select reports_to into v_current from people where id = v_current;
    v_depth := v_depth + 1;
  end loop;
  return null;
end;
$$;

grant execute on function nearest_active_manager(uuid) to authenticated;

-- can_decide_extension: replace flat `owner.reports_to = my_person_id()`
-- escalation checks with the fallback-aware helper, for both the
-- task-level self-request case and the project-level case.
create or replace function can_decide_extension(p_request_id uuid) returns boolean
language sql stable security definer as $$
  select
    my_access_level() = 'full'
    or exists (
      select 1
      from extension_requests er
      join tasks t on t.id = er.task_id
      join projects pr on pr.id = t.project_id
      where er.id = p_request_id
        and er.task_id is not null
        and (
          (pr.owner_id = my_person_id() and er.requested_by <> pr.owner_id)
          or (er.requested_by = pr.owner_id and nearest_active_manager(pr.owner_id) = my_person_id())
        )
    )
    or exists (
      select 1
      from extension_requests er
      join projects pr on pr.id = er.project_id
      where er.id = p_request_id
        and er.project_id is not null
        and nearest_active_manager(pr.owner_id) = my_person_id()
    )
$$;

grant execute on function can_decide_extension(uuid) to authenticated;

-- 4. Dependent Start-date cascade on an approved extension --------------

create or replace function cascade_dependent_starts(p_task_id uuid) returns void
language plpgsql security definer as $$
declare
  v_new_due date;
  v_next_start date;
  dep record;
begin
  select current_due_date into v_new_due from tasks where id = p_task_id;
  if v_new_due is null then
    return;
  end if;

  v_next_start := v_new_due + 1;
  while extract(dow from v_next_start) in (0, 6) loop
    v_next_start := v_next_start + 1;
  end loop;

  for dep in
    select tk.id, tk.start_date, tk.start_date_full, tk.start_date_standard, tk.start_full_auto, tk.start_standard_auto, tk.status
    from task_dependencies td
    join tasks tk on tk.id = td.task_id
    where td.depends_on_task_id = p_task_id
      and coalesce(tk.is_archived, false) = false
  loop
    if dep.status = 'Done' then
      continue;
    end if;
    if dep.start_date is null or dep.start_date <= v_new_due then
      update tasks set start_date = v_next_start where id = dep.id;
    end if;
    if coalesce(dep.start_full_auto, false) and (dep.start_date_full is null or dep.start_date_full <= v_new_due) then
      update tasks set start_date_full = v_next_start where id = dep.id;
    end if;
    if coalesce(dep.start_standard_auto, false) and (dep.start_date_standard is null or dep.start_date_standard <= v_new_due) then
      update tasks set start_date_standard = v_next_start where id = dep.id;
    end if;
  end loop;
end;
$$;

create or replace function decide_extension_request(
  p_request_id uuid,
  p_status text,
  p_decision_notes text default null
) returns void
language plpgsql security definer as $$
declare
  v_task_id uuid;
  v_new_due_date date;
  v_current_status text;
begin
  if p_status not in ('Approved','Rejected') then
    raise exception 'invalid status: %', p_status;
  end if;

  if not can_decide_extension(p_request_id) then
    raise exception 'not authorized to decide this extension request';
  end if;

  select task_id, requested_new_due_date, status
    into v_task_id, v_new_due_date, v_current_status
    from extension_requests where id = p_request_id;

  if v_task_id is null then
    raise exception 'extension request not found';
  end if;
  if v_current_status <> 'Pending' then
    raise exception 'this request has already been decided';
  end if;

  update extension_requests
    set status = p_status,
        decided_by = my_person_id(),
        decided_at = now(),
        decision_notes = p_decision_notes
    where id = p_request_id;

  if p_status = 'Approved' then
    perform set_config('app.bypass_due_date_lock', 'on', true);
    update tasks set current_due_date = v_new_due_date where id = v_task_id;
    perform cascade_dependent_starts(v_task_id);
  end if;
end;
$$;

grant execute on function decide_extension_request(uuid, text, text) to authenticated;

create or replace function request_and_approve_extension(
  p_task_id uuid,
  p_new_due_date date,
  p_reason_category text,
  p_reason_notes text
) returns uuid
language plpgsql security definer as $$
declare
  v_request_id uuid;
  v_can boolean;
begin
  select
    my_access_level() = 'full'
    or exists (
      select 1 from tasks t join projects pr on pr.id = t.project_id
      where t.id = p_task_id and pr.owner_id = my_person_id()
    )
  into v_can;

  if not v_can then
    raise exception 'not authorized to directly set this task''s due date';
  end if;

  insert into extension_requests
    (task_id, requested_by, requested_new_due_date, reason_category, reason_notes, status, is_manager_initiated, decided_by, decided_at)
  values
    (p_task_id, my_person_id(), p_new_due_date, p_reason_category, p_reason_notes, 'Approved', true, my_person_id(), now())
  returning id into v_request_id;

  perform set_config('app.bypass_due_date_lock', 'on', true);
  update tasks set current_due_date = p_new_due_date where id = p_task_id;
  perform cascade_dependent_starts(p_task_id);

  return v_request_id;
end;
$$;

grant execute on function request_and_approve_extension(uuid, date, text, text) to authenticated;

-- 2 & 3. Validation authority + actual_completion_date -------------------

alter table tasks add column if not exists actual_completion_date date;

-- All validated_completion_date/validated_by writes now have to go
-- through validate_task_completion or reopen_task below -- previously
-- the assignee (who already has unrestricted tasks_update RLS access)
-- could self-validate with a direct write and nothing stopped them.
create or replace function enforce_validated_by_rpc() returns trigger
language plpgsql as $$
begin
  if TG_OP = 'UPDATE' and (
    NEW.validated_completion_date is distinct from OLD.validated_completion_date
    or NEW.validated_by is distinct from OLD.validated_by
  ) then
    if coalesce(current_setting('app.bypass_validation_rpc', true), '') <> 'on' then
      raise exception 'validated_completion_date can only be changed via validate_task_completion or reopen_task';
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists tasks_validation_rpc_lock on tasks;
create trigger tasks_validation_rpc_lock
  before update on tasks
  for each row execute function enforce_validated_by_rpc();

-- Mirrors Projects.tsx's own isTaskLocked concept (Assignee/Status/
-- Effort/Estimated Hours/Start freeze once validated -- current_due_date
-- deliberately excluded, it already has its own independent, correct
-- governance via enforce_due_date_lock) at the database layer too, now
-- also covering the new actual_completion_date. Naturally lets Reopen
-- through with no bypass needed -- it clears validated_completion_date
-- to null in the same statement, so NEW.validated_completion_date is not
-- null fails and the block doesn't apply.
create or replace function enforce_task_validation_field_lock() returns trigger
language plpgsql as $$
begin
  if TG_OP = 'UPDATE' and OLD.validated_completion_date is not null and NEW.validated_completion_date is not null then
    if NEW.actual_completion_date is distinct from OLD.actual_completion_date
       or NEW.assignee_id is distinct from OLD.assignee_id
       or NEW.status is distinct from OLD.status
       or NEW.effort is distinct from OLD.effort
       or NEW.estimated_hours is distinct from OLD.estimated_hours
       or NEW.start_date is distinct from OLD.start_date
    then
      raise exception 'this task has been validated -- its fields are locked. Reopen it first to make changes.';
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists tasks_validation_field_lock on tasks;
create trigger tasks_validation_field_lock
  before update on tasks
  for each row execute function enforce_task_validation_field_lock();

-- Validates (or corrects an already-validated) task's completion.
-- Authorized: Full Access, the project owner, the assignee's immediate
-- manager, or (fallback only) the nearest active manager further up the
-- assignee's chain if the immediate manager's account is inactive.
create or replace function validate_task_completion(p_task_id uuid, p_validated_date timestamptz default null) returns void
language plpgsql security definer as $$
declare
  v_assignee_id uuid;
  v_project_id uuid;
  v_status text;
  v_authorized boolean;
begin
  select assignee_id, project_id, status into v_assignee_id, v_project_id, v_status from tasks where id = p_task_id;
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

  perform set_config('app.bypass_validation_rpc', 'on', true);
  update tasks set validated_completion_date = coalesce(p_validated_date, now()), validated_by = my_person_id() where id = p_task_id;
end;
$$;

grant execute on function validate_task_completion(uuid, timestamptz) to authenticated;

-- Reopen stays Full-Access-only, unchanged from its original scope
-- (Sandra, 2026-07-22: "keep it for full access only") -- now a real RPC
-- instead of a plain client-side-gated update, so the new
-- tasks_validation_rpc_lock trigger above has exactly one other approved
-- path through it.
create or replace function reopen_task(p_task_id uuid) returns void
language plpgsql security definer as $$
begin
  if my_access_level() <> 'full' then
    raise exception 'not authorized to reopen this task';
  end if;

  perform set_config('app.bypass_validation_rpc', 'on', true);
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
