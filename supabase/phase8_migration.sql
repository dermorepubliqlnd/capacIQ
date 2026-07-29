-- Phase 8: authorization flags for two future approval workflows --
-- reopening a Closed project, and re-baselining -- neither workflow
-- itself is being built yet (Sandra, 2026-07-29: "no tiering yet, just
-- add in user management who has authorization to approve reopening of
-- projects and re-baselining"). This mirrors the existing
-- `can_approve_closures` flag (phase1_migration.sql) added for the
-- Closure Request workflow -- same pattern: a flat, non-tiered
-- authorization boolean on `people`, toggleable from User Management,
-- with no RPC/RLS wiring yet since the actual reopen/re-baseline
-- approval flows aren't built.

alter table people add column if not exists can_approve_reopening boolean not null default false;
alter table people add column if not exists can_approve_rebaseline boolean not null default false;
