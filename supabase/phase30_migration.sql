-- Phase 30 (2026-09-02): fix decide_baseline_request never syncing
-- projects.start_date/end_date at lock time.
--
-- Found during Wave 4 live-regression testing of Waves 1-3 together. Not
-- caused by any of the three waves -- pre-existing since phase15/16 -- but
-- surfaced by it: healthOf() (Wave 3's actualProgress fix) correctly
-- returns "Health unavailable" whenever a project is missing start_date or
-- end_date. Both branches of decide_baseline_request (the initial Draft
-- lock, and the re-baseline/revision-applied path) already compute
-- v_start/v_end for the project_baselines/project_plan_versions rows, but
-- never write them back onto the projects row itself. The client-side
-- sync effect (Projects.tsx's projectDatesFromTasks useEffect) normally
-- keeps projects.start_date/end_date current *while unlocked*, but it
-- stops the instant timelines_locked flips true -- so if that effect
-- hasn't flushed a task's current_due_date to the DB yet at the exact
-- moment a baseline request is approved (a plausible race, and exactly
-- what happened to a project seeded directly via SQL in a test), the
-- project's end_date (or start_date) freezes at NULL forever: once
-- timelines_locked, the projects_date_lock trigger (policies.sql) blocks
-- any further write to those columns except via an approved Project
-- Extension Request. A permanently-null end_date means healthOf() can
-- never show anything but "Health unavailable" -- no data-repair path
-- short of a superuser bypassing the trigger.
--
-- Fix: both places that flip timelines_locked also now stamp
-- start_date/end_date from the same v_start/v_end already computed for
-- the baseline/version row, coalesced against the existing value so a
-- late/partial task snapshot can't blow away a good date with a null one.
-- Since this happens in the SAME update statement that sets
-- timelines_locked = true, enforce_project_date_lock() sees
-- OLD.timelines_locked = false and allows it (the trigger only blocks
-- date writes once the row was ALREADY locked coming in).
--
-- Identical to phase16_migration.sql's decide_baseline_request otherwise.

create or replace function decide_baseline_request(p_request_id uuid, p_approve boolean, p_reason text, p_mode text, p_tasks jsonb)
returns uuid
language plpgsql security definer as $$
declare
  v_project_id uuid;
  v_status text;
  v_project_status text;
  v_task_count integer;
  v_total_hours numeric;
  v_start date;
  v_end date;
  v_baseline_id uuid;
  v_version_id uuid;
  v_open_revision_id uuid;
  v_source_version_id uuid;
  v_new_version_number integer;
  v_new_version_id uuid;
  v_mode text;
  v_latest_version_id uuid;
  v_new_baseline_version_number integer;
begin
  select project_id, status into v_project_id, v_status from project_baseline_requests where id = p_request_id;
  if v_project_id is null then
    raise exception 'baseline request not found';
  end if;
  if not can_decide_baseline_request(p_request_id) then
    raise exception 'not authorized to decide this baseline request';
  end if;
  if v_status <> 'pending' then
    raise exception 'baseline request is not pending (current status: %)', v_status;
  end if;

  if not p_approve then
    update project_baseline_requests set status = 'rejected', decided_by = my_person_id(), decided_at = now(), decision_reason = p_reason
      where id = p_request_id;
    return p_request_id;
  end if;

  select wbs_status into v_project_status from projects where id = v_project_id;

  if v_project_status = 'draft' then
    if p_mode not in ('full_capacity','standard','manual') then
      raise exception 'invalid mode %', p_mode;
    end if;

    select count(*) into v_task_count from jsonb_array_elements(p_tasks);
    if v_task_count = 0 then
      raise exception 'cannot lock a baseline with no tasks';
    end if;

    select
      coalesce(sum((t->>'estimated_hours')::numeric) filter (where t->>'parent_task_id' is null), 0),
      min(case when p_mode <> 'full_capacity' then (t->>'start_date_standard')::date else (t->>'start_date_full')::date end),
      max(case when p_mode <> 'full_capacity' then (t->>'end_date_standard')::date else (t->>'end_date_full')::date end)
    into v_total_hours, v_start, v_end
    from jsonb_array_elements(p_tasks) t;

    insert into project_baselines (project_id, captured_by, version_number, is_active, reason, mode, total_est_hours, task_count, start_date, end_date)
    values (v_project_id, my_person_id(), 1, true, p_reason, p_mode, v_total_hours, v_task_count, v_start, v_end)
    returning id into v_baseline_id;

    insert into project_baseline_tasks (baseline_id, task_id, parent_task_id, name, estimated_hours, assignee_name, effort, depends_on, start_date_full, end_date_full, start_date_standard, end_date_standard)
    select
      v_baseline_id, (t->>'task_id')::uuid, nullif(t->>'parent_task_id','')::uuid, t->>'name',
      (t->>'estimated_hours')::numeric, t->>'assignee_name', t->>'effort', coalesce(t->'depends_on', '[]'::jsonb),
      (t->>'start_date_full')::date, (t->>'end_date_full')::date, (t->>'start_date_standard')::date, (t->>'end_date_standard')::date
    from jsonb_array_elements(p_tasks) t;

    insert into project_plan_versions (project_id, version_number, created_by, source, mode, total_est_hours, task_count, start_date, end_date)
    values (v_project_id, 1, my_person_id(), 'initial_lock', p_mode, v_total_hours, v_task_count, v_start, v_end)
    returning id into v_version_id;

    insert into project_plan_version_tasks (plan_version_id, task_id, parent_task_id, name, estimated_hours, assignee_name, effort, depends_on, start_date_full, end_date_full, start_date_standard, end_date_standard)
    select
      v_version_id, (t->>'task_id')::uuid, nullif(t->>'parent_task_id','')::uuid, t->>'name',
      (t->>'estimated_hours')::numeric, t->>'assignee_name', t->>'effort', coalesce(t->'depends_on', '[]'::jsonb),
      (t->>'start_date_full')::date, (t->>'end_date_full')::date, (t->>'start_date_standard')::date, (t->>'end_date_standard')::date
    from jsonb_array_elements(p_tasks) t;

    update projects set wbs_status = 'baseline_locked', timelines_locked = true,
      start_date = coalesce(v_start, start_date), end_date = coalesce(v_end, end_date)
      where id = v_project_id;

    update project_baseline_requests set status = 'approved', decided_by = my_person_id(), decided_at = now(),
      decision_reason = p_reason, resulting_baseline_id = v_baseline_id
      where id = p_request_id;

    return v_baseline_id;

  elsif v_project_status in ('baseline_locked','changed_after_baseline') then
    select id, source_plan_version_id into v_open_revision_id, v_source_version_id
      from project_revisions where project_id = v_project_id and status = 'in_progress';

    if v_open_revision_id is not null then
      select mode into v_mode from project_plan_versions where id = v_source_version_id;
      v_mode := coalesce(v_mode, 'full_capacity');

      select count(*) into v_task_count from jsonb_array_elements(p_tasks);
      select
        coalesce(sum((t->>'estimated_hours')::numeric) filter (where t->>'parent_task_id' is null), 0),
        min(case when v_mode <> 'full_capacity' then (t->>'start_date_standard')::date else (t->>'start_date_full')::date end),
        max(case when v_mode <> 'full_capacity' then (t->>'end_date_standard')::date else (t->>'end_date_full')::date end)
      into v_total_hours, v_start, v_end
      from jsonb_array_elements(p_tasks) t;

      select coalesce(max(version_number), 0) + 1 into v_new_version_number from project_plan_versions where project_id = v_project_id;

      insert into project_plan_versions (project_id, version_number, created_by, source, revision_id, mode, total_est_hours, task_count, start_date, end_date)
      values (v_project_id, v_new_version_number, my_person_id(), 'revision_applied', v_open_revision_id, v_mode, v_total_hours, v_task_count, v_start, v_end)
      returning id into v_new_version_id;

      insert into project_plan_version_tasks (plan_version_id, task_id, parent_task_id, name, estimated_hours, assignee_name, effort, depends_on, start_date_full, end_date_full, start_date_standard, end_date_standard)
      select
        v_new_version_id, (t->>'task_id')::uuid, nullif(t->>'parent_task_id','')::uuid, t->>'name',
        (t->>'estimated_hours')::numeric, t->>'assignee_name', t->>'effort', coalesce(t->'depends_on', '[]'::jsonb),
        (t->>'start_date_full')::date, (t->>'end_date_full')::date, (t->>'start_date_standard')::date, (t->>'end_date_standard')::date
      from jsonb_array_elements(p_tasks) t;

      insert into project_revision_changes (revision_id, task_id, task_name, change_type, changed_by)
      select v_open_revision_id, o.task_id, o.name, 'task_removed', my_person_id()
      from project_plan_version_tasks o
      where o.plan_version_id = v_source_version_id
        and not exists (select 1 from jsonb_array_elements(p_tasks) t where (t->>'task_id')::uuid = o.task_id);

      insert into project_revision_changes (revision_id, task_id, task_name, change_type, changed_by)
      select v_open_revision_id, (t->>'task_id')::uuid, t->>'name', 'task_added', my_person_id()
      from jsonb_array_elements(p_tasks) t
      where not exists (select 1 from project_plan_version_tasks o where o.plan_version_id = v_source_version_id and o.task_id = (t->>'task_id')::uuid);

      insert into project_revision_changes (revision_id, task_id, task_name, change_type, field, previous_value, new_value, changed_by)
      select v_open_revision_id, o.task_id, o.name, 'hours_changed', 'estimated_hours',
        to_jsonb(o.estimated_hours), to_jsonb((t->>'estimated_hours')::numeric), my_person_id()
      from project_plan_version_tasks o
      join jsonb_array_elements(p_tasks) t on (t->>'task_id')::uuid = o.task_id
      where o.plan_version_id = v_source_version_id
        and coalesce(o.estimated_hours, -1) is distinct from coalesce((t->>'estimated_hours')::numeric, -1);

      insert into project_revision_changes (revision_id, task_id, task_name, change_type, field, previous_value, new_value, changed_by)
      select v_open_revision_id, o.task_id, o.name, 'date_changed', 'schedule',
        jsonb_build_object('start_full', o.start_date_full, 'end_full', o.end_date_full, 'start_standard', o.start_date_standard, 'end_standard', o.end_date_standard),
        jsonb_build_object('start_full', (t->>'start_date_full')::date, 'end_full', (t->>'end_date_full')::date, 'start_standard', (t->>'start_date_standard')::date, 'end_standard', (t->>'end_date_standard')::date),
        my_person_id()
      from project_plan_version_tasks o
      join jsonb_array_elements(p_tasks) t on (t->>'task_id')::uuid = o.task_id
      where o.plan_version_id = v_source_version_id
        and (o.start_date_full, o.end_date_full, o.start_date_standard, o.end_date_standard)
            is distinct from ((t->>'start_date_full')::date, (t->>'end_date_full')::date, (t->>'start_date_standard')::date, (t->>'end_date_standard')::date);

      insert into project_revision_changes (revision_id, task_id, task_name, change_type, field, previous_value, new_value, changed_by)
      select v_open_revision_id, o.task_id, o.name, 'assignee_changed', 'assignee_name',
        to_jsonb(o.assignee_name), to_jsonb(t->>'assignee_name'), my_person_id()
      from project_plan_version_tasks o
      join jsonb_array_elements(p_tasks) t on (t->>'task_id')::uuid = o.task_id
      where o.plan_version_id = v_source_version_id
        and coalesce(o.assignee_name,'') is distinct from coalesce(t->>'assignee_name','');

      insert into project_revision_changes (revision_id, task_id, task_name, change_type, field, previous_value, new_value, changed_by)
      select v_open_revision_id, o.task_id, o.name, 'dependency_changed', 'depends_on', o.depends_on, coalesce(t->'depends_on','[]'::jsonb), my_person_id()
      from project_plan_version_tasks o
      join jsonb_array_elements(p_tasks) t on (t->>'task_id')::uuid = o.task_id
      where o.plan_version_id = v_source_version_id
        and coalesce(o.depends_on, '[]'::jsonb) is distinct from coalesce(t->'depends_on', '[]'::jsonb);

      update project_revisions set status = 'applied', applied_by = my_person_id(), applied_at = now(), resulting_plan_version_id = v_new_version_id
        where id = v_open_revision_id;
    end if;

    select id, mode, total_est_hours, task_count, start_date, end_date
      into v_latest_version_id, v_mode, v_total_hours, v_task_count, v_start, v_end
      from project_plan_versions where project_id = v_project_id order by version_number desc limit 1;
    if v_latest_version_id is null then
      raise exception 'no plan version found to re-baseline from';
    end if;

    update project_baselines set is_active = false where project_id = v_project_id and is_active = true;
    select coalesce(max(version_number), 0) + 1 into v_new_baseline_version_number from project_baselines where project_id = v_project_id;

    insert into project_baselines (project_id, captured_by, version_number, is_active, reason, mode, total_est_hours, task_count, start_date, end_date)
    values (v_project_id, my_person_id(), v_new_baseline_version_number, true, p_reason, v_mode, v_total_hours, v_task_count, v_start, v_end)
    returning id into v_baseline_id;

    insert into project_baseline_tasks (baseline_id, task_id, parent_task_id, name, estimated_hours, assignee_name, effort, depends_on, start_date_full, end_date_full, start_date_standard, end_date_standard)
    select v_baseline_id, task_id, parent_task_id, name, estimated_hours, assignee_name, effort, depends_on, start_date_full, end_date_full, start_date_standard, end_date_standard
    from project_plan_version_tasks
    where plan_version_id = v_latest_version_id;

    update projects set wbs_status = 'baseline_locked', timelines_locked = true,
      start_date = coalesce(v_start, start_date), end_date = coalesce(v_end, end_date)
      where id = v_project_id;

    update project_baseline_requests set status = 'approved', decided_by = my_person_id(), decided_at = now(),
      decision_reason = p_reason, resulting_baseline_id = v_baseline_id
      where id = p_request_id;

    return v_baseline_id;

  else
    raise exception 'project is not in a state a baseline can be approved from (current status: %)', v_project_status;
  end if;
end;
$$;

grant execute on function decide_baseline_request(uuid, boolean, text, text, jsonb) to authenticated;
