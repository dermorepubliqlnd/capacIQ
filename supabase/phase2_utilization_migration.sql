-- ============================================================
-- Phase 2 (2026-08-20): Utilization/Day Planner hours + capacity-aware
-- rewrite. Sandra's target model: Work Type -> Planned Effort Hours ->
-- auto Effort Level (Phase 1, shipped) -> capacity-aware schedule ->
-- hours-based Utilization (this phase).
--
-- This migration only touches the deletion-archive functions
-- (archive_task_utilization / archive_project_pm_overhead). It:
--   1. Makes archive_task_utilization also write real per-day HOURS
--      (task.estimated_hours spread across its own working days) into
--      deleted_person_day_hours -- today it only ever wrote the fixed
--      0.5h/day PM-overhead archive there; a deleted task's own worked
--      hours never made it into the hours table at all, only into
--      deleted_person_day_points (which the new hours-based Utilization
--      no longer reads).
--   2. Makes BOTH archive functions holiday-aware. The original
--      comment on archive_task_utilization explicitly flagged this as a
--      known, deliberate gap ("a reasonable simplification for a
--      backstop archive") -- fixing it now since Phase 2 is already
--      touching this exact math. Only affects future deletions; rows
--      already archived under the old (non-holiday-aware) logic are left
--      untouched, per this app's established convention of never
--      retroactively rewriting historical archive rows.
--   3. Does NOT touch deleted_person_day_points or its writes -- left
--      as a harmless, no-longer-read legacy column set rather than
--      deleting data. The points-based Utilization.tsx code path is
--      being replaced by this same phase, not this migration.
-- ============================================================

create or replace function archive_task_utilization(p_task_id uuid) returns void
language plpgsql security definer as $$
declare
  t record;
  points numeric;
  total_days int;
  d date;
  window_end date;
  per_day_person uuid;
begin
  select id, project_id, start_date, current_due_date, effort, assignee_id, estimated_hours
    into t
    from tasks where id = p_task_id;
  if not found then return; end if;

  points := case t.effort when 'Light' then 0.5 when 'Moderate' then 1 when 'Heavy' then 2 else 0 end;

  -- Points archive (legacy, kept as-is for anything still reading it --
  -- NOT holiday-aware, matching its original behavior exactly so no
  -- previously-archived-adjacent row's math shifts).
  if points > 0 then
    total_days := 0;
    for d in select generate_series(
      coalesce(t.start_date, t.current_due_date),
      t.current_due_date,
      interval '1 day'
    )::date
    loop
      if extract(dow from d) not in (0, 6) then
        total_days := total_days + 1;
      end if;
    end loop;
    if total_days = 0 then total_days := 1; end if;

    window_end := least(t.current_due_date, current_date);
    if window_end >= coalesce(t.start_date, t.current_due_date) then
      for d in select generate_series(coalesce(t.start_date, t.current_due_date), window_end, interval '1 day')::date
      loop
        if extract(dow from d) not in (0, 6) then
          select person_id into per_day_person
            from task_assignee_history
            where task_id = p_task_id and effective_from <= d and (effective_to is null or effective_to >= d)
            limit 1;
          per_day_person := coalesce(per_day_person, t.assignee_id);
          if per_day_person is not null then
            insert into deleted_person_day_points (person_id, date, points)
            values (per_day_person, d, points / total_days);
          end if;
        end if;
      end loop;
    end if;
  end if;

  -- Hours archive (new, holiday-aware): estimated_hours spread evenly
  -- across the task's own working days (weekends AND holidays excluded),
  -- same "spread evenly across the window" convention the points version
  -- above used, just holiday-aware and hours-native. This is what the
  -- new hours-based Utilization reads for permanently-deleted tasks.
  if coalesce(t.estimated_hours, 0) > 0 then
    total_days := 0;
    for d in select generate_series(
      coalesce(t.start_date, t.current_due_date),
      t.current_due_date,
      interval '1 day'
    )::date
    loop
      if extract(dow from d) not in (0, 6) and not exists (select 1 from holidays h where h.date = d) then
        total_days := total_days + 1;
      end if;
    end loop;
    if total_days = 0 then total_days := 1; end if;

    window_end := least(t.current_due_date, current_date);
    if window_end >= coalesce(t.start_date, t.current_due_date) then
      for d in select generate_series(coalesce(t.start_date, t.current_due_date), window_end, interval '1 day')::date
      loop
        if extract(dow from d) not in (0, 6) and not exists (select 1 from holidays h where h.date = d) then
          select person_id into per_day_person
            from task_assignee_history
            where task_id = p_task_id and effective_from <= d and (effective_to is null or effective_to >= d)
            limit 1;
          per_day_person := coalesce(per_day_person, t.assignee_id);
          if per_day_person is not null then
            insert into deleted_person_day_hours (person_id, date, hours)
            values (per_day_person, d, t.estimated_hours / total_days);
          end if;
        end if;
      end loop;
    end if;
  end if;

  insert into deleted_project_spent_hours_archive (project_id, person_id, hours)
  select t.project_id, te.person_id, sum(coalesce(te.duration_minutes, 0)) / 60.0
    from time_entries te
    where te.task_id = p_task_id and te.status in ('confirmed', 'approved')
    group by te.person_id;
end;
$$;

-- Same holiday-awareness fix applied to the PM-overhead archive (was
-- also flagged as a known gap in its own comment). Cap-per-project logic
-- is unaffected -- this archives the flat, uncapped 0.1pt/0.5h daily
-- contribution, same as before; the cross-project cap is still applied
-- at merge/display time in the frontend, not baked in here.
create or replace function archive_project_pm_overhead(p_project_id uuid) returns void
language plpgsql security definer as $$
declare
  p record;
  d date;
  window_end date;
  per_day_person uuid;
begin
  select id, owner_id, start_date, end_date into p from projects where id = p_project_id;
  if not found or p.start_date is null or p.end_date is null then return; end if;

  window_end := least(p.end_date, current_date);
  if window_end < p.start_date then return; end if;

  for d in select generate_series(p.start_date, window_end, interval '1 day')::date
  loop
    if extract(dow from d) not in (0, 6) and not exists (select 1 from holidays h where h.date = d) then
      select person_id into per_day_person
        from project_owner_history
        where project_id = p_project_id and effective_from <= d and (effective_to is null or effective_to >= d)
        limit 1;
      per_day_person := coalesce(per_day_person, p.owner_id);
      if per_day_person is not null then
        insert into deleted_person_day_points (person_id, date, points) values (per_day_person, d, 0.1);
        insert into deleted_person_day_hours (person_id, date, hours) values (per_day_person, d, 0.5);
      end if;
    end if;
  end loop;
end;
$$;
