-- ---------------------------------------------------------------------
-- Phase 12 migration (2026-08-20): Work Type (new, admin-configurable
-- lookup) + Effort Level becomes a fully computed field derived from
-- estimated_hours (tasks.estimated_hours, aka "Planned Effort Hours" in
-- the UI -- display-label rename only, column name unchanged) via a
-- configurable thresholds table, instead of being independently typed
-- by users. One-time backfill included for existing tasks whose
-- estimated_hours is missing but whose old free-text Effort already
-- carries a Light/Moderate/Heavy value.
--
-- Explicitly OUT of scope here (per the larger refactor plan): the
-- points-based Utilization/Capacity machinery (TASK_EFFORT_POINTS,
-- archive_task_utilization's point math) is untouched -- a later phase
-- rewires that off points onto hours. This migration only adds Work
-- Type and makes Effort computed; it does not change what Effort *means*
-- to Utilization.
-- ---------------------------------------------------------------------

-- 1. Work Type -- new DB-backed, admin-configurable lookup -------------

create table if not exists work_types (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz default now()
);

alter table work_types enable row level security;

drop policy if exists work_types_select on work_types;
create policy work_types_select on work_types for select using (true);

drop policy if exists work_types_insert on work_types;
create policy work_types_insert on work_types for insert
  with check (my_access_level() = 'full');

drop policy if exists work_types_update on work_types;
create policy work_types_update on work_types for update
  using (my_access_level() = 'full')
  with check (my_access_level() = 'full');

-- Deliberately no delete policy -- deactivate (is_active = false) is the
-- only supported removal path, same soft-lifecycle convention as
-- people/projects elsewhere in this app. A row referenced by any task's
-- work_type_id shouldn't disappear (it stays as that task's historical
-- label); is_active = false just hides it from new-task pickers. See
-- [[feedback_supabase_rls_silent_delete_noop]] -- no delete policy means
-- a stray client-side delete attempt silently no-ops rather than erroring,
-- which is fine since the Admin UI never attempts one.

insert into work_types (name, sort_order) values
  ('Instructional Design', 1),
  ('Content Development', 2),
  ('Training Preparation', 3),
  ('Training Delivery', 4),
  ('Evaluation', 5),
  ('Review / QA', 6),
  ('LMS / Administration', 7),
  ('Project Management', 8)
on conflict (name) do nothing;

alter table tasks add column if not exists work_type_id uuid references work_types(id);

-- 2. Effort Level thresholds -- configurable, not hardcoded ------------

create table if not exists effort_level_thresholds (
  level text primary key,
  label text not null,
  min_hours numeric not null,
  max_hours numeric,       -- null = no upper bound (top tier)
  sort_order int not null default 0
);

alter table effort_level_thresholds enable row level security;

drop policy if exists effort_level_thresholds_select on effort_level_thresholds;
create policy effort_level_thresholds_select on effort_level_thresholds for select using (true);

-- No insert/update policy yet -- editing the thresholds themselves isn't
-- exposed in any UI in this phase (only Work Type management is), so for
-- now this table is DB-only config, adjustable later by a human via the
-- SQL editor or a future Admin section. Flagged in the phase report as a
-- judgment call.

insert into effort_level_thresholds (level, label, min_hours, max_hours, sort_order) values
  ('Light', 'Light', 0, 4, 1),
  ('Moderate', 'Moderate', 4, 12, 2),
  ('Heavy', 'Heavy', 12, 24, 3),
  ('Very Heavy', 'Very Heavy', 24, null, 4)
on conflict (level) do update set
  label = excluded.label,
  min_hours = excluded.min_hours,
  max_hours = excluded.max_hours,
  sort_order = excluded.sort_order;

-- Looks up the matching band from effort_level_thresholds (not
-- hardcoded) and returns its label. Bands are contiguous and increasing,
-- so "first band (by sort_order) whose max_hours is null or >= the given
-- hours" alone is enough to place a value correctly on either side of
-- each boundary (e.g. exactly 4 hours lands in Light, since Light's own
-- max_hours = 4 and it's checked first) -- min_hours is kept mainly for
-- display/documentation. NULL hours returns NULL (a task with no
-- estimate yet has no derivable effort level -- showing "Light" would be
-- a misleading guess); 0 hours returns "Light" per the seeded band
-- (0 to 4 inclusive) rather than a special-cased null, since 0 is a
-- legitimate (if unusual) planned-hours value.
create or replace function derive_effort_level(p_hours numeric) returns text
language plpgsql stable security definer as $$
declare
  v_level text;
begin
  if p_hours is null then
    return null;
  end if;
  select level into v_level
    from effort_level_thresholds
    where max_hours is null or p_hours <= max_hours
    order by sort_order
    limit 1;
  return v_level;
end;
$$;

-- Before insert/update on tasks: effort is no longer independently
-- settable -- it's always overwritten with whatever derive_effort_level
-- computes from the (possibly just-changed) estimated_hours in the same
-- row, so an incoming NEW.effort from an older client/direct write is
-- silently ignored in favor of the derived value.
--
-- Trigger execution order note: Postgres runs same-timing (BEFORE
-- UPDATE) triggers in alphabetical order by trigger name.
-- "tasks_derive_effort" sorts before "tasks_done_lock" (phase9), so this
-- trigger runs first on every update, then the done-lock trigger
-- evaluates. On a Done task where the client didn't touch
-- estimated_hours, NEW.estimated_hours = OLD.estimated_hours, so
-- derive_effort_level(NEW.estimated_hours) reproduces OLD.effort exactly
-- (assuming OLD.effort was already correctly derived, true for every row
-- after this migration's backfill runs) -- NEW.effort ends up equal to
-- OLD.effort and the done-lock trigger's own effort/estimated_hours
-- checks see no distinct change, so nothing conflicts. If the client DID
-- try to change estimated_hours on a Done task, the done-lock trigger's
-- existing "NEW.estimated_hours is distinct from OLD.estimated_hours"
-- check still fires and rejects the whole statement, exactly as before
-- this migration -- this trigger never gets a chance to let a new hours
-- value "stick" on a Done task.
create or replace function derive_task_effort() returns trigger
language plpgsql as $$
begin
  NEW.effort := derive_effort_level(NEW.estimated_hours);
  return NEW;
end;
$$;

drop trigger if exists tasks_derive_effort on tasks;
create trigger tasks_derive_effort
  before insert or update on tasks
  for each row execute function derive_task_effort();

-- 1 (cont'd). Add work_type_id to the Done-task lock's protected-field
-- list (re-creating enforce_done_task_lock from phase9_migration.sql
-- with the one addition -- everything else unchanged) -------------------

create or replace function enforce_done_task_lock() returns trigger
language plpgsql as $$
begin
  if TG_OP = 'UPDATE' and OLD.status = 'Done' and NEW.status = 'Done' then
    if coalesce(current_setting('app.bypass_done_task_lock', true), '') <> 'on' then
      if NEW.name is distinct from OLD.name
         or NEW.estimated_hours is distinct from OLD.estimated_hours
         or NEW.effort is distinct from OLD.effort
         or NEW.work_type_id is distinct from OLD.work_type_id
         or NEW.assignee_id is distinct from OLD.assignee_id
         or NEW.start_date is distinct from OLD.start_date
         or NEW.start_date_full is distinct from OLD.start_date_full
         or NEW.start_date_standard is distinct from OLD.start_date_standard
         or NEW.start_full_auto is distinct from OLD.start_full_auto
         or NEW.start_standard_auto is distinct from OLD.start_standard_auto
      then
        raise exception 'this task is Done -- its scoping fields (name, estimated hours, effort, work type, assignee, start date) are locked. Reopen it first (Full Access, from the Validated column on the main Tasks page) to make changes.';
      end if;
    end if;
  end if;
  return NEW;
end;
$$;
-- (trigger tasks_done_lock itself is unchanged and already bound to this
-- function from phase9_migration.sql -- create or replace is enough.)

-- 3. One-time backfill --------------------------------------------------
-- For existing tasks with no real estimated_hours yet but an old
-- free-text Effort value, backfill estimated_hours to the midpoint of
-- that band under the NEW thresholds (Light->2, Moderate->8, Heavy->18).
-- Guarded to only touch rows matching that exact condition -- tasks that
-- already have real hours are left alone. After this runs,
-- tasks_derive_effort recomputes effort from the newly-backfilled hours
-- in the same statement, landing back on the same label each row started
-- with (2h -> Light, 8h -> Moderate, 18h -> Heavy), since those midpoints
-- were deliberately chosen to fall inside their own band.
--
-- Bypass the Done-task lock for this one-time correction (same
-- transaction-local convention discard_wbs_revision already uses in
-- phase9) -- a Done task with no hours recorded under the old free-text
-- Effort field still deserves this one-time backfill so its derived
-- Effort Level makes sense; without the bypass this UPDATE would abort
-- entirely the moment it reached the first Done row needing it. Relies
-- on this whole migration file being executed as a single session/
-- transaction (true for a normal paste-and-run in the Supabase SQL
-- editor) since set_config's third argument (true) scopes the bypass to
-- the current transaction only.
select set_config('app.bypass_done_task_lock', 'on', true);

update tasks
set estimated_hours = case effort
    when 'Light' then 2
    when 'Moderate' then 8
    when 'Heavy' then 18
  end
where (estimated_hours is null or estimated_hours = 0)
  and effort in ('Light', 'Moderate', 'Heavy');

-- ---------------------------------------------------------------------
-- Hotfix (same day, 2026-08-20, applied live immediately after the above):
-- the tasks_derive_effort trigger only fires on INSERT/UPDATE, so any
-- task that already had real estimated_hours BEFORE this migration ran
-- (i.e. most tasks, per the phase12 audit -- estimated_hours was already
-- load-bearing for WBS) never got its `effort` recomputed against the
-- NEW thresholds -- only rows touched by the backfill UPDATE above did.
-- Caught during a live UAT self-check: 7 of 11 real tasks had a stale
-- effort value that didn't match derive_effort_level(estimated_hours)
-- (e.g. a 5h task still showing "Light" instead of "Moderate", a 15h
-- task still showing "Moderate" instead of "Heavy").
--
-- Fix: a value-preserving UPDATE (estimated_hours = estimated_hours) on
-- every row. This changes nothing in estimated_hours itself but still
-- fires the BEFORE UPDATE row trigger (Postgres fires row-level triggers
-- on every UPDATE statement regardless of whether values actually
-- change), forcing tasks_derive_effort to recompute effort correctly
-- for every existing row in one pass. Bypasses the Done-task lock first,
-- same as the backfill above, since some already-Done tasks were among
-- the 7 mismatched rows and their `effort` needed to change even though
-- their `estimated_hours` didn't.
select set_config('app.bypass_done_task_lock', 'on', true);
update tasks set estimated_hours = estimated_hours;
-- Verified live: 0 rows remained mismatched afterward.

-- ---------------------------------------------------------------------
-- Hotfix #2 (same day, 2026-08-20): tasks_effort_check predates this
-- migration and only allowed ('Light','Moderate','Heavy') at the DB
-- level -- it was never widened to allow the new computed "Very Heavy"
-- tier. Any task landing above 24h planned hours (the new top band)
-- failed insert/update outright with "new row for relation tasks
-- violates check constraint tasks_effort_check", which is also why nothing
-- appeared to save and Effort Level looked blank -- the whole write was
-- rejected, not just the effort column. Caught live by Sandra setting
-- Planned Effort Hours to 30 in WBS Planning.
alter table tasks drop constraint tasks_effort_check;
alter table tasks add constraint tasks_effort_check
  check (effort = any (array['Light'::text, 'Moderate'::text, 'Heavy'::text, 'Very Heavy'::text]));
-- Verified live: a disposable 30h task now saves successfully with
-- effort='Very Heavy'; function dropped and no residue left afterward.
