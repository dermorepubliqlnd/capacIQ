-- ---------------------------------------------------------------------
-- Phase 25 migration (2026-08-27): Audit Trail gap fix, re-baseline
-- removal regression.
--
-- Bug: 91ccc4f (WBS: rename Lock Baseline to Start Project, remove
-- Re-baseline flow) made canRequestBaseline draft-only, so
-- decide_baseline_request's re-baseline branch -- the ONLY place that
-- ever wrote project_revision_changes diff rows -- can now never be
-- invoked again after a project's first Start Project. Every edit made
-- to a project while baseline_locked/changed_after_baseline has been
-- silently missing from the Audit Trail ever since.
--
-- Fix: extract that same diff-computation (current task snapshot vs the
-- plan-version snapshot the open revision was opened against) into a
-- new overload of record_wbs_edit that the client now calls on every
-- Save while the project is baseline_locked/changed_after_baseline (not
-- just the one-time baseline_locked -> changed_after_baseline
-- transition it used to gate on). Since re-baselining is gone, a
-- revision can never be "applied" or closed out anymore either -- so
-- this recomputes the full diff against the ORIGINAL source plan
-- version fresh on every save (delete-then-reinsert), giving one
-- continuously-open "in_progress" project_revisions row per project
-- that always reflects the net change since Start Project. That's
-- exactly what AuditTrail.tsx already reads (it queries every revision
-- regardless of status, see its project_revisions select), so no
-- AuditTrail.tsx change is needed.
--
-- The existing single-arg record_wbs_edit(uuid) is left completely
-- untouched (still does exactly what it always did: idempotently open
-- the revision + flip wbs_status on the first edit after a lock) -- the
-- new 2-arg overload below calls it internally so that behavior isn't
-- duplicated, then adds the diff-write on top every time.
--
-- Not touched: Close Project flow, Start Project's own first-lock (still
-- writes no project_revision_changes rows, same as before -- there's
-- nothing to diff against on the very first lock), decide_baseline_request/
-- request_baseline_approval RPCs themselves (left in place, unreachable
-- from the UI by design per 91ccc4f, exactly as that commit intended).
-- ---------------------------------------------------------------------

create or replace function record_wbs_edit(p_project_id uuid, p_tasks jsonb)
returns void
language plpgsql security definer as $$
declare
  v_status text;
  v_open_revision_id uuid;
  v_source_version_id uuid;
  v_revision_number integer;
begin
  if not can_see_project(p_project_id) then
    raise exception 'not authorized';
  end if;

  -- Reuse the existing single-arg RPC's exact logic to idempotently open
  -- a revision + flip wbs_status the first time an edit lands after a
  -- lock. No-op if the project is already changed_after_baseline (an
  -- in_progress revision already exists) or isn't baseline_locked at all.
  perform record_wbs_edit(p_project_id);

  select wbs_status into v_status from projects where id = p_project_id;
  if v_status is null or v_status not in ('baseline_locked', 'changed_after_baseline') then
    -- draft/closed (or a lock that somehow didn't take) -- nothing to
    -- diff, same guard record_wbs_edit(uuid) itself already applies.
    return;
  end if;

  select id, source_plan_version_id into v_open_revision_id, v_source_version_id
    from project_revisions where project_id = p_project_id and status = 'in_progress';

  if v_open_revision_id is null then
    -- Defensive fallback for legacy data (a changed_after_baseline
    -- project with no open revision somehow) -- open one now against the
    -- latest plan version, mirroring record_wbs_edit(uuid)'s own insert.
    select id into v_source_version_id from project_plan_versions
      where project_id = p_project_id order by version_number desc limit 1;
    select coalesce(max(revision_number), 0) + 1 into v_revision_number from project_revisions where project_id = p_project_id;
    insert into project_revisions (project_id, revision_number, reason, status, source_plan_version_id, started_by)
    values (p_project_id, v_revision_number, 'Auto-opened on edit after Baseline (Phase 25 fallback)', 'in_progress', v_source_version_id, my_person_id())
    returning id into v_open_revision_id;
  end if;

  if v_source_version_id is null then
    -- Nothing to diff against (shouldn't happen once a baseline exists).
    return;
  end if;

  -- Recompute the full net diff since the open revision's source plan
  -- version, fresh, every save -- delete any previous auto-computed rows
  -- for this revision first so repeated saves don't pile up duplicates
  -- or leave stale entries for fields that got reverted.
  delete from project_revision_changes where revision_id = v_open_revision_id;

  -- Identical comparison/insert logic to decide_baseline_request's
  -- re-baseline branch (phase16_migration.sql) -- same 6 change_type
  -- categories, same field/previous_value/new_value shape, just pointed
  -- at p_tasks (the live client snapshot passed at Save time) instead of
  -- the p_tasks passed at baseline-approval time.
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
end;
$$;

grant execute on function record_wbs_edit(uuid, jsonb) to authenticated;
