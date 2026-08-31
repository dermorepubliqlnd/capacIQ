-- ============================================================
-- Phase 29 (2026-08-31): utilization reconciliation -- deletion archive.
--
-- Companion to the app-side consolidation of the three utilization
-- surfaces onto one shared allocation engine (src/lib/dailyAllocation.ts).
-- The deletion archive is the fourth implementation of the same math, and
-- it had drifted the furthest:
--
--   1. archive_project_pm_overhead wrote PM overhead at 0.5 h/day. The
--      live constant has been PROJECT_PM_DAILY_HOURS = 0.25 since
--      2026-08-24. Permanently deleting a project therefore DOUBLED its
--      owner's historical PM hours on the Utilization grid -- the numbers
--      changed the moment the project disappeared.
--   2. Both archive functions still wrote the dead
--      deleted_person_day_points table. Nothing has read it since the
--      Phase 2 hours rewrite; the points model itself is now deleted from
--      the app entirely (utilizationCalc.ts, TASK_EFFORT_POINTS). Writing
--      it on every delete only invites a future reader to trust it.
--   3. archive_task_utilization's hours spread excluded weekends and
--      holidays but not the assignee's Time Off. The live spread now
--      excludes Off days too (they are days the person does not work, and
--      the grid renders them as "Off" with no value -- hours landing there
--      used to silently vanish). Without this the per-day figure for a
--      task changed the moment it was deleted.
--
-- Only future deletions are affected. Rows already archived under the old
-- logic are deliberately left untouched, per this app's standing
-- convention of never retroactively rewriting historical archive rows.
-- deleted_person_day_points itself is likewise left in place (data is not
-- destroyed), it simply stops being written.
-- ============================================================

create or replace function archive_task_utilization(p_task_id uuid) returns void
language plpgsql security definer as $$
declare
  t record;
  total_days int;
  d date;
  window_end date;
  per_day_person uuid;
begin
  select id, project_id, start_date, current_due_date, effort, assignee_id, estimated_hours
    into t
    from tasks where id = p_task_id;
  if not found then return; end if;

  -- Hours archive. estimated_hours spread evenly across the task's own
  -- working days -- weekends, holidays AND the assignee's Time Off
  -- excluded, exactly matching taskAllocationDays() in
  -- src/lib/dailyAllocation.ts. (Off days are resolved against the task's
  -- CURRENT assignee for both the denominator and the per-day filter: the
  -- live engine keys a task's day set by the person it is asking about,
  -- and for an archived task that is the person the row is being written
  -- for in all but the transferred-mid-flight edge case.)
  if coalesce(t.estimated_hours, 0) > 0 then
    total_days := 0;
    for d in select generate_series(
      coalesce(t.start_date, t.current_due_date),
      t.current_due_date,
      interval '1 day'
    )::date
    loop
      if extract(dow from d) not in (0, 6)
         and not exists (select 1 from holidays h where h.date = d)
         and not exists (
           select 1 from person_availability pa
           where pa.person_id = t.assignee_id and pa.date = d and pa.status = 'off'
         )
      then
        total_days := total_days + 1;
      end if;
    end loop;
    if total_days = 0 then total_days := 1; end if;

    window_end := least(t.current_due_date, current_date);
    if window_end >= coalesce(t.start_date, t.current_due_date) then
      for d in select generate_series(coalesce(t.start_date, t.current_due_date), window_end, interval '1 day')::date
      loop
        if extract(dow from d) not in (0, 6)
           and not exists (select 1 from holidays h where h.date = d)
           and not exists (
             select 1 from person_availability pa
             where pa.person_id = t.assignee_id and pa.date = d and pa.status = 'off'
           )
        then
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

create or replace function archive_project_pm_overhead(p_project_id uuid) returns void
language plpgsql security definer as $$
declare
  p record;
  d date;
  window_end date;
  pm_end date;
  per_day_person uuid;
begin
  select id, owner_id, start_date, end_date into p from projects where id = p_project_id;
  if not found or p.start_date is null then return; end if;

  -- PM window end mirrors pmWindowEnd() in src/lib/dailyAllocation.ts: the
  -- LATER of the project's committed end_date and its own latest task due
  -- date. projects.end_date alone is the frozen committed envelope once
  -- timelines are locked and stops tracking the real schedule, so archiving
  -- against it alone would drop the tail of the owner's PM overhead.
  select greatest(
           coalesce(p.end_date, '1900-01-01'::date),
           coalesce((select max(current_due_date) from tasks where project_id = p_project_id and not is_archived), '1900-01-01'::date)
         )
    into pm_end;
  if pm_end = '1900-01-01'::date then return; end if;

  window_end := least(pm_end, current_date);
  if window_end < p.start_date then return; end if;

  for d in select generate_series(p.start_date, window_end, interval '1 day')::date
  loop
    if extract(dow from d) not in (0, 6) and not exists (select 1 from holidays h where h.date = d) then
      select person_id into per_day_person
        from project_owner_history
        where project_id = p_project_id and effective_from <= d and (effective_to is null or effective_to >= d)
        limit 1;
      per_day_person := coalesce(per_day_person, p.owner_id);
      if per_day_person is not null
         and not exists (
           select 1 from person_availability pa
           where pa.person_id = per_day_person and pa.date = d and pa.status = 'off'
         )
      then
        -- 0.25, matching PROJECT_PM_DAILY_HOURS. Was 0.5.
        insert into deleted_person_day_hours (person_id, date, hours) values (per_day_person, d, 0.25);
      end if;
    end if;
  end loop;
end;
$$;
