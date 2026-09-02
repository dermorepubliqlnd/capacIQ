-- Phase 34: Project Categories admin-configurable lookup (2026-09-03).
--
-- Sandra: "can we add in the site setting a list for the Project
-- categories. I want to be able to customize it in time when needed" --
-- mirrors project_sources (phase20_migration.sql) exactly. Deliberately
-- NOT adding a category_id FK on projects (unlike source_id) -- Category
-- has far more code touchpoints (icon map, tone map, grouping, board
-- columns) than Source, so projects.category stays plain text and this
-- table only supplies the OPTION LIST shown in the picker/Site Settings.
create table if not exists project_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz default now()
);

alter table project_categories enable row level security;

create policy project_categories_select on project_categories for select using (true);
create policy project_categories_insert on project_categories for insert with check (my_access_level() = 'full');
create policy project_categories_update on project_categories for update using (my_access_level() = 'full') with check (my_access_level() = 'full');
create policy project_categories_delete on project_categories for delete using (my_access_level() = 'full');

-- Seed with the exact 7 categories already hardcoded in
-- src/lib/notionOptions.ts (PROJECT_CATEGORY_OPTIONS), same order, typo
-- ("Improvments") preserved verbatim since it's already live production
-- data on existing projects.category values.
insert into project_categories (name, sort_order) values
  ('Compliance & Safety', 1),
  ('L&D Improvments', 2),
  ('Leadership', 3),
  ('Onboarding', 4),
  ('Operational Support', 5),
  ('Professional Development', 6),
  ('Technical & Systems', 7)
on conflict (name) do nothing;
