-- ---------------------------------------------------------------------
-- Phase 7 migration (2026-07-29): fix discard_wbs_revision's missing
-- dependent-table cleanup before hard-deleting tasks added during a
-- revision.
--
-- Live bug (Sandra, 2026-07-29): clicking "Discard Revision" on a
-- revision that had added a task with an Effort value failed with
-- "update or delete on table tasks violates foreign key constraint
-- task_effort_changes_task_id_fkey on table task_effort_changes".
--
-- Root cause: this is the EXACT same class of bug already documented
-- and fixed once before for delete_tasks_and_dependents (see
-- policies.sql's "Migration 2026-07-23: delete_tasks_and_dependents RPC"
-- comment) -- extension_requests, task_effort_changes, time_entries,
-- task_collaborators, and task_planning_snapshots all have a
-- task_id foreign key with no ON DELETE CASCADE, and a plain
-- `delete from tasks` fails if any of those tables still hold a row
-- for that task. discard_wbs_revision (written in Phase 2) only ever
-- cleared task_dependencies before its own `delete from tasks` for
-- tasks added mid-revision -- it never got the same fix.
--
-- Fix: clear all five dependent tables (task_dependencies plus the four
-- delete_tasks_and_dependents already knows about, plus
-- task_planning_snapshots) for exactly the set of tasks about to be
-- hard-deleted, before deleting them.
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
  -- source snapshot at all) -- clear every dependent table first (same
  -- five tables delete_tasks_and_dependents clears), not just
  -- task_dependencies as before.
  delete from task_dependencies where task_id in (
    select tk.id from tasks tk
    where tk.project_id = v_project_id
      and not exists (select 1 from project_plan_version_tasks o where o.plan_version_id = v_source_version_id and o.task_id = tk.id)
  ) or depends_on_task_id in (
    select tk.id from tasks tk
    where tk.project_id = v_project_id
      and not exists (select 1 from project_plan_version_tasks o where o.plan_version_id = v_source_version_id and o.task_id = tk.id)
  );
  delete from extension_requests where task_id in (
    select tk.id from tasks tk
    where tk.project_id = v_project_id
      and not exists (select 1 from project_plan_version_tasks o where o.plan_version_id = v_source_version_id and o.task_id = tk.id)
  );
  delete from task_effort_changes where task_id in (
    select tk.id from tasks tk
    where tk.project_id = v_project_id
      and not exists (select 1 from project_plan_version_tasks o where o.plan_version_id = v_source_version_id and o.task_id = tk.id)
  );
  delete from time_entries where task_id in (
    select tk.id from tasks tk
    where tk.project_id = v_project_id
      and not exists (select 1 from project_plan_version_tasks o where o.plan_version_id = v_source_version_id and o.task_id = tk.id)
  );
  delete from task_collaborators where task_id in (
    select tk.id from tasks tk
    where tk.project_id = v_project_id
      and not exists (select 1 from project_plan_version_tasks o where o.plan_version_id = v_source_version_id and o.task_id = tk.id)
  );
  delete from task_planning_snapshots where task_id in (
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
