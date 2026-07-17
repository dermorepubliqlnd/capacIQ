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

