-- CapacIQ initial schema sketch (Section 3 of the brief).
-- Run in the Supabase SQL editor once the project is created.

create table people (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text unique not null,
  access_level text not null default 'limited' check (access_level in ('full','limited')),
  reports_to uuid references people(id),
  daily_capacity_hours numeric not null default 7.5
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid references people(id),
  category text,
  priority text check (priority in ('Low','Medium','High')),
  project_status text,
  project_source text,
  summary text,
  effort_level text,
  training_delivery_status text,
  start_date date,
  end_date date
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id),
  name text not null,
  phase text,
  status text,
  assignee_id uuid references people(id),
  start_date date,
  original_due_date date not null,
  current_due_date date not null,
  estimated_hours numeric,
  time_spent_hours numeric default 0,
  submitted_on timestamptz,
  submitted_by uuid references people(id),
  validated_completion_date timestamptz,
  validated_by uuid references people(id)
);

create table task_collaborators (
  task_id uuid references tasks(id),
  person_id uuid references people(id),
  primary key (task_id, person_id)
);

create table extension_requests (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references tasks(id) not null,
  requested_by uuid references people(id) not null,
  requested_new_due_date date not null,
  reason_category text not null,
  reason_notes text not null,
  status text not null default 'Pending' check (status in ('Pending','Approved','Rejected')),
  decided_by uuid references people(id),
  decided_at timestamptz,
  decision_notes text,
  is_manager_initiated boolean default false,
  created_at timestamptz default now()
);

create table utilization_snapshots (
  id uuid primary key default gen_random_uuid(),
  person_id uuid references people(id) not null,
  period_type text not null check (period_type in ('week','month')),
  period_start date not null,
  capacity_hours numeric not null,
  planned_hours_allocated numeric not null default 0,
  planned_utilization_pct numeric,
  actual_hours_logged numeric not null default 0,
  actual_utilization_pct numeric
);

-- Row-level security gets enabled per Section 8 (Full Access vs Standard)
-- once auth/roles are wired up in Phase 2.
