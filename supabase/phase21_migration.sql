-- Phase 21 migration (2026-08-24): Materials Output -- admin-configurable
-- output taxonomy so the Dashboard's "Materials Output" placeholder card
-- can carry a real total, and the new breakdown chart Sandra asked for
-- ("it would have a separate chart... moving the category breakdown into
-- the 2nd row as a donut too, replace By Category's old row-3 spot with
-- Materials Output") can group by what kind of material was produced.
-- Sandra's own answers: admin-configurable Output Type list (not a plain
-- number), and the Output Type + Output Count fields should appear on
-- EVERY task, not just content-development-flavored Work Types.
--
-- Mirrors work_types/project_sources' own table/RLS shape exactly.

create table if not exists output_types (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz default now()
);

alter table output_types enable row level security;

drop policy if exists output_types_select on output_types;
create policy output_types_select on output_types for select using (true);

drop policy if exists output_types_insert on output_types;
create policy output_types_insert on output_types for insert
  with check (my_access_level() = 'full');

drop policy if exists output_types_update on output_types;
create policy output_types_update on output_types for update
  using (my_access_level() = 'full')
  with check (my_access_level() = 'full');

-- Delete policy included from day one -- see [[feedback_supabase_rls_silent_delete_noop]].
-- The client (SiteSettings.tsx's deleteOutputType()) does its own "N task(s)
-- still use this" count check against tasks.output_type_id before ever
-- attempting the delete, same UX convention as Work Types/Project Sources.
drop policy if exists output_types_delete on output_types;
create policy output_types_delete on output_types for delete
  using (my_access_level() = 'full');

-- Starter set covering the L&D content-development deliverables Sandra's
-- team produces day to day (Content Development section of her own role
-- description: ILT, e-learning, blended structures, job aids, facilitator
-- guides). Fully editable/renameable/reorderable afterward via the new
-- Site Settings card, same as Intake/L&D Initiative were for Source.
insert into output_types (name, sort_order) values
  ('E-learning Module', 1),
  ('Job Aid', 2),
  ('Facilitator Guide', 3),
  ('Assessment', 4),
  ('SOP', 5),
  ('Video', 6),
  ('Template', 7)
on conflict (name) do nothing;

alter table tasks add column if not exists output_type_id uuid references output_types(id);
alter table tasks add column if not exists output_count numeric;
