-- ---------------------------------------------------------------------
-- Phase 9 migration (2026-08-20): DB-level Done-task lock + fix
-- discard_wbs_revision's missing archive step for deleted time entries.
--
-- Follow-on to the 2026-08-20 quality/guardrails review. Two gaps found:
--
-- 1. WBS Planning's own UI locks every field on a Done task
--    (`rowLocked = t.status === "Done"` in WbsPlanning.tsx) but nothing
--    enforced that at the database layer -- a direct write (stray API
--    call, a future bug, anything bypassing the WBS screen) could still
--    silently mutate a Done task's estimated_hours/effort/assignee/start
--    dates with nothing to stop or flag it. Since trustworthy
--    baseline-vs-actual reporting is this tool's whole reason for
--    existing, this is now enforced with a real trigger, mirroring the
--    existing enforce_due_date_lock/enforce_project_date_lock pattern
--    (bypass via a transaction-local `app.bypass_done_task_lock` flag,
--    same convention as `app.bypass_due_date_lock`).
--
--    Deliberately does NOT lock status itself, or validated_completion_date/
--    validated_by/submitted_on/submitted_by (Projects.tsx's Reopen action
--    changes status away from "Done" in the same statement that clears
--    validation -- since NEW.status is no longer 'Done' in that update,
--    it passes through untouched, exactly like the existing due-date-lock
--    trigger lets an approved extension request through). Also does NOT
--    duplicate current_due_date's governance -- that already has its own
--    dedicated, independently-correct lock (enforce_due_date_lock, gated
--    on the project's timelines_locked flag + extension approval) which
--    this shouldn't complicate further.
--
-- 2. discard_wbs_revision hard-deletes tasks that were added during a
--    now-discarded revision, but (unlike delete_tasks_and_dependents)
--    never archived their Utilization/Spent-Hrs contribution first --
--    real hours logged against such a task before the revision was
--    discarded would simply vanish with no trace. Fixed by calling the
--    same archive_task_utilization used everywhere else, for exactly the
--    set of tasks about to be deleted, before deleting them.
--
--    Also: discard_wbs_revision's "restore edited tasks back to the
--    snapshot" step legitimately needs to revert a Done task's fields
--    back to the pre-revision baseline if that task was edited (while not
--    yet Done) earlier in the same revision and only marked Done
--    afterward -- undoing the whole revision should undo that too. This
--    is exactly the kind of controlled, audited correction path the new
--    Done-task lock's bypass flag exists for, so this function now sets
--    it locally before that restore step.
-- ---------------------------------------------------------------------

-- 1. DB-level Done-task lock ------------------------------------------

create or replace function enforce_done_task_lock() returns trigger
language plpgsql as $$
begin
  if TG_OP = 'UPDATE' and OLD.status = 'Done' and NEW.status = 'Done' then
    if coalesce(current_setting('app.bypass_done_task_lock', true), '') <> 'on' then
      if NEW.name is distinct from OLD.name
         or NEW.estimated_hours is distinct from OLD.estimated_hours
         or NEW.effort is distinct from OLD.effort
         or NEW.assignee_id is distinct from OLD.assignee_id
         or NEW.start_date is distinct from OLD.start_date
         or NEW.start_date_full is distinct from OLD.start_date_full
         or NEW.start_date_standard is distinct from OLD.start_date_standard
         or NEW.start_full_auto is distinct from OLD.start_full_auto
         or NEW.start_standard_auto is distinct from OLD.start_standard_auto
      then
        raise exception 'this task is Done -- its scoping fields (name, estimated hours, effort, assignee, start date) are locked. Reopen it first (Full Access, from the Validated column on the main Tasks page) to make changes.';
      end if;
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists tasks_done_lock on tasks;
create trigger tasks_done_lock
  before update on tasks
  for each row execute function enforce_done_task_lock();

-- 2. discard_wbs_revision: archive time entries + bypass the new lock
--    for its own legitimate restore-to-snapshot step -----------------

create or replace function discard_wbs_revision(p_revision_id uuid)
returns void
language plpgsql security definer as $$
declare
  v_project_id uuid;
  v_status text;
  v_source_version_id uuid;
  v_prior_status text;
  v_added_task_ids uuid[];
  tid uuid;
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

  -- This function legitimately needs to revert a Done task's own fields
  -- back to the pre-revision snapshot below (a task can be edited earlier
  -- in a revision, then marked Done, before the whole revision is
  -- discarded) -- set the bypass for the rest of this transaction only.
  perform set_config('app.bypass_done_task_lock', 'on', true);

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

  -- Tasks added during this revision (not in the source snapshot at all)
  -- get hard-deleted below -- archive their Utilization/Spent-Hrs
  -- contribution first, same as delete_tasks_and_dependents, so real
  -- hours logged against one of them don't just vanish.
  select array_agg(tk.id) into v_added_task_ids
    from tasks tk
    where tk.project_id = v_project_id
      and not exists (select 1 from project_plan_version_tasks o where o.plan_version_id = v_source_version_id and o.task_id = tk.id);

  if v_added_task_ids is not null then
    foreach tid in array v_added_task_ids loop
      perform archive_task_utilization(tid);
    end loop;
  end if;

  -- Hard-delete tasks that were added during this revision -- clear
  -- every dependent table first (same five tables
  -- delete_tasks_and_dependents clears).
  delete from task_dependencies where task_id = any(v_added_task_ids) or depends_on_task_id = any(v_added_task_ids);
  delete from extension_requests where task_id = any(v_added_task_ids);
  delete from task_effort_changes where task_id = any(v_added_task_ids);
  delete from time_entries where task_id = any(v_added_task_ids);
  delete from task_collaborators where task_id = any(v_added_task_ids);
  delete from task_planning_snapshots where task_id = any(v_added_task_ids);
  delete from tasks where id = any(v_added_task_ids);

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
