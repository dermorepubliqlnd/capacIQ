-- ---------------------------------------------------------------------
-- Phase 24 migration (2026-08-26): revive re-baselining, permanently
-- gated behind can_approve_rebaseline (Sandra: "bring it back, gated --
-- this one needs to go through to me or someone who has re-baseline
-- approval access only").
--
-- Reverses phase18_migration.sql's restriction. Everything phase18 left
-- in place unreachable is reachable again as-is: decide_baseline_request's
-- re-baseline branch (baseline_locked/changed_after_baseline case) was
-- never touched by phase18 and already does exactly the right thing --
-- diffs the open revision into project_revision_changes (fixing the
-- Audit Trail / Revision Summary gap found investigating that item, see
-- project_capaciq_phase2_2026_08_26_second_batch memory) and promotes a
-- new project_baselines row. can_decide_baseline_request (strictly
-- can_approve_rebaseline, no Full Access/owner override -- Sandra's
-- explicit choice from Phase 6) and the User Management checkbox
-- (can_approve_rebaseline, wired in Admin.tsx/UserDrawer.tsx) were never
-- removed either -- confirmed Sandra's own account already has
-- can_approve_rebaseline=true from the original Phase 6 grant, and no
-- one else does, matching "just me initially, I'll authorize others
-- later."
--
-- Net effect on the state machine (projects.wbs_status):
--   draft -> baseline_locked <-> changed_after_baseline -> closed
-- (re-baseline approval from baseline_locked or changed_after_baseline
-- returns the project to baseline_locked, same as Phase 6 originally
-- designed -- it just couldn't be reached for two days.)
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
