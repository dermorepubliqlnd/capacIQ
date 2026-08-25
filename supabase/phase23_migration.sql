-- Phase 23 migration (2026-08-25): Site Settings redesign -- Task Type
-- (work_types) <-> Output Type (output_types) conditional mapping, plus
-- alphabetizing both lists' default order to match the new outline/
-- side-peek UI in SiteSettings.tsx.
--
-- Sandra's own answers (2026-08-25 chat): "Category" in her original ask
-- was Work Type, not a separate list -- no new Category table. Mapping
-- is edited from each Task Type's own panel. Existing custom sort order
-- gets alphabetized once (one-time re-sort, not a standing constraint --
-- dragging afterward still works exactly like today). Both lookup lists
-- get expanded to match the Task Type x Output Type matrix she pasted in
-- chat.

-- ---------------------------------------------------------------------
-- 1. Rename existing Work Types to match the matrix's wording, and add
--    the one row missing from it (Needs Analysis). Renames keep the same
--    id, so any task already carrying that work_type_id keeps pointing
--    at the same row -- only the label changes, no historical data
--    moves.
-- ---------------------------------------------------------------------
update work_types set name = 'Assessment & Evaluation' where name = 'Evaluation';
update work_types set name = 'Quality Assurance' where name = 'Review / QA';
update work_types set name = 'LMS Administration' where name = 'LMS / Administration';

insert into work_types (name, sort_order, is_active)
values ('Needs Analysis', 999, true)
on conflict (name) do nothing;

-- ---------------------------------------------------------------------
-- 2. Expand Output Types to match the matrix's columns. "E-learning
--    Module" is reworded to plain "E-learning" to match the matrix
--    exactly. "SOP" (added in Phase 21, not part of the matrix) is left
--    in place rather than removed -- it's a real, separate deliverable
--    Sandra's team produces; the matrix wasn't presented as an
--    exhaustive replacement for it. Flagging this choice back to her.
-- ---------------------------------------------------------------------
update output_types set name = 'E-learning' where name = 'E-learning Module';

insert into output_types (name, sort_order, is_active)
values
  ('Slide Deck', 990, true),
  ('Learner Guide', 991, true),
  ('Storyboard', 992, true),
  ('Training Design', 993, true),
  ('Survey / Evaluation', 994, true),
  ('Document', 995, true),
  ('Report', 996, true),
  ('Communication Material', 997, true),
  ('Data / Tracker', 998, true),
  ('System Configuration', 999, true),
  ('Review / QA Record', 1000, true),
  ('Recording', 1001, true),
  ('Activity Only', 1002, true)
on conflict (name) do nothing;

-- ---------------------------------------------------------------------
-- 3. One-time alphabetical re-sort of both lists (case-insensitive).
--    After this, dragging in the new outline UI persists sort_order
--    exactly like the old up/down arrows did -- this just resets the
--    starting point.
-- ---------------------------------------------------------------------
with ranked as (
  select id, row_number() over (order by lower(name)) as rn from work_types
)
update work_types w set sort_order = ranked.rn from ranked where ranked.id = w.id;

with ranked as (
  select id, row_number() over (order by lower(name)) as rn from output_types
)
update output_types o set sort_order = ranked.rn from ranked where ranked.id = o.id;

-- ---------------------------------------------------------------------
-- 4. Task Type <-> Output Type conditional mapping (many-to-many).
--    WbsPlanning's Output Type picker filters to only the rows mapped
--    here for the task's current Work Type (falls back to showing every
--    active Output Type if the task has no Work Type set yet, or if a
--    Work Type has zero mapped rows, so nothing gets stuck unpickable).
-- ---------------------------------------------------------------------
create table if not exists work_type_output_types (
  id uuid primary key default gen_random_uuid(),
  work_type_id uuid not null references work_types(id) on delete cascade,
  output_type_id uuid not null references output_types(id) on delete cascade,
  created_at timestamptz default now(),
  unique (work_type_id, output_type_id)
);

alter table work_type_output_types enable row level security;

drop policy if exists work_type_output_types_select on work_type_output_types;
create policy work_type_output_types_select on work_type_output_types for select using (true);

drop policy if exists work_type_output_types_insert on work_type_output_types;
create policy work_type_output_types_insert on work_type_output_types for insert
  with check (my_access_level() = 'full');

drop policy if exists work_type_output_types_delete on work_type_output_types;
create policy work_type_output_types_delete on work_type_output_types for delete
  using (my_access_level() = 'full');

-- Seed the mapping per the matrix Sandra pasted in chat (2026-08-25).
insert into work_type_output_types (work_type_id, output_type_id)
select wt.id, ot.id
from (values
  ('Needs Analysis', 'Document'),
  ('Needs Analysis', 'Activity Only'),

  ('Instructional Design', 'Slide Deck'),
  ('Instructional Design', 'Job Aid'),
  ('Instructional Design', 'Facilitator Guide'),
  ('Instructional Design', 'Learner Guide'),
  ('Instructional Design', 'Storyboard'),
  ('Instructional Design', 'Training Design'),
  ('Instructional Design', 'Assessment'),
  ('Instructional Design', 'Survey / Evaluation'),
  ('Instructional Design', 'Document'),
  ('Instructional Design', 'Template'),
  ('Instructional Design', 'Report'),
  ('Instructional Design', 'Communication Material'),
  ('Instructional Design', 'Activity Only'),

  ('Content Development', 'Slide Deck'),
  ('Content Development', 'E-learning'),
  ('Content Development', 'Job Aid'),
  ('Content Development', 'Facilitator Guide'),
  ('Content Development', 'Learner Guide'),
  ('Content Development', 'Assessment'),
  ('Content Development', 'Survey / Evaluation'),
  ('Content Development', 'Video'),
  ('Content Development', 'Document'),
  ('Content Development', 'Template'),
  ('Content Development', 'Communication Material'),

  ('Training Preparation', 'Slide Deck'),
  ('Training Preparation', 'Job Aid'),
  ('Training Preparation', 'Facilitator Guide'),
  ('Training Preparation', 'Learner Guide'),
  ('Training Preparation', 'Training Design'),
  ('Training Preparation', 'Assessment'),
  ('Training Preparation', 'Survey / Evaluation'),
  ('Training Preparation', 'Document'),
  ('Training Preparation', 'Template'),
  ('Training Preparation', 'Data / Tracker'),
  ('Training Preparation', 'Communication Material'),
  ('Training Preparation', 'Activity Only'),

  ('Training Delivery', 'Report'),
  ('Training Delivery', 'Recording'),
  ('Training Delivery', 'Activity Only'),

  ('Assessment & Evaluation', 'Slide Deck'),
  ('Assessment & Evaluation', 'Assessment'),
  ('Assessment & Evaluation', 'Survey / Evaluation'),
  ('Assessment & Evaluation', 'Document'),
  ('Assessment & Evaluation', 'Template'),
  ('Assessment & Evaluation', 'Report'),
  ('Assessment & Evaluation', 'Data / Tracker'),
  ('Assessment & Evaluation', 'Activity Only'),

  ('Quality Assurance', 'Survey / Evaluation'),
  ('Quality Assurance', 'Report'),
  ('Quality Assurance', 'Review / QA Record'),
  ('Quality Assurance', 'Activity Only'),

  ('LMS Administration', 'Document'),
  ('LMS Administration', 'Report'),
  ('LMS Administration', 'Communication Material'),
  ('LMS Administration', 'System Configuration'),

  ('Project Management', 'Slide Deck'),
  ('Project Management', 'Training Design'),
  ('Project Management', 'Document'),
  ('Project Management', 'Report'),
  ('Project Management', 'Template'),
  ('Project Management', 'Communication Material'),
  ('Project Management', 'Data / Tracker'),
  ('Project Management', 'Activity Only')
) as m(work_type_name, output_type_name)
join work_types wt on wt.name = m.work_type_name
join output_types ot on ot.name = m.output_type_name
on conflict (work_type_id, output_type_id) do nothing;
