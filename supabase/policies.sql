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
