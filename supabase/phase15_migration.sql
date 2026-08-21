-- ---------------------------------------------------------------------
-- Phase 15 migration (2026-08-21): "Phase 6" of the sequenced pipeline --
-- Baseline Approval workflow, replacing the manual Start Revision / Apply
-- Revision / Discard Revision cycle.
--
-- Sandra's ask (paraphrased from her own description): remove the extra
-- "Start Revision" click -- once a baseline exists, editing should just
-- be open, no unlock step. Locking/re-locking a baseline becomes a real
-- approval step instead of a unilateral one-click action, gated strictly
-- on people.can_approve_rebaseline (her explicit choice -- unlike Close's
-- can_decide_closure, owner/Full Access do NOT auto-qualify here). Any
-- edits made after a baseline is locked are still captured/logged, same
-- as before -- there's just no more manual "Start Revision" button
-- gating when that logging begins.
--
-- Net effect on the state machine (projects.wbs_status):
--   draft -> baseline_locked -> changed_after_baseline -> closed
-- "revision_in_progress" is retired from the manual flow (the column
-- value still exists in the check constraint for old data/back-compat,
-- but nothing sets it going forward). The moment ANY edit happens while
-- baseline_locked, the project auto-flips to changed_after_baseline (see
-- record_wbs_edit below) -- no click required.
--
-- Existing start_wbs_revision/apply_wbs_revision/discard_wbs_revision/
-- rebaseline_wbs_plan RPCs are left completely untouched (not dropped,
-- not modified) -- Revision History, the Changes/Notes column, and the
-- Audit Trail page all read project_revisions/project_revision_changes
-- populated by apply_wbs_revision, and decide_baseline_request below
-- reuses that exact same diffing/snapshotting logic internally so those
-- read paths keep working unchanged.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 1. project_baseline_requests -- request-then-approve, same shape as
--    project_closure_requests. Covers BOTH the first-ever baseline lock
--    (from Draft) and any later re-baseline (from Baseline Locked /
--    Changed After Baseline) -- one request type for both, since from
--    the requester's point of view it's the same action either way:
--    "capture the current plan as the official Baseline."
-- ---------------------------------------------------------------------
create table if not exists project_baseline_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade not null,
  requested_by uuid references people(id),
  requested_at timestamptz not null default now(),
  reason text,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_by uuid references people(id),
  decided_at timestamptz,
  decision_reason text,
  resulting_baseline_id uuid references project_baselines(id)
);
create unique index if not exists project_baseline_requests_one_pending_idx
  on project_baseline_requests(project_id) where status = 'pending';
create index if not exists project_baseline_requests_project_idx on project_baseline_requests(project_id);

alter table project_baseline_requests enable row level security;

create policy project_baseline_requests_select on project_baseline_requests for select
  using (can_see_project(project_id));
create policy project_baseline_requests_insert on project_baseline_requests for insert
  with check (exists (select 1 from projects pr where pr.id = project_id and (my_access_level() = 'full' or pr.owner_id = my_person_id())));
-- No client-side update policy -- decisions only ever happen through
-- decide_baseline_request (security definer), same convention as
-- project_closure_requests.

-- ---------------------------------------------------------------------
-- 2. Strict approval authorization -- Sandra's explicit choice: ONLY the
--    can_approve_rebaseline flag qualifies. Unlike can_decide_closure,
--    this deliberately does NOT also allow Full Access or the project
--    owner to self-approve -- a project with no one flagged simply has
--    no eligible approver yet, by design, until someone is flagged in
--    User Management.
-- ---------------------------------------------------------------------
create or replace function can_decide_baseline_request(p_request_id uuid) returns boolean
language sql stable security definer as $$
  select exists (select 1 from people me where me.id = my_person_id() and me.can_approve_rebaseline);
$$;

grant execute on function can_decide_baseline_request(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 3. request_baseline_approval -- Draft, Baseline Locked, or Changed
--    After Baseline -> a pending request. Requesting authority stays the
--    same as every other WBS workflow action (can_manage_wbs: Full
--    Access or the project's own owner) -- only the DECISION gets the
--    stricter can_approve_rebaseline-only gate.
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

-- ---------------------------------------------------------------------
-- 4. decide_baseline_request -- approve or reject. Approval branches on
--    the project's CURRENT status at decision time:
--      - draft: this is the first-ever baseline -- inlines the exact
--        same logic lock_wbs_baseline uses (skipping its own
--        can_manage_wbs check, since can_decide_baseline_request has
--        already authorized the caller with a stricter rule).
--      - baseline_locked / changed_after_baseline: this is a re-baseline.
--        If edits were made since the last baseline (an auto-opened
--        project_revisions row exists, see record_wbs_edit below), first
--        inlines apply_wbs_revision's exact diff/snapshot logic against
--        it so Revision History/Audit Trail keep their trail; then
--        always inlines rebaseline_wbs_plan's logic to promote the
--        latest plan version into the new official baseline and reset
--        status to baseline_locked. If nothing changed since the last
--        baseline (no open revision -- a plain re-affirm), skips
--        straight to the rebaseline step.
-- ---------------------------------------------------------------------
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
    -- Inlined lock_wbs_baseline logic (see phase2_migration.sql) --
    -- intentionally NOT calling can_manage_wbs here, since this whole
    -- function is already gated by the stricter can_decide_baseline_request.
    if p_mode not in ('full_capacity','standard') then
      raise exception 'invalid mode %', p_mode;
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

    update projects set wbs_status = 'baseline_locked', timelines_locked = true where id = v_project_id;

    update project_baseline_requests set status = 'approved', decided_by = my_person_id(), decided_at = now(),
      decision_reason = p_reason, resulting_baseline_id = v_baseline_id
      where id = p_request_id;

    return v_baseline_id;

  elsif v_project_status in ('baseline_locked','changed_after_baseline') then
    -- Re-baseline. First, if edits happened since the last baseline
    -- (record_wbs_edit auto-opened a revision), apply it -- inlined
    -- apply_wbs_revision logic, skipping its can_manage_wbs check for
    -- the same reason as above.
    select id, source_plan_version_id into v_open_revision_id, v_source_version_id
      from project_revisions where project_id = v_project_id and status = 'in_progress';

    if v_open_revision_id is not null then
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

    -- Always finish with the rebaseline_wbs_plan promote step -- whether
    -- or not there was an open revision to apply first.
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

    update projects set wbs_status = 'baseline_locked', timelines_locked = true where id = v_project_id;

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

-- ---------------------------------------------------------------------
-- 5. record_wbs_edit -- the mechanism that removes the manual "Start
--    Revision" click. Called by the client as part of Save whenever the
--    project is baseline_locked and there are actual field changes to
--    commit. No stricter permission than "can see this project" -- field
--    editability itself has never been permission-gated in this app
--    (canEditWbs was purely a wbs_status check, see WbsPlanning.tsx),
--    only the WORKFLOW actions (lock/request baseline/close) are. This
--    keeps that same shape: anyone who could already edit can trigger
--    this, it just silently opens a revision + flips status instead of
--    requiring a separate click first.
-- ---------------------------------------------------------------------
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
    -- Defensive: shouldn't happen if wbs_status is baseline_locked, but
    -- don't open a second one if it somehow does.
    update projects set wbs_status = 'changed_after_baseline' where id = p_project_id;
    return;
  end if;

  select id into v_source_version_id from project_plan_versions
    where project_id = p_project_id order by version_number desc limit 1;
  select coalesce(max(revision_number), 0) + 1 into v_revision_number from project_revisions where project_id = p_project_id;

  insert into project_revisions (project_id, revision_number, reason, status, source_plan_version_id, started_by)
  values (p_project_id, v_revision_number, 'Auto-opened on first edit after Baseline (Phase 6)', 'in_progress', v_source_version_id, my_person_id());

  update projects set wbs_status = 'changed_after_baseline', timelines_locked = false where id = p_project_id;
end;
$$;

grant execute on function record_wbs_edit(uuid) to authenticated;
