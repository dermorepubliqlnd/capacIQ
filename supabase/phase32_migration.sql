-- Phase 32 (2026-09-03): open up project creation + visibility to everyone.
--
-- Sandra's decision: "Everyone should be able to create a project. Everyone
-- should also see all projects for now -- make everything visible to
-- everyone. Just retain the approval workflows and authorities based on
-- permissions."
--
-- This does NOT touch any approval/edit authority -- projects_update,
-- projects_delete, tasks_insert/update/delete, extension_requests
-- decisions, closure/reopen authority, etc. all still key off
-- my_access_level() = 'full' or owner_id/assignee_id directly. Only two
-- things change: (1) who can see a project/its tasks/related rows, via
-- can_see_project(), and (2) who can create a new project.

create or replace function can_see_project(p_project_id uuid) returns boolean
language sql stable security definer as $$
  select true
$$;

alter policy projects_insert on projects
  with check (true);
