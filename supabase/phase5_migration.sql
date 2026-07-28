-- Migration 2026-07-28k: Phase 5 -- Re-baselining for the Draft/Baseline/
-- Revision/Final-Scope workflow. Builds on Phase 1/2 (phase1_migration.sql,
-- phase2_migration.sql).
--
-- Re-baselining resets the point of comparison Compare-with-Baseline (and
-- the Revision Summary variance) measures against, once drift from the
-- ORIGINAL baseline has grown large enough that comparing against it is no
-- longer useful -- e.g. after several approved revisions have piled up.
-- Unlike start_wbs_revision/apply_wbs_revision (which change the PLAN),
-- re-baselining doesn't touch tasks at all -- it just promotes the
-- CURRENT plan (the latest project_plan_versions snapshot, already
-- persisted by whichever RPC produced it) to be the new official
-- baseline. Old baselines are superseded (is_active = false), never
-- deleted -- version history stays intact for later audit.
--
-- Deliberately takes no p_tasks jsonb (unlike lock/apply-revision): the
-- live tasks table is guaranteed to match the latest plan_version's
-- snapshot exactly whenever this is callable (wbs_status must be
-- baseline_locked/changed_after_baseline, i.e. NOT mid-revision, so
-- there's no unsaved/uncommitted edit state to snapshot fresh from the
-- client). Sourcing straight from project_plan_version_tasks avoids
-- requiring the caller to rebuild a scheduling snapshot for an action
-- that isn't actually re-scheduling anything.
create or replace function rebaseline_wbs_plan(p_project_id uuid, p_reason text)
returns uuid
language plpgsql security definer as $$
declare
  v_status text;
  v_latest_version_id uuid;
  v_mode text;
  v_total_hours numeric;
  v_task_count integer;
  v_start date;
  v_end date;
  v_new_version_number integer;
  v_new_baseline_id uuid;
begin
  if not can_manage_wbs(p_project_id) then
    raise exception 'not authorized to re-baseline this project';
  end if;

  select wbs_status into v_status from projects where id = p_project_id;
  if v_status is null then
    raise exception 'project not found';
  end if;
  if v_status not in ('baseline_locked','changed_after_baseline') then
    raise exception 'can only re-baseline once a baseline is locked and no revision is in progress (current status: %)', v_status;
  end if;

  select id, mode, total_est_hours, task_count, start_date, end_date
    into v_latest_version_id, v_mode, v_total_hours, v_task_count, v_start, v_end
    from project_plan_versions
    where project_id = p_project_id
    order by version_number desc
    limit 1;
  if v_latest_version_id is null then
    raise exception 'no plan version found to re-baseline from';
  end if;

  update project_baselines set is_active = false where project_id = p_project_id and is_active = true;

  select coalesce(max(version_number), 0) + 1 into v_new_version_number from project_baselines where project_id = p_project_id;

  insert into project_baselines (project_id, captured_by, version_number, is_active, reason, mode, total_est_hours, task_count, start_date, end_date)
  values (p_project_id, my_person_id(), v_new_version_number, true, p_reason, v_mode, v_total_hours, v_task_count, v_start, v_end)
  returning id into v_new_baseline_id;

  insert into project_baseline_tasks (baseline_id, task_id, parent_task_id, name, estimated_hours, assignee_name, effort, depends_on, start_date_full, end_date_full, start_date_standard, end_date_standard)
  select v_new_baseline_id, task_id, parent_task_id, name, estimated_hours, assignee_name, effort, depends_on, start_date_full, end_date_full, start_date_standard, end_date_standard
  from project_plan_version_tasks
  where plan_version_id = v_latest_version_id;

  -- The new baseline now IS the current plan by definition, so any drift
  -- recorded by a prior revision no longer applies -- reset to plain
  -- Baseline Locked rather than leaving "Changed After Baseline" stuck on.
  update projects set wbs_status = 'baseline_locked' where id = p_project_id;

  return v_new_baseline_id;
end;
$$;

grant execute on function rebaseline_wbs_plan(uuid, text) to authenticated;
