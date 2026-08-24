-- ---------------------------------------------------------------------
-- Phase 18 migration (2026-08-24): disable re-baselining entirely.
--
-- Sandra's ask: baseline approval is a ONE-TIME gate. Once a project's
-- baseline has ever been locked, there is no "request approval to
-- re-lock" path anymore -- editing after Baseline Locked / Changed
-- After Baseline is still allowed (for the project owner's own working
-- notes) but that plan can never be promoted to a new official Baseline.
-- This reverses the Phase 6 (phase15_migration.sql) design choice to
-- treat first-lock and re-baseline as the same request type.
--
-- request_baseline_approval now only succeeds from wbs_status = 'draft'.
-- The re-baseline branch inside decide_baseline_request (baseline_locked
-- / changed_after_baseline) is left completely in place, unreachable via
-- normal use now that no request can ever be created in that state --
-- kept rather than dropped in case this policy is ever reversed again,
-- same "leave old logic alone" convention as phase15's own comment.
-- ---------------------------------------------------------------------

create or replace function request_baseline_approval(p_project_id uuid, p_reason text)
returns uuid
language plpgsql security definer as $$
declare
  v_status text;
  v_request_id uuid;
begin
  if not can_manage_wbs(p_project_id) then
    raise exception 'not authorized to request a baseline for this project';
  end if;

  select wbs_status into v_status from projects where id = p_project_id;
  if v_status is null then
    raise exception 'project not found';
  end if;
  if v_status = 'closed' then
    raise exception 'project is closed';
  end if;
  if v_status = 'revision_in_progress' then
    raise exception 'this project has a legacy revision in progress -- apply or discard it before requesting a baseline';
  end if;
  if v_status <> 'draft' then
    raise exception 'this project already has a locked baseline -- re-baselining is disabled';
  end if;
  if exists (select 1 from project_baseline_requests where project_id = p_project_id and status = 'pending') then
    raise exception 'a baseline request is already pending for this project';
  end if;

  insert into project_baseline_requests (project_id, requested_by, reason, status)
  values (p_project_id, my_person_id(), p_reason, 'pending')
  returning id into v_request_id;

  return v_request_id;
end;
$$;

grant execute on function request_baseline_approval(uuid, text) to authenticated;
