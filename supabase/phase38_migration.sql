-- Phase 38 migration (2026-09-03): Project Planning Type -- admin-
-- configurable lookup for "was this project planned/scoped ahead of time,
-- or did it come in ad hoc mid-cycle" (Sandra: "we want to add a project
-- tag to identify if the project is part of the planned project or
-- adhoc... account for urgent or things that were made [on the fly] in
-- our current workload... do not hard code it, add it in the settings
-- page"). Mirrors project_sources' own table/RLS shape exactly (see
-- phase20_migration.sql) -- a real FK lookup (not a plain-text tag like
-- Category/Phase) so a future rename never needs the cascade-rename
-- machinery those two required. Seeded with the 2 values Sandra asked
-- for (Planned / Ad Hoc); admin can add more later (e.g. a separate
-- "Urgent" tier) from Site Settings without any code change.

create table if not exists project_planning_types (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz default now()
);

alter table project_planning_types enable row level security;

drop policy if exists project_planning_types_select on project_planning_types;
create policy project_planning_types_select on project_planning_types for select using (true);

drop policy if exists project_planning_types_insert on project_planning_types;
create policy project_planning_types_insert on project_planning_types for insert
  with check (my_access_level() = 'full');

drop policy if exists project_planning_types_update on project_planning_types;
create policy project_planning_types_update on project_planning_types for update
  using (my_access_level() = 'full')
  with check (my_access_level() = 'full');

drop policy if exists project_planning_types_delete on project_planning_types;
create policy project_planning_types_delete on project_planning_types for delete
  using (my_access_level() = 'full');

insert into project_planning_types (name, sort_order) values
  ('Planned', 1),
  ('Ad Hoc', 2)
on conflict (name) do nothing;

alter table projects add column if not exists planning_type_id uuid references project_planning_types(id);
