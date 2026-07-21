-- Row Level Security policies for CapacIQ (Section 8 of the brief:
-- Full Access = Director + Managers/Supervisors, Standard = everyone else,
-- scoped to projects they own or collaborate on).
-- Run this AFTER schema.sql, once Supabase Auth users exist.

alter table people add column if not exists auth_user_id uuid unique references auth.users(id);

create or replace function my_person_id() returns uuid
language sql stable security definer as $$
  select id from people where auth_user_id = auth.uid()
$$;

create or replace function my_access_level() returns text
language sql stable security definer as $$
  select access_level from people where auth_user_id = auth.uid()
$$;

create or replace function can_see_project(p_project_id uuid) returns boolean
language sql stable security definer as $$
  select
    my_access_level() = 'full'
    or exists (select 1 from projects where id = p_project_id and owner_id = my_person_id())
    or exists (
      select 1 from tasks t
      left join task_collaborators tc on tc.task_id = t.id
      where t.project_id = p_project_id
        and (t.assignee_id = my_person_id() or tc.person_id = my_person_id())
    )
$$;

alter table people enable row level security;
alter table projects enable row level security;
alter table tasks enable row level security;
alter table task_collaborators enable row level security;
alter table extension_requests enable row level security;
alter table utilization_snapshots enable row level security;

create policy people_select on people for select using (true);

create policy projects_select on projects for select
  using (can_see_project(id));

create policy tasks_select on tasks for select
  using (can_see_project(project_id));

create policy task_collaborators_select on task_collaborators for select
  using (can_see_project((select project_id from tasks where id = task_id)));

create policy extension_requests_select on extension_requests for select
  using (
    my_access_level() = 'full'
    or requested_by = my_person_id()
    or exists (select 1 from tasks where id = task_id and assignee_id = my_person_id())
    or exists (select 1 from people where id = requested_by and reports_to = my_person_id())
  );

create policy extension_requests_update on extension_requests for update
  using (
    my_access_level() = 'full'
    or exists (select 1 from people where id = requested_by and reports_to = my_person_id())
  );

create policy extension_requests_insert on extension_requests for insert
  with check (requested_by = my_person_id() or my_access_level() = 'full');

create policy utilization_select on utilization_snapshots for select
  using (my_access_level() = 'full' or person_id = my_person_id());

-- Soft-deactivation: is_active gates all RLS access without needing an
-- auth-level lockout. Added when User Management/Admin was built (Phase:
-- Admin panel) so deactivating a person instantly revokes data access.
alter table people add column if not exists is_active boolean not null default true;

create or replace function my_person_id() returns uuid
language sql stable security definer as $$
  select id from people where auth_user_id = auth.uid() and is_active = true
$$;

create or replace function my_access_level() returns text
language sql stable security definer as $$
  select access_level from people where auth_user_id = auth.uid() and is_active = true
$$;

create policy people_update on people for update
  using (my_access_level() = 'full')
  with check (my_access_level() = 'full');

-- Write access for Projects & Tasks (added when building the real
-- Projects/Tasks list pages). Full Access can create/edit anything;
-- a project owner can edit their own project and add tasks to it;
-- a task's assignee can update their own task (e.g. status, hours logged).
create policy projects_insert on projects for insert
  with check (my_access_level() = 'full');

create policy projects_update on projects for update
  using (my_access_level() = 'full' or owner_id = my_person_id())
  with check (my_access_level() = 'full' or owner_id = my_person_id());

create policy tasks_insert on tasks for insert
  with check (
    my_access_level() = 'full'
    or exists (select 1 from projects where id = project_id and owner_id = my_person_id())
  );

create policy tasks_update on tasks for update
  using (
    my_access_level() = 'full'
    or exists (select 1 from projects where id = project_id and owner_id = my_person_id())
    or assignee_id = my_person_id()
  )
  with check (
    my_access_level() = 'full'
    or exists (select 1 from projects where id = project_id and owner_id = my_person_id())
    or assignee_id = my_person_id()
  );

-- Sub-tasking (2 levels beneath a top-level task, mirrors Notion's
-- Parent-task/Sub-tasks relation) + tightening project_id to required,
-- since every task must belong to exactly one project (no orphan tasks).
alter table tasks add column if not exists parent_task_id uuid references tasks(id);
alter table tasks alter column project_id set not null;

-- Archive/restore for Projects & Tasks (soft-delete): archived items drop out
-- of the main table immediately but stay recoverable for 30 days via a
-- "View archived" panel, then get purged for good. Archiving is gated to
-- the same people who can edit the row (project owner or Full Access) --
-- notably NOT a task's assignee, since making a task disappear from the
-- project owner's view is a bigger action than editing your own task.
alter table projects add column if not exists is_archived boolean not null default false;
alter table projects add column if not exists archived_at timestamptz;
alter table tasks add column if not exists is_archived boolean not null default false;
alter table tasks add column if not exists archived_at timestamptz;

create policy projects_delete on projects for delete
  using (my_access_level() = 'full' or owner_id = my_person_id());

create policy tasks_delete on tasks for delete
  using (
    my_access_level() = 'full'
    or exists (select 1 from projects where id = project_id and owner_id = my_person_id())
  );
-- Extension Requests: approval authority + due-date lock (2026-07-17)
-- Approval model: the project owner decides by default; if the owner is
-- the one requesting (their own task), it escalates to the owner's
-- manager (people.reports_to) instead, so nobody approves their own
-- request. Full Access can always decide, as an override.

create or replace function can_decide_extension(p_request_id uuid) returns boolean
language sql stable security definer as $$
  select
    my_access_level() = 'full'
    or exists (
      select 1
      from extension_requests er
      join tasks t on t.id = er.task_id
      join projects pr on pr.id = t.project_id
      left join people owner on owner.id = pr.owner_id
      where er.id = p_request_id
        and (
          (pr.owner_id = my_person_id() and er.requested_by <> pr.owner_id)
          or (er.requested_by = pr.owner_id and owner.reports_to = my_person_id())
        )
    )
$$;

grant execute on function can_decide_extension(uuid) to authenticated;

-- Project owners need to see requests for their project's tasks even
-- when they're neither the requester, the assignee, nor the requester's
-- manager -- the original brief's select policy missed this case.
drop policy if exists extension_requests_select on extension_requests;
create policy extension_requests_select on extension_requests for select
  using (
    my_access_level() = 'full'
    or requested_by = my_person_id()
    or exists (select 1 from tasks where id = task_id and assignee_id = my_person_id())
    or exists (select 1 from people where id = requested_by and reports_to = my_person_id())
    or exists (
      select 1 from tasks t join projects pr on pr.id = t.project_id
      where t.id = task_id and pr.owner_id = my_person_id()
    )
  );

drop policy if exists extension_requests_update on extension_requests;
create policy extension_requests_update on extension_requests for update
  using (can_decide_extension(id))
  with check (can_decide_extension(id));

-- Due-date lock: current_due_date can only change via decide_extension_request
-- or request_and_approve_extension below (both flip a transaction-local flag
-- before writing). Any other path -- inline edits, direct SQL, a stray API
-- call -- gets rejected, so the extension trail can't be silently bypassed.
create or replace function enforce_due_date_lock() returns trigger
language plpgsql as $$
begin
  if NEW.current_due_date is distinct from OLD.current_due_date then
    if coalesce(current_setting('app.bypass_due_date_lock', true), '') <> 'on' then
      raise exception 'current_due_date can only be changed via an approved extension request';
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists tasks_due_date_lock on tasks;
create trigger tasks_due_date_lock
  before update on tasks
  for each row execute function enforce_due_date_lock();

-- Approve/reject a pending request. On approval, writes the task's
-- current_due_date in the same transaction as the decision.
create or replace function decide_extension_request(
  p_request_id uuid,
  p_status text,
  p_decision_notes text default null
) returns void
language plpgsql security definer as $$
declare
  v_task_id uuid;
  v_new_due_date date;
  v_current_status text;
begin
  if p_status not in ('Approved','Rejected') then
    raise exception 'invalid status: %', p_status;
  end if;

  if not can_decide_extension(p_request_id) then
    raise exception 'not authorized to decide this extension request';
  end if;

  select task_id, requested_new_due_date, status
    into v_task_id, v_new_due_date, v_current_status
    from extension_requests where id = p_request_id;

  if v_task_id is null then
    raise exception 'extension request not found';
  end if;
  if v_current_status <> 'Pending' then
    raise exception 'this request has already been decided';
  end if;

  update extension_requests
    set status = p_status,
        decided_by = my_person_id(),
        decided_at = now(),
        decision_notes = p_decision_notes
    where id = p_request_id;

  if p_status = 'Approved' then
    perform set_config('app.bypass_due_date_lock', 'on', true);
    update tasks set current_due_date = v_new_due_date where id = v_task_id;
  end if;
end;
$$;

grant execute on function decide_extension_request(uuid, text, text) to authenticated;

-- Convenience for a project owner (or Full Access) making a quick,
-- already-decided correction -- still goes through extension_requests
-- (is_manager_initiated = true, auto-Approved) so there's still a full
-- audit trail; there is no raw bypass of the lock anywhere in the system.
create or replace function request_and_approve_extension(
  p_task_id uuid,
  p_new_due_date date,
  p_reason_category text,
  p_reason_notes text
) returns uuid
language plpgsql security definer as $$
declare
  v_request_id uuid;
  v_can boolean;
begin
  select
    my_access_level() = 'full'
    or exists (
      select 1 from tasks t join projects pr on pr.id = t.project_id
      where t.id = p_task_id and pr.owner_id = my_person_id()
    )
  into v_can;

  if not v_can then
    raise exception 'not authorized to directly set this task''s due date';
  end if;

  insert into extension_requests
    (task_id, requested_by, requested_new_due_date, reason_category, reason_notes, status, is_manager_initiated, decided_by, decided_at)
  values
    (p_task_id, my_person_id(), p_new_due_date, p_reason_category, p_reason_notes, 'Approved', true, my_person_id(), now())
  returning id into v_request_id;

  perform set_config('app.bypass_due_date_lock', 'on', true);
  update tasks set current_due_date = p_new_due_date where id = p_task_id;

  return v_request_id;
end;
$$;

grant execute on function request_and_approve_extension(uuid, date, text, text) to authenticated;

-- Migration 2026-07-21: project-level timeline governance
--
-- Backfills two pieces that were built live in an earlier session but never
-- appended to this file (a real gap found while writing this migration --
-- projects.timelines_locked and set_project_timelines_locked existed in
-- the live DB with no record here): both are included below via
-- idempotent add-column-if-not-exists / create-or-replace-function so
-- re-running this file is safe.
--
-- New in this migration:
--   1. projects.original_start_date / original_due_date -- a frozen
--      baseline stamped once at Lock time, mirroring tasks.original_due_date.
--   2. set_project_timelines_locked now also stamps the project's own
--      baseline at lock, and -- the real behavior change -- an owner can no
--      longer self-service unlock a committed project. Locking stays
--      self-service (a one-way commitment, low stakes); unlocking now
--      requires either Full Access, or an approved Project Extension
--      Request (via the new decide_project_extension_request, which flips
--      a bypass flag to perform the unlock internally).
--   3. A projects-table trigger (enforce_project_date_lock) enforces the
--      same "can't change without the bypass flag" rule at the DB level
--      for start_date/end_date once locked -- parity with tasks' existing
--      enforce_due_date_lock, not just an app-level gate.
--   4. tasks_due_date_lock now also fires on INSERT, not just UPDATE, so a
--      brand-new task can't be inserted (e.g. via direct API/SQL, bypassing
--      the app's own within-envelope default) with a due date beyond the
--      project's committed end_date while locked, with no extension trail
--      at all.
--   5. extension_requests.task_id is now nullable, with a new nullable
--      project_id -- exactly one of the two must be set. Project-level
--      requests ALWAYS escalate to the project owner's manager (or Full
--      Access); unlike task-level requests, there is no "owner decides"
--      path at all, since a project owner extending their own project's
--      deadline is structurally the self-request case task-level extensions
--      already force to escalate.
--   6. task_effort_changes: a lightweight, trigger-written audit log (not a
--      lock) -- effort-level corrections don't need approval the way due
--      dates do (it's an estimate, not an external commitment), but they
--      should be visible when they happen.

-- 1 & 2 -------------------------------------------------------------------

alter table projects add column if not exists original_start_date date;
alter table projects add column if not exists original_due_date date;

create or replace function set_project_timelines_locked(p_project_id uuid, p_locked boolean) returns void
language plpgsql security definer as $$
declare
  v_is_full boolean;
  v_is_owner boolean;
  v_currently_locked boolean;
begin
  select my_access_level() = 'full' into v_is_full;
  select exists (select 1 from projects where id = p_project_id and owner_id = my_person_id()) into v_is_owner;
  select timelines_locked into v_currently_locked from projects where id = p_project_id;

  if not (coalesce(v_is_full, false) or coalesce(v_is_owner, false)) then
    raise exception 'not authorized to lock or unlock this project''s timelines';
  end if;

  if coalesce(v_currently_locked, false) and not p_locked and not coalesce(v_is_full, false)
     and coalesce(current_setting('app.bypass_timelines_lock_governance', true), '') <> 'on' then
    raise exception 'unlocking a committed project requires an approved timeline extension request';
  end if;

  if p_locked then
    update tasks set original_due_date = current_due_date where project_id = p_project_id;
    update projects set original_start_date = start_date, original_due_date = end_date where id = p_project_id;
  end if;

  update projects set timelines_locked = p_locked where id = p_project_id;
end;
$$;

grant execute on function set_project_timelines_locked(uuid, boolean) to authenticated;

-- 3 -------------------------------------------------------------------

create or replace function enforce_project_date_lock() returns trigger
language plpgsql as $$
begin
  if (NEW.start_date is distinct from OLD.start_date or NEW.end_date is distinct from OLD.end_date)
     and coalesce(OLD.timelines_locked, false)
     and coalesce(current_setting('app.bypass_timelines_lock_governance', true), '') <> 'on' then
    raise exception 'project start/end date can only change via an approved timeline extension request once timelines are locked';
  end if;
  return NEW;
end;
$$;

drop trigger if exists projects_date_lock on projects;
create trigger projects_date_lock
  before update on projects
  for each row execute function enforce_project_date_lock();

-- 4 -------------------------------------------------------------------

create or replace function enforce_due_date_lock() returns trigger
language plpgsql as $$
declare
  v_locked boolean;
  v_project_end_date date;
begin
  if TG_OP = 'UPDATE' and NEW.current_due_date is distinct from OLD.current_due_date then
    if coalesce(current_setting('app.bypass_due_date_lock', true), '') <> 'on' then
      select timelines_locked into v_locked from projects where id = NEW.project_id;
      if coalesce(v_locked, false) then
        raise exception 'current_due_date can only be changed via an approved extension request';
      end if;
    end if;
  end if;

  if TG_OP = 'INSERT' then
    if coalesce(current_setting('app.bypass_due_date_lock', true), '') <> 'on' then
      select timelines_locked, end_date into v_locked, v_project_end_date from projects where id = NEW.project_id;
      if coalesce(v_locked, false) and v_project_end_date is not null and NEW.current_due_date > v_project_end_date then
        raise exception 'new task due date is beyond the project''s locked timeline -- request a timeline extension first, or set an earlier due date';
      end if;
    end if;
  end if;

  return NEW;
end;
$$;

drop trigger if exists tasks_due_date_lock on tasks;
create trigger tasks_due_date_lock
  before insert or update on tasks
  for each row execute function enforce_due_date_lock();

-- 5 -------------------------------------------------------------------

alter table extension_requests alter column task_id drop not null;
alter table extension_requests add column if not exists project_id uuid references projects(id);
alter table extension_requests drop constraint if exists extension_requests_task_xor_project;
alter table extension_requests add constraint extension_requests_task_xor_project
  check ((task_id is not null and project_id is null) or (task_id is null and project_id is not null));

create or replace function can_decide_extension(p_request_id uuid) returns boolean
language sql stable security definer as $$
  select
    my_access_level() = 'full'
    or exists (
      select 1
      from extension_requests er
      join tasks t on t.id = er.task_id
      join projects pr on pr.id = t.project_id
      left join people owner on owner.id = pr.owner_id
      where er.id = p_request_id
        and er.task_id is not null
        and (
          (pr.owner_id = my_person_id() and er.requested_by <> pr.owner_id)
          or (er.requested_by = pr.owner_id and owner.reports_to = my_person_id())
        )
    )
    or exists (
      select 1
      from extension_requests er
      join projects pr on pr.id = er.project_id
      left join people owner on owner.id = pr.owner_id
      where er.id = p_request_id
        and er.project_id is not null
        and owner.reports_to = my_person_id()
    )
$$;

grant execute on function can_decide_extension(uuid) to authenticated;

drop policy if exists extension_requests_select on extension_requests;
create policy extension_requests_select on extension_requests for select
  using (
    my_access_level() = 'full'
    or requested_by = my_person_id()
    or (task_id is not null and exists (select 1 from tasks where id = task_id and assignee_id = my_person_id()))
    or exists (select 1 from people where id = requested_by and reports_to = my_person_id())
    or (task_id is not null and exists (
      select 1 from tasks t join projects pr on pr.id = t.project_id
      where t.id = extension_requests.task_id and pr.owner_id = my_person_id()
    ))
    or (project_id is not null and exists (
      select 1 from projects pr where pr.id = extension_requests.project_id and pr.owner_id = my_person_id()
    ))
  );

drop policy if exists extension_requests_update on extension_requests;
create policy extension_requests_update on extension_requests for update
  using (can_decide_extension(id))
  with check (can_decide_extension(id));

create or replace function decide_project_extension_request(
  p_request_id uuid,
  p_status text,
  p_decision_notes text default null
) returns void
language plpgsql security definer as $$
declare
  v_project_id uuid;
  v_new_due_date date;
  v_current_status text;
begin
  if p_status not in ('Approved','Rejected') then
    raise exception 'invalid status: %', p_status;
  end if;

  if not can_decide_extension(p_request_id) then
    raise exception 'not authorized to decide this extension request';
  end if;

  select project_id, requested_new_due_date, status
    into v_project_id, v_new_due_date, v_current_status
    from extension_requests where id = p_request_id and project_id is not null;

  if v_project_id is null then
    raise exception 'project extension request not found';
  end if;
  if v_current_status <> 'Pending' then
    raise exception 'this request has already been decided';
  end if;

  update extension_requests
    set status = p_status,
        decided_by = my_person_id(),
        decided_at = now(),
        decision_notes = p_decision_notes
    where id = p_request_id;

  if p_status = 'Approved' then
    perform set_config('app.bypass_timelines_lock_governance', 'on', true);
    update projects set end_date = v_new_due_date where id = v_project_id;
  end if;
end;
$$;

grant execute on function decide_project_extension_request(uuid, text, text) to authenticated;

-- 6 -------------------------------------------------------------------

create table if not exists task_effort_changes (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references tasks(id) not null,
  changed_by uuid references people(id),
  changed_at timestamptz not null default now(),
  previous_effort text,
  new_effort text not null
);

alter table task_effort_changes enable row level security;

drop policy if exists task_effort_changes_select on task_effort_changes;
create policy task_effort_changes_select on task_effort_changes for select
  using (exists (select 1 from tasks where id = task_id and can_see_project(project_id)));

create or replace function log_task_effort_change() returns trigger
language plpgsql security definer as $$
begin
  if NEW.effort is distinct from OLD.effort then
    insert into task_effort_changes (task_id, changed_by, previous_effort, new_effort)
    values (NEW.id, my_person_id(), OLD.effort, NEW.effort);
  end if;
  return NEW;
end;
$$;

drop trigger if exists tasks_effort_change_log on tasks;
create trigger tasks_effort_change_log
  after update on tasks
  for each row execute function log_task_effort_change();
-- Migration 2026-07-21b: Task Timer / Time Tracking
--
-- New feature: a per-task start/stop time clock. Design (agreed live with
-- Sandra): one running timer per person globally; stopping opens an
-- immediate confirm/edit-once step, then the entry is locked; manual
-- entries (logged after the fact) always require approval via the same
-- owner-decides / self-request-escalates-to-manager rule as extension
-- requests; idle timers auto-stop after a configurable threshold (default
-- 4h) and land back in the confirm step flagged "auto-stopped"; Full
-- Access can correct an already-confirmed/approved entry, with the
-- original value preserved so the correction is never silent; Spent Hrs
-- becomes fully computed from confirmed/approved/legacy entries instead of
-- being directly typed, with existing values preserved as one frozen
-- "legacy" baseline entry per task; time tracking gets its own dedicated
-- log, separate from Extension Requests.

-- 1. Core table -------------------------------------------------------------

create table if not exists time_entries (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references tasks(id) not null,
  person_id uuid references people(id) not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  duration_minutes numeric,
  source text not null check (source in ('timer','manual','legacy')),
  status text not null check (status in ('running','pending_confirm','confirmed','pending_approval','approved','rejected')),
  requested_by uuid references people(id),
  reason_notes text,
  auto_stopped boolean not null default false,
  confirmed_at timestamptz,
  decided_by uuid references people(id),
  decided_at timestamptz,
  decision_notes text,
  corrected_by uuid references people(id),
  corrected_at timestamptz,
  original_duration_minutes numeric,
  correction_notes text,
  created_at timestamptz not null default now()
);

create unique index if not exists one_running_timer_per_person
  on time_entries(person_id) where status = 'running';

create index if not exists time_entries_task_idx on time_entries(task_id);
create index if not exists time_entries_person_idx on time_entries(person_id);

alter table time_entries enable row level security;

create policy time_entries_select on time_entries for select
  using (
    my_access_level() = 'full'
    or person_id = my_person_id()
    or requested_by = my_person_id()
    or exists (
      select 1 from tasks t join projects pr on pr.id = t.project_id
      where t.id = time_entries.task_id and pr.owner_id = my_person_id()
    )
    or exists (select 1 from people where id = person_id and reports_to = my_person_id())
  );

create policy time_entries_insert on time_entries for insert
  with check (my_access_level() = 'full' or person_id = my_person_id());

create policy time_entries_update on time_entries for update
  using (my_access_level() = 'full' or person_id = my_person_id())
  with check (my_access_level() = 'full' or person_id = my_person_id());

-- A confirmed/approved/rejected entry is finalized. Any further change
-- (other than through correct_time_entry, which flips the bypass flag)
-- gets rejected -- same lock pattern as tasks_due_date_lock.
create or replace function enforce_time_entry_lock() returns trigger
language plpgsql as $$
begin
  if OLD.status in ('confirmed','approved','rejected') then
    if coalesce(current_setting('app.bypass_time_entry_lock', true), '') <> 'on' then
      raise exception 'this time entry is finalized -- use a correction instead of editing it directly';
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists time_entries_lock on time_entries;
create trigger time_entries_lock
  before update on time_entries
  for each row execute function enforce_time_entry_lock();

-- 2. Settings (idle auto-stop threshold, configurable not hardcoded) --------

create table if not exists app_settings (
  id boolean primary key default true check (id),
  idle_timeout_minutes int not null default 240
);

insert into app_settings (id, idle_timeout_minutes) values (true, 240) on conflict (id) do nothing;

alter table app_settings enable row level security;

create policy app_settings_select on app_settings for select using (true);

create policy app_settings_update on app_settings for update
  using (my_access_level() = 'full')
  with check (my_access_level() = 'full');

-- 3. Start / stop / confirm --------------------------------------------------

create or replace function start_timer(p_task_id uuid) returns uuid
language plpgsql security definer as $$
declare
  v_assignee uuid;
  v_archived boolean;
  v_existing_task_id uuid;
  v_existing_task_name text;
  v_new_id uuid;
begin
  select assignee_id, is_archived into v_assignee, v_archived from tasks where id = p_task_id;
  if v_assignee is null then
    raise exception 'task not found or has no assignee yet';
  end if;
  if v_assignee <> my_person_id() then
    raise exception 'only the task assignee can start this timer';
  end if;
  if coalesce(v_archived, false) then
    raise exception 'cannot start a timer on an archived task';
  end if;

  select te.task_id, t.name into v_existing_task_id, v_existing_task_name
    from time_entries te join tasks t on t.id = te.task_id
    where te.person_id = my_person_id() and te.status = 'running'
    limit 1;

  if v_existing_task_id is not null then
    raise exception 'you already have a timer running on "%" -- stop it before starting a new one', v_existing_task_name;
  end if;

  insert into time_entries (task_id, person_id, started_at, source, status)
  values (p_task_id, my_person_id(), now(), 'timer', 'running')
  returning id into v_new_id;

  return v_new_id;
end;
$$;

grant execute on function start_timer(uuid) to authenticated;

create or replace function stop_timer(p_entry_id uuid) returns void
language plpgsql security definer as $$
declare
  v_person uuid;
  v_status text;
  v_started timestamptz;
begin
  select person_id, status, started_at into v_person, v_status, v_started from time_entries where id = p_entry_id;
  if v_person is null then
    raise exception 'time entry not found';
  end if;
  if v_person <> my_person_id() then
    raise exception 'not authorized to stop this timer';
  end if;
  if v_status <> 'running' then
    raise exception 'this timer is not currently running';
  end if;

  update time_entries
    set ended_at = now(),
        status = 'pending_confirm',
        duration_minutes = round(extract(epoch from (now() - v_started)) / 60.0)
    where id = p_entry_id;
end;
$$;

grant execute on function stop_timer(uuid) to authenticated;

-- Confirm locks the entry in. Optional started_at/ended_at let the person
-- correct the times once, before the entry becomes immutable.
create or replace function confirm_time_entry(
  p_entry_id uuid,
  p_started_at timestamptz default null,
  p_ended_at timestamptz default null,
  p_notes text default null
) returns void
language plpgsql security definer as $$
declare
  v_person uuid;
  v_status text;
  v_start timestamptz;
  v_end timestamptz;
begin
  select person_id, status, started_at, ended_at into v_person, v_status, v_start, v_end
    from time_entries where id = p_entry_id;

  if v_person is null then
    raise exception 'time entry not found';
  end if;
  if v_person <> my_person_id() then
    raise exception 'not authorized to confirm this time entry';
  end if;
  if v_status <> 'pending_confirm' then
    raise exception 'this time entry is not awaiting confirmation';
  end if;

  if p_started_at is not null then v_start := p_started_at; end if;
  if p_ended_at is not null then v_end := p_ended_at; end if;

  if v_end <= v_start then
    raise exception 'end time must be after start time';
  end if;

  update time_entries
    set started_at = v_start,
        ended_at = v_end,
        duration_minutes = round(extract(epoch from (v_end - v_start)) / 60.0),
        status = 'confirmed',
        confirmed_at = now(),
        reason_notes = coalesce(p_notes, reason_notes)
    where id = p_entry_id;
end;
$$;

grant execute on function confirm_time_entry(uuid, timestamptz, timestamptz, text) to authenticated;

-- 4. Manual entry + approval (mirrors extension_requests' governance) ------

create or replace function submit_manual_time_entry(
  p_task_id uuid,
  p_started_at timestamptz,
  p_ended_at timestamptz,
  p_notes text
) returns uuid
language plpgsql security definer as $$
declare
  v_assignee uuid;
  v_new_id uuid;
begin
  select assignee_id into v_assignee from tasks where id = p_task_id;
  if v_assignee is null then
    raise exception 'task not found or has no assignee yet';
  end if;
  if v_assignee <> my_person_id() and my_access_level() <> 'full' then
    raise exception 'only the task assignee can log time for this task';
  end if;
  if p_ended_at <= p_started_at then
    raise exception 'end time must be after start time';
  end if;

  insert into time_entries
    (task_id, person_id, started_at, ended_at, duration_minutes, source, status, requested_by, reason_notes)
  values
    (p_task_id, v_assignee, p_started_at, p_ended_at,
     round(extract(epoch from (p_ended_at - p_started_at)) / 60.0),
     'manual', 'pending_approval', my_person_id(), p_notes)
  returning id into v_new_id;

  return v_new_id;
end;
$$;

grant execute on function submit_manual_time_entry(uuid, timestamptz, timestamptz, text) to authenticated;

create or replace function can_decide_time_entry(p_entry_id uuid) returns boolean
language sql stable security definer as $$
  select
    my_access_level() = 'full'
    or exists (
      select 1
      from time_entries te
      join tasks t on t.id = te.task_id
      join projects pr on pr.id = t.project_id
      left join people owner on owner.id = pr.owner_id
      where te.id = p_entry_id
        and (
          (pr.owner_id = my_person_id() and te.requested_by <> pr.owner_id)
          or (te.requested_by = pr.owner_id and owner.reports_to = my_person_id())
        )
    )
$$;

grant execute on function can_decide_time_entry(uuid) to authenticated;

create policy time_entries_decide_update on time_entries for update
  using (can_decide_time_entry(id))
  with check (can_decide_time_entry(id));

create or replace function decide_time_entry(
  p_entry_id uuid,
  p_status text,
  p_decision_notes text default null
) returns void
language plpgsql security definer as $$
declare
  v_current_status text;
begin
  if p_status not in ('approved','rejected') then
    raise exception 'invalid status: %', p_status;
  end if;
  if not can_decide_time_entry(p_entry_id) then
    raise exception 'not authorized to decide this time entry';
  end if;

  select status into v_current_status from time_entries where id = p_entry_id;
  if v_current_status is null then
    raise exception 'time entry not found';
  end if;
  if v_current_status <> 'pending_approval' then
    raise exception 'this time entry has already been decided';
  end if;

  update time_entries
    set status = p_status,
        decided_by = my_person_id(),
        decided_at = now(),
        decision_notes = p_decision_notes
    where id = p_entry_id;
end;
$$;

grant execute on function decide_time_entry(uuid, text, text) to authenticated;

-- 5. Full Access correction of a finalized entry ----------------------------

create or replace function correct_time_entry(
  p_entry_id uuid,
  p_duration_minutes numeric,
  p_notes text
) returns void
language plpgsql security definer as $$
declare
  v_status text;
  v_current_duration numeric;
begin
  if my_access_level() <> 'full' then
    raise exception 'only Full Access can correct a finalized time entry';
  end if;

  select status, duration_minutes into v_status, v_current_duration from time_entries where id = p_entry_id;
  if v_status is null then
    raise exception 'time entry not found';
  end if;
  if v_status not in ('confirmed','approved') then
    raise exception 'only a confirmed or approved time entry can be corrected';
  end if;
  if p_duration_minutes is null or p_duration_minutes <= 0 then
    raise exception 'corrected duration must be greater than zero';
  end if;

  perform set_config('app.bypass_time_entry_lock', 'on', true);
  update time_entries
    set duration_minutes = p_duration_minutes,
        original_duration_minutes = coalesce(original_duration_minutes, v_current_duration),
        corrected_by = my_person_id(),
        corrected_at = now(),
        correction_notes = p_notes
    where id = p_entry_id;
end;
$$;

grant execute on function correct_time_entry(uuid, numeric, text) to authenticated;

-- 6. Idle auto-stop -----------------------------------------------------

create or replace function auto_stop_idle_timers() returns void
language plpgsql security definer as $$
declare
  v_threshold int;
begin
  select idle_timeout_minutes into v_threshold from app_settings where id = true;
  v_threshold := coalesce(v_threshold, 240);

  update time_entries
    set ended_at = now(),
        status = 'pending_confirm',
        duration_minutes = round(extract(epoch from (now() - started_at)) / 60.0),
        auto_stopped = true
    where status = 'running'
      and started_at < now() - (v_threshold || ' minutes')::interval;
end;
$$;

grant execute on function auto_stop_idle_timers() to authenticated;

-- Server-side enforcement so idle timers stop even with no client open.
select cron.schedule(
  'auto-stop-idle-timers',
  '*/15 * * * *',
  $$select auto_stop_idle_timers()$$
) where not exists (select 1 from cron.job where jobname = 'auto-stop-idle-timers');

-- 7. Spent Hrs becomes computed -- legacy baseline + parent rollup ---------

-- Freeze today's manually-typed time_spent_hours as a one-time 'legacy'
-- entry per task, so no historical data is lost when Spent Hrs stops
-- being directly editable.
insert into time_entries (task_id, person_id, started_at, ended_at, duration_minutes, source, status, confirmed_at, reason_notes)
select
  t.id,
  coalesce(t.assignee_id, pr.owner_id),
  now(), now(),
  t.time_spent_hours * 60,
  'legacy', 'confirmed', now(),
  'Frozen baseline from Spent Hrs at the time Time Tracking was introduced.'
from tasks t
join projects pr on pr.id = t.project_id
where coalesce(t.time_spent_hours, 0) > 0
  and coalesce(t.assignee_id, pr.owner_id) is not null
  and not exists (select 1 from time_entries te where te.task_id = t.id and te.source = 'legacy');

-- Broaden time_entries visibility to match tasks visibility: Spent Hrs is
-- a rollup of time_entries now, and it used to be a plain unrestricted
-- tasks column everyone who could see the task could read. Without this,
-- a Standard user viewing a teammate's task in a shared project would see
-- Spent Hrs silently show 0 (RLS hid the rows) instead of the real total.
drop policy if exists time_entries_select on time_entries;
create policy time_entries_select on time_entries for select
  using (
    my_access_level() = 'full'
    or person_id = my_person_id()
    or requested_by = my_person_id()
    or exists (select 1 from tasks t where t.id = time_entries.task_id and can_see_project(t.project_id))
    or exists (select 1 from people where id = person_id and reports_to = my_person_id())
  );

-- Migration 2026-07-21c: resume timer + manual-entry reason categories
--
-- 1. resume_timer: "Continue work" option on the confirm-time-entry modal.
--    Sandra removed the "review later" escape hatch -- stopping a timer
--    now forces a real decision, either Confirm or Continue work (undo
--    the stop, keep the original start time, go back to running).
-- 2. time_entries.reason_category: manual entries now pick a reason from
--    a fixed list (mirrors extension_requests.reason_category) instead of
--    a single free-text box; "Other" still allows a free-text note.

alter table time_entries add column if not exists reason_category text;

-- 0. Fix "stuck at 0m" entries: datetime-local inputs are minute-granularity,
-- so a very quick stop could round start==end, and confirm_time_entry used
-- to reject that (end must be strictly after start) with no way to fix it
-- short of manually pushing the end time forward. Now: equal timestamps are
-- allowed and always credited a minimum of 1 minute, both at stop time and
-- at confirm time, so nothing can land in an unconfirmable state again.
create or replace function stop_timer(p_entry_id uuid) returns void
language plpgsql security definer as $$
declare
  v_person uuid;
  v_status text;
  v_started timestamptz;
begin
  select person_id, status, started_at into v_person, v_status, v_started from time_entries where id = p_entry_id;
  if v_person is null then
    raise exception 'time entry not found';
  end if;
  if v_person <> my_person_id() then
    raise exception 'not authorized to stop this timer';
  end if;
  if v_status <> 'running' then
    raise exception 'this timer is not currently running';
  end if;

  update time_entries
    set ended_at = now(),
        status = 'pending_confirm',
        duration_minutes = greatest(1, round(extract(epoch from (now() - v_started)) / 60.0))
    where id = p_entry_id;
end;
$$;

grant execute on function stop_timer(uuid) to authenticated;

create or replace function confirm_time_entry(
  p_entry_id uuid,
  p_started_at timestamptz default null,
  p_ended_at timestamptz default null,
  p_notes text default null
) returns void
language plpgsql security definer as $$
declare
  v_person uuid;
  v_status text;
  v_start timestamptz;
  v_end timestamptz;
begin
  select person_id, status, started_at, ended_at into v_person, v_status, v_start, v_end
    from time_entries where id = p_entry_id;

  if v_person is null then
    raise exception 'time entry not found';
  end if;
  if v_person <> my_person_id() then
    raise exception 'not authorized to confirm this time entry';
  end if;
  if v_status <> 'pending_confirm' then
    raise exception 'this time entry is not awaiting confirmation';
  end if;

  if p_started_at is not null then v_start := p_started_at; end if;
  if p_ended_at is not null then v_end := p_ended_at; end if;

  if v_end < v_start then
    raise exception 'end time must be at or after start time';
  end if;

  update time_entries
    set started_at = v_start,
        ended_at = v_end,
        duration_minutes = greatest(1, round(extract(epoch from (v_end - v_start)) / 60.0)),
        status = 'confirmed',
        confirmed_at = now(),
        reason_notes = coalesce(p_notes, reason_notes)
    where id = p_entry_id;
end;
$$;

grant execute on function confirm_time_entry(uuid, timestamptz, timestamptz, text) to authenticated;

-- Clean up the entries that got genuinely stuck under the old rule
-- (pending_confirm, 0 minutes, never touched again) -- test artifacts
-- from building this feature, not real work.
delete from time_entries where status = 'pending_confirm' and coalesce(duration_minutes, 0) = 0;

create or replace function resume_timer(p_entry_id uuid) returns void
language plpgsql security definer as $$
declare
  v_person uuid;
  v_status text;
  v_source text;
begin
  select person_id, status, source into v_person, v_status, v_source from time_entries where id = p_entry_id;
  if v_person is null then
    raise exception 'time entry not found';
  end if;
  if v_person <> my_person_id() then
    raise exception 'not authorized to resume this timer';
  end if;
  if v_status <> 'pending_confirm' then
    raise exception 'this time entry is not awaiting confirmation';
  end if;
  if v_source <> 'timer' then
    raise exception 'only a timer entry can be resumed';
  end if;
  if exists (select 1 from time_entries where person_id = my_person_id() and status = 'running' and id <> p_entry_id) then
    raise exception 'you already have another timer running -- stop that one first';
  end if;

  update time_entries
    set status = 'running',
        ended_at = null,
        duration_minutes = null,
        auto_stopped = false
    where id = p_entry_id;
end;
$$;

grant execute on function resume_timer(uuid) to authenticated;

-- submit_manual_time_entry gains p_reason_category (kept reason_notes as
-- the free-text "specify" field, now only required when category='Other').
create or replace function submit_manual_time_entry(
  p_task_id uuid,
  p_started_at timestamptz,
  p_ended_at timestamptz,
  p_reason_category text,
  p_notes text
) returns uuid
language plpgsql security definer as $$
declare
  v_assignee uuid;
  v_new_id uuid;
begin
  select assignee_id into v_assignee from tasks where id = p_task_id;
  if v_assignee is null then
    raise exception 'task not found or has no assignee yet';
  end if;
  if v_assignee <> my_person_id() and my_access_level() <> 'full' then
    raise exception 'only the task assignee can log time for this task';
  end if;
  if p_ended_at <= p_started_at then
    raise exception 'end time must be after start time';
  end if;

  insert into time_entries
    (task_id, person_id, started_at, ended_at, duration_minutes, source, status, requested_by, reason_category, reason_notes)
  values
    (p_task_id, v_assignee, p_started_at, p_ended_at,
     round(extract(epoch from (p_ended_at - p_started_at)) / 60.0),
     'manual', 'pending_approval', my_person_id(), p_reason_category, p_notes)
  returning id into v_new_id;

  return v_new_id;
end;
$$;

grant execute on function submit_manual_time_entry(uuid, timestamptz, timestamptz, text, text) to authenticated;
