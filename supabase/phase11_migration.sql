-- ---------------------------------------------------------------------
-- Phase 11 migration (2026-08-20): fix a real three-valued-logic
-- authorization bug found while testing phase10's fallback logic.
--
-- Bug: `can_decide_extension`/`can_decide_closure`/`can_decide_time_entry`
-- (and the inline `v_can` checks in `request_and_approve_extension`) all
-- had the shape `select my_access_level() = 'full' or exists(...) or
-- exists(...)`, with no coalesce. If `my_access_level()` returns SQL NULL
-- (which happens for any caller whose people row can't be resolved as
-- active right now -- most concretely, a person who gets deactivated
-- while their session token is still valid, but not yet expired), then
-- `NULL = 'full'` is NULL, not false, and `NULL or false or false` is
-- itself NULL, not false. The calling code everywhere is
-- `if not can_decide_extension(...) then raise exception ... end if` --
-- and `not NULL` is NULL, and `if NULL then` in PL/pgSQL takes the
-- ELSE/no-op path, not the THEN path. Net effect: the authorization
-- check silently passes (no exception raised) instead of failing closed,
-- for exactly the deactivated-but-still-logged-in scenario this session
-- already hardened self-demotion/self-deactivation against elsewhere.
--
-- Caught live by phase10's own test suite (`__test_phase10`), which
-- simulates an inactive account attempting to decide an extension
-- request -- test case C ("inactive M1 was able to approve") failed
-- until this fix. `can_manage_wbs` already had the correct
-- `coalesce(..., false) or exists(...)` shape (whoever wrote it already
-- knew about this pattern) -- the other three governance-check functions
-- didn't, so this backports the same shape to all of them plus the two
-- inline `v_can` sites, RE-VERIFIED against the actual live test suite
-- afterward.
-- ---------------------------------------------------------------------

create or replace function can_decide_extension(p_request_id uuid) returns boolean
language sql stable security definer as $$
  select coalesce(
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
    ),
    false
  )
$$;

grant execute on function can_decide_extension(uuid) to authenticated;

create or replace function can_decide_closure(p_request_id uuid) returns boolean
language sql stable security definer as $$
  select coalesce(
    my_access_level() = 'full'
    or exists (select 1 from people me where me.id = my_person_id() and me.can_approve_closures)
    or exists (
      select 1 from project_closure_requests r join projects pr on pr.id = r.project_id
      where r.id = p_request_id and pr.owner_id = my_person_id()
    ),
    false
  )
$$;

grant execute on function can_decide_closure(uuid) to authenticated;

create or replace function can_decide_time_entry(p_entry_id uuid) returns boolean
language sql stable security definer as $$
  select coalesce(
    my_access_level() = 'full'
    or exists (
      select 1
      from time_entries te
      join tasks t on t.id = te.task_id
      join projects pr on pr.id = t.project_id
      left join people owner on owner.id = pr.owner_id
      where te.id = p_entry_id
        and (
          (pr.owner_id = my_person_id() and te.requested_by <> pr.owner_id)
          or (te.requested_by = pr.owner_id and owner.reports_to = my_person_id())
        )
    ),
    false
  )
$$;

grant execute on function can_decide_time_entry(uuid) to authenticated;

-- request_and_approve_extension's inline v_can check had the same
-- unguarded shape -- wrap with coalesce too (cascade call carried over
-- from phase10_migration.sql, unchanged otherwise).
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
  select coalesce(
    my_access_level() = 'full'
    or exists (
      select 1 from tasks t join projects pr on pr.id = t.project_id
      where t.id = p_task_id and pr.owner_id = my_person_id()
    ),
    false
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
