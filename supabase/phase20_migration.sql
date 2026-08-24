-- Phase 20 migration (2026-08-24): Project Source -- admin-configurable
-- lookup for the new Portfolio Dashboard's "Source" donut/filter (Sandra:
-- "add it, make sure we add this in the settings too so we can customize.
-- Also add this property in the project level. For now source are Intake
-- and L&D Initiative"). Mirrors work_types' own table/RLS shape exactly
-- (see phase12_migration.sql + phase12_migration_2.sql) -- same
-- admin-only add/rename/reorder/deactivate/delete-if-unused convention,
-- just at the PROJECT level instead of the task level. Deliberately a
-- separate concept from projects.category (an existing field, already
-- covering training-type classification like Onboarding/Leadership/
-- Compliance & Safety) -- Source instead tracks how/why a project
-- originated (Intake request vs. an L&D-initiated improvement), which is
-- the dimension the Dashboard's Source donut and filter need.

create table if not exists project_sources (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz default now()
);

alter table project_sources enable row level security;

drop policy if exists project_sources_select on project_sources;
create policy project_sources_select on project_sources for select using (true);

drop policy if exists project_sources_insert on project_sources;
create policy project_sources_insert on project_sources for insert
  with check (my_access_level() = 'full');

drop policy if exists project_sources_update on project_sources;
create policy project_sources_update on project_sources for update
  using (my_access_level() = 'full')
  with check (my_access_level() = 'full');

-- Delete policy included from the start this time (work_types shipped
-- without one initially, then needed a follow-up migration -- see
-- phase12_migration_2.sql's own note on why an RLS-enabled table with NO
-- delete policy silently no-ops a delete rather than erroring, per
-- [[feedback_supabase_rls_silent_delete_noop]]). The client
-- (SiteSettings.tsx's deleteProjectSource()) does its own "N project(s)
-- still use this" count check against projects.source_id before ever
-- attempting the delete, same UX convention as Work Types.
drop policy if exists project_sources_delete on project_sources;
create policy project_sources_delete on project_sources for delete
  using (my_access_level() = 'full');

insert into project_sources (name, sort_order) values
  ('Intake', 1),
  ('L&D Initiative', 2)
on conflict (name) do nothing;

alter table projects add column if not exists source_id uuid references project_sources(id);
