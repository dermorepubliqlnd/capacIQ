-- Phase 35: Project Phases admin-configurable lookup + Status->Phase
-- mapping (2026-09-03).
--
-- Sandra: "I'd also want to be able to manage the project status and
-- phase. Note that the phase is conditional/dependent on the project
-- status so make sure I can make that mapping in the list." Status
-- itself stays a fixed, code-defined 5-value set (Not Started/In
-- Progress/Completed/Paused/Cancelled) -- health scoring, the
-- Design-phase lock guardrail, and the projects_status_check CHECK
-- constraint all key off those exact strings, so it's not made
-- admin-renameable here (flagged to Sandra as a deliberate scope call,
-- not an oversight). Phase becomes a real admin-configurable list
-- (add/rename/reorder/deactivate, mirrors project_categories exactly),
-- and which Phases are offered under "Not Started" / "In Progress" (the
-- only two Statuses with a real editable subset -- Completed is always
-- forced to "Done", Paused/Cancelled always offer every active Phase,
-- both pre-existing product rules) is a Sandra-editable mapping table,
-- same shape/pattern as work_type_output_types (phase23_migration.sql).
create table if not exists project_phases (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz default now()
);

alter table project_phases enable row level security;
create policy project_phases_select on project_phases for select using (true);
create policy project_phases_insert on project_phases for insert with check (my_access_level() = 'full');
create policy project_phases_update on project_phases for update using (my_access_level() = 'full') with check (my_access_level() = 'full');
create policy project_phases_delete on project_phases for delete using (my_access_level() = 'full');

-- Seed with the exact 8 phases already hardcoded in
-- src/lib/notionOptions.ts (PROJECT_PHASE_ALL), same order.
insert into project_phases (name, sort_order) values
  ('Backlog', 1),
  ('Queued', 2),
  ('Scoping', 3),
  ('Design', 4),
  ('Development', 5),
  ('Evaluation', 6),
  ('Delivery', 7),
  ('Done', 8)
on conflict (name) do nothing;

-- status is one of the 5 fixed Status strings (enforced in the app, not
-- a DB FK since Status isn't its own lookup table). No row for
-- Completed/Paused/Cancelled -- those three are handled by fixed rules
-- in the frontend (phaseOptionsForStatus in Projects.tsx), not this
-- table.
create table if not exists project_status_phase_mapping (
  status text not null,
  phase_id uuid not null references project_phases(id) on delete cascade,
  primary key (status, phase_id)
);

alter table project_status_phase_mapping enable row level security;
create policy project_status_phase_mapping_select on project_status_phase_mapping for select using (true);
create policy project_status_phase_mapping_insert on project_status_phase_mapping for insert with check (my_access_level() = 'full');
create policy project_status_phase_mapping_delete on project_status_phase_mapping for delete using (my_access_level() = 'full');

-- Seed the mapping to match the exact rules that were previously
-- hardcoded (PROJECT_PHASE_NOT_STARTED / PROJECT_PHASE_IN_PROGRESS in
-- notionOptions.ts), so nothing changes visually the moment this ships.
insert into project_status_phase_mapping (status, phase_id)
select 'Not Started', id from project_phases where name in ('Backlog', 'Queued')
union all
select 'In Progress', id from project_phases where name in ('Scoping', 'Design', 'Development', 'Evaluation', 'Delivery')
on conflict do nothing;
