-- Phase 17 / QA cleanup (2026-08-21): fixes found during a full QA sweep
-- after Phase 12+13.
--
-- 1. reopen_task authorization was flat Full-Access-only, with a
--    separate "Approve Reopening" flag (people.can_approve_reopening)
--    sitting in User Management that never actually gated anything --
--    neither the Reopen button (client-side, Projects.tsx) nor this RPC
--    ever checked it. Sandra's fix: "re-opening task will only be done
--    by the immediate manager with skip level option as fallback" --
--    mirrors the manager-chain check validate_task_completion already
--    uses (nearest_active_manager()), minus the project-owner branch
--    (deliberately narrower for reopening).
-- 2. can_approve_reopening column dropped -- fully decorative, removed
--    from all client code in this same change.
-- 3. Five RPCs from the pre-Phase-6 manual revision/baseline workflow
--    were superseded by decide_baseline_request (Phase 6) but never
--    dropped: apply_wbs_revision, discard_wbs_revision,
--    lock_wbs_baseline, start_wbs_revision, rebaseline_wbs_plan. Zero
--    client call sites reference any of them. Dropped as pure cleanup.

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

alter table people drop column if exists can_approve_reopening;

drop function if exists apply_wbs_revision(uuid, jsonb);
drop function if exists discard_wbs_revision(uuid);
drop function if exists lock_wbs_baseline(uuid, text, text, jsonb);
drop function if exists start_wbs_revision(uuid, text);
drop function if exists rebaseline_wbs_plan(uuid, text);
