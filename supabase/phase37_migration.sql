-- Phase 37 (2026-09-03): self-service Time Logging Reasons.
-- Sandra: "add in the list settings the reasons for manual time logging.
-- We want to be able to control it." Previously a fixed array in code
-- (TIME_ENTRY_REASON_OPTIONS in src/lib/timeTracking.ts) with no way for
-- her to add/rename/retire a reason without a code change.
--
-- time_entries.reason_category stays plain text (added 2026-07-21c,
-- policies.sql "Migration 2026-07-21c") -- same "admin-editable list,
-- plain-text tag on the row" pattern as Project Category/Phase, not a
-- new FK column, so this migration only adds the lookup table itself.
-- Seeded with the exact 5 existing hardcoded values in their current
-- order so nothing changes for the manual time-entry form until Sandra
-- edits the list herself in Site Settings.

create table if not exists time_entry_reasons (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table time_entry_reasons enable row level security;

create policy time_entry_reasons_select on time_entry_reasons for select using (true);
create policy time_entry_reasons_insert on time_entry_reasons for insert with check (my_access_level() = 'full');
create policy time_entry_reasons_update on time_entry_reasons for update using (my_access_level() = 'full') with check (my_access_level() = 'full');
create policy time_entry_reasons_delete on time_entry_reasons for delete using (my_access_level() = 'full');

insert into time_entry_reasons (name, sort_order) values
  ('Forgot to Start Timer', 1),
  ('Worked Offline / No Internet', 2),
  ('Continued Work After Hours', 3),
  ('System/Technical Issue', 4),
  ('Other', 5)
on conflict (name) do nothing;
