-- Migration 2026-07-28j: Phase 2 -- Lock / Revision / Closure RPCs for the
-- Draft / Baseline / Revision / Final-Scope workflow. Builds on the Phase 1
-- tables (phase1_migration.sql). These functions are additive: nothing here
-- changes the EXISTING Lock/Unlock button (set_project_timelines_locked) or
-- the existing re-runnable Close-out (project_closeouts update path) --
-- those are wired to the new workflow and retired in a later phase (6),
-- once the WBS/Projects UI actually starts calling these instead.
--
-- All six RPCs follow the same authorization shape used everywhere else in
-- this app (Extension Requests, Time Tracking): a shared helper checks
-- Full Access / project owner, "flat" tiering for now per Sandra's
-- 2026-07-28 call ("flat with variance shown at approvals"), decision
-- functions are security definer plpgsql, RLS still gates direct table
-- access as an audit trail.
--
-- Design note on schedule dates: WbsPlanning.tsx already computes each
-- task's Start/End for BOTH modes client-side (refreshDates' dependency-
-- respecting topological scheduler) and renders them -- reimplementing
-- that scheduling algorithm in SQL would duplicate real business logic in
-- two places and risk drift. Instead, lock/apply-revision accept the
-- already-computed per-task snapshot as a `jsonb` array from the caller
-- (same values already on screen), and the RPC's job is purely the
-- transactional part: persist the snapshot, version it, flip wbs_status,
-- diff for revisions. This mirrors how captureProjectBaseline in
-- Projects.tsx already works today (client computes, then writes) --
-- Phase 2 just makes it atomic and versioned instead of three separate
-- non-transactional inserts.

-- ---------------------------------------------------------------------
-- Shared authorization helper -- flat tiering: Full Access or the
-- project's own owner. Used by lock/start/apply/discard/request.
-- Closure DECISIONS use a separate, slightly wider check (below) since
-- Sandra wants closure approval to also be assignable to a permission
-- (can_approve_closures), not just owner/Full Access.
-- ---------------------------------------------------------------------
create or replace function can_manage_wbs(p_project_id uuid) returns boolean
language sql stable security definer as $$
  select coalesce(
    (select my_access_level() = 'full'),
    false
  ) or exists (
    select 1 from projects where id = p_project_id and owner_id = my_person_id()
  );
$$;

grant execute on function can_manage_wbs(uuid) to authenticated;

create or replace function can_decide_closure(p_request_id uuid) returns boolean
language sql stable security definer as $$
  select
    my_access_level() = 'full'
    or exists (select 1 from people me where me.id = my_person_id() and me.can_approve_closures)
    or exists (
      select 1 from project_closure_requests r join projects pr on pr.id = r.project_id
      where r.id = p_request_id and pr.owner_id = my_person_id()
    );
$$;

grant execute on function can_decide_closure(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 1. lock_wbs_baseline -- Draft -> Baseline Locked. First and only time
--    version 1 of both project_baselines and project_plan_versions gets
--    created for a project (guarded by wbs_status = 'draft'). Re-locking
--    after this point isn't a thing -- that's what Start Revision /
--    Re-baseline (Phase 5) are for.
-- ---------------------------------------------------------------------
create or replace function lock_wbs_baseline(p_project_id uuid, p_mode text, p_reason text, p_tasks jsonb)
returns uuid
language plpgsql security definer as $$
declare
  v_status text;
  v_task_count integer;
  v_total_hours numeric;
  v_start date;
  v_end date;
  v_baseline_id uuid;
  v_version_id uuid;
begin
  if not can_manage_wbs(p_project_id) then
    raise exception 'not authorized to lock this project''s baseline';
  end if;
  if p_mode not in ('full_capacity','standard') then
    raise exception 'invalid mode %', p_mode;
  end if;

  select wbs_status into v_status from projects where id = p_project_id;
  if v_status is null then
    raise exception 'project not found';
  end if;
  if v_status <> 'draft' then
    raise exception 'can only lock a baseline from Draft (current status: %)', v_status;
  end if;

  select count(*) into v_task_count from jsonb_array_elements(p_tasks);
  if v_task_count = 0 then
    raise exception 'cannot lock a baseline with no tasks';
  end if;

  select
    coalesce(sum((t->>'estimated_hours')::numeric) filter (where t->>'parent_task_id' is null), 0),
    min(case when p_mode = 'standard' then (t->>'start_date_standard')::date else (t->>'start_date_full')::date end),
    max(case when p_mode = 'standard' then (t->>'end_date_standard')::date else (t->>'end_date_full')::date end)
  into v_total_hours, v_start, v_end
  from jsonb_array_elements(p_tasks) t;

  insert into project_baselines (project_id, captured_by, version_number, is_active, reason, mode, total_est_hours, task_count, start_date, end_date)
  values (p_project_id, my_person_id(), 1, true, p_reason, p_mode, v_total_hours, v_task_count, v_start, v_end)
  returning id into v_baseline_id;

  insert into project_baseline_tasks (baseline_id, task_id, parent_task_id, name, estimated_hours, assignee_name, effort, depends_on, start_date_full, end_date_full, start_date_standard, end_date_standard)
  select
    v_baseline_id,
    (t->>'task_id')::uuid,
    nullif(t->>'parent_task_id','')::uuid,
    t->>'name',
    (t->>'estimated_hours')::numeric,
    t->>'assignee_name',
    t->>'effort',
    coalesce(t->'depends_on', '[]'::jsonb),
    (t->>'start_date_full')::date,
    (t->>'end_date_full')::date,
    (t->>'start_date_standard')::date,
    (t->>'end_date_standard')::date
  from jsonb_array_elements(p_tasks) t;

  insert into project_plan_versions (project_id, version_number, created_by, source, mode, total_est_hours, task_count, start_date, end_date)
  values (p_project_id, 1, my_person_id(), 'initial_lock', p_mode, v_total_hours, v_task_count, v_start, v_end)
  returning id into v_version_id;

  insert into project_plan_version_tasks (plan_version_id, task_id, parent_task_id, name, estimated_hours, assignee_name, effort, depends_on, start_date_full, end_date_full, start_date_standard, end_date_standard)
  select
    v_version_id,
    (t->>'task_id')::uuid,
    nullif(t->>'parent_task_id','')::uuid,
    t->>'name',
    (t->>'estimated_hours')::numeric,
    t->>'assignee_name',
    t->>'effort',
    coalesce(t->'depends_on', '[]'::jsonb),
    (t->>'start_date_full')::date,
    (t->>'end_date_full')::date,
    (t->>'start_date_standard')::date,
    (t->>'end_date_standard')::date
  from jsonb_array_elements(p_tasks) t;

  update projects set wbs_status = 'baseline_locked', timelines_locked = true where id = p_project_id;

  return v_baseline_id;
end;
$$;

grant execute on function lock_wbs_baseline(uuid, text, text, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 2. start_wbs_revision -- Baseline Locked / Changed After Baseline ->
--    Revision in Progress. Unlocks editing (timelines_locked = false,
--    same field the existing Lock button governs) so the WBS page's
--    normal editing UI just works during a revision -- Phase 3 gates the
--    page on wbs_status instead of a brand new lock flag.
-- ---------------------------------------------------------------------
create or replace function start_wbs_revision(p_project_id uuid, p_reason text)
returns uuid
language plpgsql security definer as $$
declare
  v_status text;
  v_source_version_id uuid;
  v_revision_number integer;
  v_revision_id uuid;
begin
  if not can_manage_wbs(p_project_id) then
    raise exception 'not authorized to start a revision on this project';
  end if;

  select wbs_status into v_status from projects where id = p_project_id;
  if v_status is null then
    raise exception 'project not found';
  end if;
  if v_status not in ('baseline_locked','changed_after_baseline') then
    raise exception 'can only start a revision once a baseline is locked (current status: %)', v_status;
  end if;
  if exists (select 1 from project_revisions where project_id = p_project_id and status = 'in_progress') then
    raise exception 'a revision is already in progress for this project';
  end if;

  select id into v_source_version_id from project_plan_versions
    where project_id = p_project_id order by version_number desc limit 1;
  select coalesce(max(revision_number), 0) + 1 into v_revision_number from project_revisions where project_id = p_project_id;

  insert into project_revisions (project_id, revision_number, reason, status, source_plan_version_id, started_by)
  values (p_project_id, v_revision_number, p_reason, 'in_progress', v_source_version_id, my_person_id())
  returning id into v_revision_id;

  update projects set wbs_status = 'revision_in_progress', timelines_locked = false where id = p_project_id;

  return v_revision_id;
end;
$$;

grant execute on function start_wbs_revision(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 3. apply_wbs_revision -- Revision in Progress -> Changed After
--    Baseline. Snapshots the (edited) live task state as a new plan
--    version, diffs it against the revision's source version, writes
--    the diff to project_revision_changes, re-locks timelines.
-- ---------------------------------------------------------------------
create or replace function apply_wbs_revision(p_revision_id uuid, p_tasks jsonb)
returns uuid
language plpgsql security definer as $$
declare
  v_project_id uuid;
  v_status text;
  v_source_version_id uuid;
  v_new_version_number integer;
  v_new_version_id uuid;
  v_task_count integer;
  v_total_hours numeric;
  v_start date;
  v_end date;
  v_mode text;
begin
  select project_id, status, source_plan_version_id into v_project_id, v_status, v_source_version_id
    from project_revisions where id = p_revision_id;
  if v_project_id is null then
    raise exception 'revision not found';
  end if;
  if not can_manage_wbs(v_project_id) then
    raise exception 'not authorized to apply this revision';
  end if;
  if v_status <> 'in_progress' then
    raise exception 'revision is not in progress (current status: %)', v_status;
  end if;

  select mode into v_mode from project_plan_versions where id = v_source_version_id;
  v_mode := coalesce(v_mode, 'full_capacity');

  select count(*) into v_task_count from jsonb_array_elements(p_tasks);
  select
    coalesce(sum((t->>'estimated_hours')::numeric) filter (where t->>'parent_task_id' is null), 0),
    min(case when v_mode = 'standard' then (t->>'start_date_standard')::date else (t->>'start_date_full')::date end),
    max(case when v_mode = 'standard' then (t->>'end_date_standard')::date else (t->>'end_date_full')::date end)
  into v_total_hours, v_start, v_end
  from jsonb_array_elements(p_tasks) t;

  select coalesce(max(version_number), 0) + 1 into v_new_version_number from project_plan_versions where project_id = v_project_id;

  insert into project_plan_versions (project_id, version_number, created_by, source, revision_id, mode, total_est_hours, task_count, start_date, end_date)
  values (v_project_id, v_new_version_number, my_person_id(), 'revision_applied', p_revision_id, v_mode, v_total_hours, v_task_count, v_start, v_end)
  returning id into v_new_version_id;

  insert into project_plan_version_tasks (plan_version_id, task_id, parent_task_id, name, estimated_hours, assignee_name, effort, depends_on, start_date_full, end_date_full, start_date_standard, end_date_standard)
  select
    v_new_version_id,
    (t->>'task_id')::uuid,
    nullif(t->>'parent_task_id','')::uuid,
    t->>'name',
    (t->>'estimated_hours')::numeric,
    t->>'assignee_name',
    t->>'effort',
    coalesce(t->'depends_on', '[]'::jsonb),
    (t->>'start_date_full')::date,
    (t->>'end_date_full')::date,
    (t->>'start_date_standard')::date,
    (t->>'end_date_standard')::date
  from jsonb_array_elements(p_tasks) t;

  -- Diff against the source version: removed tasks
  insert into project_revision_changes (revision_id, task_id, task_name, change_type, changed_by)
  select p_revision_id, o.task_id, o.name, 'task_removed', my_person_id()
  from project_plan_version_tasks o
  where o.plan_version_id = v_source_version_id
    and not exists (select 1 from jsonb_array_elements(p_tasks) t where (t->>'task_id')::uuid = o.task_id);

  -- Added tasks
  insert into project_revision_changes (revision_id, task_id, task_name, change_type, changed_by)
  select p_revision_id, (t->>'task_id')::uuid, t->>'name', 'task_added', my_person_id()
  from jsonb_array_elements(p_tasks) t
  where not exists (select 1 from project_plan_version_tasks o where o.plan_version_id = v_source_version_id and o.task_id = (t->>'task_id')::uuid);

  -- Changed hours
  insert into project_revision_changes (revision_id, task_id, task_name, change_type, field, previous_value, new_value, changed_by)
  select p_revision_id, o.task_id, o.name, 'hours_changed', 'estimated_hours',
    to_jsonb(o.estimated_hours), to_jsonb((t->>'estimated_hours')::numeric), my_person_id()
  from project_plan_version_tasks o
  join jsonb_array_elements(p_tasks) t on (t->>'task_id')::uuid = o.task_id
  where o.plan_version_id = v_source_version_id
    and coalesce(o.estimated_hours, -1) is distinct from coalesce((t->>'estimated_hours')::numeric, -1);

  -- Changed dates (either mode)
  insert into project_revision_changes (revision_id, task_id, task_name, change_type, field, previous_value, new_value, changed_by)
  select p_revision_id, o.task_id, o.name, 'date_changed', 'schedule',
    jsonb_build_object('start_full', o.start_date_full, 'end_full', o.end_date_full, 'start_standard', o.start_date_standard, 'end_standard', o.end_date_standard),
    jsonb_build_object('start_full', (t->>'start_date_full')::date, 'end_full', (t->>'end_date_full')::date, 'start_standard', (t->>'start_date_standard')::date, 'end_standard', (t->>'end_date_standard')::date),
    my_person_id()
  from project_plan_version_tasks o
  join jsonb_array_elements(p_tasks) t on (t->>'task_id')::uuid = o.task_id
  where o.plan_version_id = v_source_version_id
    and (o.start_date_full, o.end_date_full, o.start_date_standard, o.end_date_standard)
        is distinct from ((t->>'start_date_full')::date, (t->>'end_date_full')::date, (t->>'start_date_standard')::date, (t->>'end_date_standard')::date);

  -- Changed assignee
  insert into project_revision_changes (revision_id, task_id, task_name, change_type, field, previous_value, new_value, changed_by)
  select p_revision_id, o.task_id, o.name, 'assignee_changed', 'assignee_name',
    to_jsonb(o.assignee_name), to_jsonb(t->>'assignee_name'), my_person_id()
  from project_plan_version_tasks o
  join jsonb_array_elements(p_tasks) t on (t->>'task_id')::uuid = o.task_id
  where o.plan_version_id = v_source_version_id
    and coalesce(o.assignee_name,'') is distinct from coalesce(t->>'assignee_name','');

  -- Changed dependencies
  insert into project_revision_changes (revision_id, task_id, task_name, change_type, field, previous_value, new_value, changed_by)
  select p_revision_id, o.task_id, o.name, 'dependency_changed', 'depends_on', o.depends_on, coalesce(t->'depends_on','[]'::jsonb), my_person_id()
  from project_plan_version_tasks o
  join jsonb_array_elements(p_tasks) t on (t->>'task_id')::uuid = o.task_id
  where o.plan_version_id = v_source_version_id
    and coalesce(o.depends_on, '[]'::jsonb) is distinct from coalesce(t->'depends_on', '[]'::jsonb);

  update project_revisions set status = 'applied', applied_by = my_person_id(), applied_at = now(), resulting_plan_version_id = v_new_version_id
    where id = p_revision_id;

  update projects set wbs_status = 'changed_after_baseline', timelines_locked = true where id = v_project_id;

  return v_new_version_id;
end;
$$;

grant execute on function apply_wbs_revision(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 4. discard_wbs_revision -- true undo. Restores every live task back to
--    exactly the source plan version's snapshot: edited tasks get their
--    fields put back, tasks added during the revision are hard-deleted
--    (per the normal "tasks are always hard-deleted" rule), tasks removed
--    during the revision are un-archived (the Phase 1 soft-delete
--    exception this was built for).
-- ---------------------------------------------------------------------
create or replace function discard_wbs_revision(p_revision_id uuid)
returns void
language plpgsql security definer as $$
declare
  v_project_id uuid;
  v_status text;
  v_source_version_id uuid;
  v_prior_status text;
begin
  select project_id, status, source_plan_version_id into v_project_id, v_status, v_source_version_id
    from project_revisions where id = p_revision_id;
  if v_project_id is null then
    raise exception 'revision not found';
  end if;
  if not can_manage_wbs(v_project_id) then
    raise exception 'not authorized to discard this revision';
  end if;
  if v_status <> 'in_progress' then
    raise exception 'revision is not in progress (current status: %)', v_status;
  end if;

  -- Restore edited tasks (still exist) back to the snapshot.
  update tasks tk set
    name = o.name,
    parent_task_id = o.parent_task_id,
    estimated_hours = o.estimated_hours,
    effort = o.effort,
    start_date_full = o.start_date_full,
    start_date_standard = o.start_date_standard,
    assignee_id = (select p.id from people p where p.name = o.assignee_name limit 1)
  from project_plan_version_tasks o
  where o.plan_version_id = v_source_version_id and o.task_id = tk.id;

  -- Hard-delete tasks that were added during this revision (not in the
  -- source snapshot at all).
  delete from task_dependencies where task_id in (
    select tk.id from tasks tk
    where tk.project_id = v_project_id
      and not exists (select 1 from project_plan_version_tasks o where o.plan_version_id = v_source_version_id and o.task_id = tk.id)
  ) or depends_on_task_id in (
    select tk.id from tasks tk
    where tk.project_id = v_project_id
      and not exists (select 1 from project_plan_version_tasks o where o.plan_version_id = v_source_version_id and o.task_id = tk.id)
  );
  delete from tasks tk
  where tk.project_id = v_project_id
    and not exists (select 1 from project_plan_version_tasks o where o.plan_version_id = v_source_version_id and o.task_id = tk.id);

  -- Un-archive tasks that were removed during this revision.
  update tasks set is_archived = false, removed_in_revision_id = null
  where removed_in_revision_id = p_revision_id;

  update project_revisions set status = 'discarded', discarded_by = my_person_id(), discarded_at = now()
    where id = p_revision_id;

  select case when exists (
    select 1 from project_revisions where project_id = v_project_id and status = 'applied'
  ) then 'changed_after_baseline' else 'baseline_locked' end into v_prior_status;

  update projects set wbs_status = v_prior_status, timelines_locked = true where id = v_project_id;
end;
$$;

grant execute on function discard_wbs_revision(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 5. request_wbs_closure -- Baseline Locked / Changed After Baseline ->
--    a pending project_closure_requests row. "No more double closing" --
--    blocked once wbs_status is already 'closed'.
-- ---------------------------------------------------------------------
create or replace function request_wbs_closure(p_project_id uuid)
returns uuid
language plpgsql security definer as $$
declare
  v_status text;
  v_request_id uuid;
begin
  if not can_manage_wbs(p_project_id) then
    raise exception 'not authorized to request closure for this project';
  end if;

  select wbs_status into v_status from projects where id = p_project_id;
  if v_status is null then
    raise exception 'project not found';
  end if;
  if v_status = 'closed' then
    raise exception 'project is already closed';
  end if;
  if v_status = 'draft' then
    raise exception 'lock a baseline before requesting closure';
  end if;
  if v_status = 'revision_in_progress' then
    raise exception 'apply or discard the in-progress revision before requesting closure';
  end if;
  if exists (select 1 from project_closure_requests where project_id = p_project_id and status = 'pending') then
    raise exception 'a closure request is already pending for this project';
  end if;

  insert into project_closure_requests (project_id, requested_by, status)
  values (p_project_id, my_person_id(), 'pending')
  returning id into v_request_id;

  return v_request_id;
end;
$$;

grant execute on function request_wbs_closure(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 6. decide_wbs_closure -- approve (captures immutable Final Scope into
--    project_closeouts, same shape the existing Baseline-vs-Final report
--    already reads) or reject. Closing is final: once approved, there is
--    no unlock path back out of wbs_status = 'closed' in this schema.
-- ---------------------------------------------------------------------
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
    min(case when v_mode = 'standard' then (t->>'start_date_standard')::date else (t->>'start_date_full')::date end),
    max(case when v_mode = 'standard' then (t->>'end_date_standard')::date else (t->>'end_date_full')::date end)
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

  update projects set wbs_status = 'closed' where id = v_project_id;

  return v_closeout_id;
end;
$$;

grant execute on function decide_wbs_closure(uuid, boolean, text, jsonb) to authenticated;
