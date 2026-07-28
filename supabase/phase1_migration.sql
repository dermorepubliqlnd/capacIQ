-- Migration 2026-07-28i: Phase 1 DB foundation for the Draft / Baseline /
-- Revision / Final-Scope workflow (Sandra's spec, 2026-07-28). Extends the
-- existing project_baselines/project_closeouts tables (does not replace
-- them) and adds the new versioning/revision/approval tables. UI wiring
-- (WBS read-only gating, revision modals, closure-approval screen) comes
-- in later phases -- this migration only lays the DB groundwork.

-- ---------------------------------------------------------------------
-- 1. New wbs_status on projects -- a distinct axis from the existing
--    lifecycle `status`/`phase` columns (see project_capaciq_status_phase
--    _redesign memory), so the two state machines don't collide.
-- ---------------------------------------------------------------------
alter table projects add column if not exists wbs_status text
  check (wbs_status in ('draft','baseline_locked','revision_in_progress','changed_after_baseline','closed'));

update projects set wbs_status = case
  when exists (select 1 from project_closeouts c where c.project_id = projects.id) then 'closed'
  when timelines_locked then 'baseline_locked'
  else 'draft'
end
where wbs_status is null;

alter table projects alter column wbs_status set default 'draft';
alter table projects alter column wbs_status set not null;

-- ---------------------------------------------------------------------
-- 2. Version project_baselines / project_baseline_tasks (extend, don't
--    duplicate). Existing rows become version 1, active.
-- ---------------------------------------------------------------------
alter table project_baselines drop constraint if exists project_baselines_project_id_key;
alter table project_baselines add column if not exists version_number integer;
alter table project_baselines add column if not exists reason text;
alter table project_baselines add column if not exists approved_by uuid references people(id);
alter table project_baselines add column if not exists approval_reference text;
alter table project_baselines add column if not exists is_active boolean;

update project_baselines set version_number = 1 where version_number is null;
update project_baselines set is_active = true where is_active is null;

alter table project_baselines alter column version_number set not null;
alter table project_baselines alter column is_active set not null;
alter table project_baselines alter column is_active set default true;

create unique index if not exists project_baselines_project_version_idx
  on project_baselines(project_id, version_number);

-- Task-level snapshot: extend with the fields needed to fully reconstruct
-- a task's plan-relevant state (assignee/effort/dependencies/dates for
-- both modes), still deliberately NOT FK'd to tasks(id) so history stays
-- readable after a hard delete.
alter table project_baseline_tasks add column if not exists parent_task_id uuid;
alter table project_baseline_tasks add column if not exists assignee_name text;
alter table project_baseline_tasks add column if not exists effort text;
alter table project_baseline_tasks add column if not exists depends_on jsonb;
alter table project_baseline_tasks add column if not exists start_date_full date;
alter table project_baseline_tasks add column if not exists end_date_full date;
alter table project_baseline_tasks add column if not exists start_date_standard date;
alter table project_baseline_tasks add column if not exists end_date_standard date;

-- ---------------------------------------------------------------------
-- 3. project_plan_versions / project_plan_version_tasks -- the "Current
--    Plan Vn" snapshot compared against the active Baseline. V1 is
--    captured at the same moment as Baseline V1 (Lock Baseline); later
--    versions come from an applied revision.
-- ---------------------------------------------------------------------
create table if not exists project_plan_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade not null,
  version_number integer not null,
  created_at timestamptz not null default now(),
  created_by uuid references people(id),
  source text not null check (source in ('initial_lock','revision_applied')),
  revision_id uuid, -- FK added below, after project_revisions exists
  mode text not null check (mode in ('full_capacity','standard')),
  total_est_hours numeric not null,
  task_count integer not null,
  start_date date,
  end_date date
);
create unique index if not exists project_plan_versions_project_version_idx
  on project_plan_versions(project_id, version_number);

create table if not exists project_plan_version_tasks (
  id uuid primary key default gen_random_uuid(),
  plan_version_id uuid references project_plan_versions(id) on delete cascade not null,
  task_id uuid not null,
  parent_task_id uuid,
  name text not null,
  estimated_hours numeric,
  assignee_name text,
  effort text,
  depends_on jsonb,
  start_date_full date,
  end_date_full date,
  start_date_standard date,
  end_date_standard date
);
create index if not exists project_plan_version_tasks_version_idx on project_plan_version_tasks(plan_version_id);

-- ---------------------------------------------------------------------
-- 4. project_revisions -- one active ("in_progress") revision per
--    project at a time, enforced by the partial unique index below.
-- ---------------------------------------------------------------------
create table if not exists project_revisions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade not null,
  revision_number integer not null,
  reason text not null,
  status text not null check (status in ('in_progress','applied','discarded')),
  source_plan_version_id uuid references project_plan_versions(id),
  resulting_plan_version_id uuid references project_plan_versions(id),
  started_by uuid references people(id),
  started_at timestamptz not null default now(),
  applied_by uuid references people(id),
  applied_at timestamptz,
  discarded_by uuid references people(id),
  discarded_at timestamptz
);
create unique index if not exists project_revisions_project_number_idx
  on project_revisions(project_id, revision_number);
create unique index if not exists project_revisions_one_active_idx
  on project_revisions(project_id) where status = 'in_progress';

alter table project_plan_versions
  add constraint project_plan_versions_revision_id_fkey
  foreign key (revision_id) references project_revisions(id);

-- ---------------------------------------------------------------------
-- 5. project_revision_changes -- the diff/audit log for a revision.
--    task_id deliberately not FK'd (same reasoning as baseline_tasks).
-- ---------------------------------------------------------------------
create table if not exists project_revision_changes (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid references project_revisions(id) on delete cascade not null,
  task_id uuid not null,
  task_name text not null,
  change_type text not null check (change_type in
    ('task_added','task_removed','hours_changed','date_changed','dependency_changed','assignee_changed')),
  field text,
  previous_value jsonb,
  new_value jsonb,
  changed_by uuid references people(id),
  changed_at timestamptz not null default now()
);
create index if not exists project_revision_changes_revision_idx on project_revision_changes(revision_id);

-- ---------------------------------------------------------------------
-- 6. Soft-delete marker for a task removed WHILE a revision is active --
--    a scoped exception to the normal "tasks are always hard-deleted"
--    rule (see project_capaciq_archive_semantics memory), so a removed
--    task can still appear in the revision diff and be restored on
--    discard. NOT wired into any query filters yet -- that's a later
--    phase, once the WBS/Projects & Tasks UI actually starts creating
--    revisions.
-- ---------------------------------------------------------------------
alter table tasks add column if not exists removed_in_revision_id uuid references project_revisions(id);

-- ---------------------------------------------------------------------
-- 7. Flat closure-approval permission on people (not tied to
--    access_level, which already gates unrelated admin actions).
-- ---------------------------------------------------------------------
alter table people add column if not exists can_approve_closures boolean not null default false;

-- ---------------------------------------------------------------------
-- 8. project_closure_requests -- request-then-approve, mirrors the
--    existing Extension Request escalation shape. Approval captures the
--    immutable Final Scope (a fresh project_closeouts row) at decision
--    time; project_closeouts' existing re-runnable update policy is left
--    alone for now (still used by the current Baseline-vs-Final report)
--    and will be retired in the phase that rewires that UI.
-- ---------------------------------------------------------------------
create table if not exists project_closure_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade not null,
  requested_by uuid references people(id),
  requested_at timestamptz not null default now(),
  status text not null check (status in ('pending','approved','rejected')),
  decided_by uuid references people(id),
  decided_at timestamptz,
  decision_reason text,
  resulting_closeout_id uuid references project_closeouts(id)
);
create unique index if not exists project_closure_requests_one_pending_idx
  on project_closure_requests(project_id) where status = 'pending';
create index if not exists project_closure_requests_project_idx on project_closure_requests(project_id);

-- ---------------------------------------------------------------------
-- RLS -- same insert/select-only audit-trail convention as
-- project_baselines/task_planning_snapshots. Mutations happen only
-- through security-definer RPCs added in a later phase, not directly
-- from the client.
-- ---------------------------------------------------------------------
alter table project_plan_versions enable row level security;
alter table project_plan_version_tasks enable row level security;
alter table project_revisions enable row level security;
alter table project_revision_changes enable row level security;
alter table project_closure_requests enable row level security;

create policy project_plan_versions_select on project_plan_versions for select
  using (can_see_project(project_id));
create policy project_plan_versions_insert on project_plan_versions for insert
  with check (exists (select 1 from projects pr where pr.id = project_id and (my_access_level() = 'full' or pr.owner_id = my_person_id())));

create policy project_plan_version_tasks_select on project_plan_version_tasks for select
  using (exists (select 1 from project_plan_versions v where v.id = plan_version_id and can_see_project(v.project_id)));
create policy project_plan_version_tasks_insert on project_plan_version_tasks for insert
  with check (
    exists (
      select 1 from project_plan_versions v join projects pr on pr.id = v.project_id
      where v.id = plan_version_id and (my_access_level() = 'full' or pr.owner_id = my_person_id())
    )
  );

create policy project_revisions_select on project_revisions for select
  using (can_see_project(project_id));
create policy project_revisions_insert on project_revisions for insert
  with check (exists (select 1 from projects pr where pr.id = project_id and (my_access_level() = 'full' or pr.owner_id = my_person_id())));
create policy project_revisions_update on project_revisions for update
  using (exists (select 1 from projects pr where pr.id = project_id and (my_access_level() = 'full' or pr.owner_id = my_person_id())));
-- Update policy exists ONLY so apply/discard can flip status/applied_at/
-- discarded_at on the SAME in-progress row -- an applied or discarded
-- revision is never touched again by application logic, but this isn't
-- enforced at the DB level yet (would need a trigger; acceptable gap for
-- Phase 1, revisit if this ever needs to be bulletproof).

create policy project_revision_changes_select on project_revision_changes for select
  using (exists (select 1 from project_revisions r where r.id = revision_id and can_see_project(r.project_id)));
create policy project_revision_changes_insert on project_revision_changes for insert
  with check (
    exists (
      select 1 from project_revisions r join projects pr on pr.id = r.project_id
      where r.id = revision_id and (my_access_level() = 'full' or pr.owner_id = my_person_id())
    )
  );

create policy project_closure_requests_select on project_closure_requests for select
  using (can_see_project(project_id));
create policy project_closure_requests_insert on project_closure_requests for insert
  with check (exists (select 1 from projects pr where pr.id = project_id and (my_access_level() = 'full' or pr.owner_id = my_person_id())));
create policy project_closure_requests_update on project_closure_requests for update
  using (
    -- The requester can see their own pending request; the actual
    -- approve/reject decision is restricted to people flagged as
    -- approvers (or Full Access, as an override).
    my_access_level() = 'full'
    or exists (select 1 from people me where me.id = my_person_id() and me.can_approve_closures)
    or exists (select 1 from projects pr where pr.id = project_id and pr.owner_id = my_person_id())
  );
