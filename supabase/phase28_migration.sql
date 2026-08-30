-- Phase 28 (2026-08-31) -- scheduling-engine audit, Fix 3.
--
-- `task_dependencies` had only a self-dependency CHECK
-- (task_dependencies_no_self_dep, policies.sql). The WBS page's own guard
-- was direct-pairs only ("does B already depend on A?"), so A -> B -> C -> A
-- was accepted by both. The reactive dependency auto-pilot effect then
-- pushed every Start in the cycle monotonically forward on each commit and
-- never converged -- React "Maximum update depth exceeded", i.e. a hard
-- page hang on a production project, unrecoverable from the UI.
--
-- WbsPlanning.tsx now walks the full transitive closure before inserting.
-- This trigger is the authoritative backstop so no other path (a future
-- screen, a bulk import, a hand-written SQL statement) can reintroduce one.
--
-- The recursive CTE uses UNION (not UNION ALL) so it terminates even if a
-- cycle somehow already exists in the table.

create or replace function enforce_no_dependency_cycle()
returns trigger
language plpgsql
as $$
declare
  v_cycle boolean;
begin
  if new.task_id = new.depends_on_task_id then
    raise exception 'A task cannot depend on itself.';
  end if;

  with recursive reach(id) as (
    select new.depends_on_task_id
    union
    select d.depends_on_task_id
      from task_dependencies d
      join reach r on d.task_id = r.id
  )
  select exists (select 1 from reach where id = new.task_id) into v_cycle;

  if v_cycle then
    raise exception 'Circular dependency: that task already depends on this one, directly or through a chain.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_no_dependency_cycle on task_dependencies;
create trigger trg_no_dependency_cycle
  before insert or update on task_dependencies
  for each row execute function enforce_no_dependency_cycle();
