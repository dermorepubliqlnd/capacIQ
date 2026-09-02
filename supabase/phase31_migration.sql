-- Phase 31: account-level (Supabase-backed) table view settings.
--
-- Sandra, 2026-09-02: view settings (column order, hidden columns, widths,
-- grouping, sort, saved view tabs) currently live only in localStorage,
-- keyed by person id but scoped to one browser on one device -- switching
-- devices/browsers, or clearing site data, silently resets a person back
-- to the code default. This table becomes the real source of truth;
-- src/lib/useTableViews.ts now fetches/writes here instead of (in
-- addition to, as a fast-paint/offline cache) localStorage, with a
-- one-time migration that seeds this table from whatever was already
-- sitting in a person's browser the first time they load the app after
-- this ships.
--
-- One row per (person, table) -- table_key is "projects" or "tasks" today
-- (the two callers of useTableViews), but nothing here assumes only
-- those two, so a future third table just works.
create table if not exists person_table_views (
  person_id uuid not null references people(id) on delete cascade,
  table_key text not null,
  views jsonb not null default '[]'::jsonb,
  active_view_id text,
  updated_at timestamptz not null default now(),
  primary key (person_id, table_key)
);

alter table person_table_views enable row level security;

-- Purely personal UI preference -- no legitimate reason for anyone else
-- (including Full Access) to read or write another person's saved view,
-- unlike most other tables in this app.
create policy person_table_views_select on person_table_views
  for select using (person_id = my_person_id());

create policy person_table_views_insert on person_table_views
  for insert with check (person_id = my_person_id());

create policy person_table_views_update on person_table_views
  for update using (person_id = my_person_id())
  with check (person_id = my_person_id());

create policy person_table_views_delete on person_table_views
  for delete using (person_id = my_person_id());
