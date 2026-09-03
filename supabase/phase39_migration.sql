-- Phase 39 (2026-09-03): allow Full Access to correct a time entry's
-- Reason (reason_category) alongside its hours, from Time Tracking.
-- See policies.sql's correct_time_entry for the authoritative copy.

drop function if exists correct_time_entry(uuid, numeric, text);

create or replace function correct_time_entry(
  p_entry_id uuid,
  p_duration_minutes numeric,
  p_notes text,
  p_reason_category text default null
) returns void
language plpgsql security definer as $$
declare
  v_status text;
  v_current_duration numeric;
begin
  if my_access_level() <> 'full' then
    raise exception 'only Full Access can correct a finalized time entry';
  end if;

  select status, duration_minutes into v_status, v_current_duration from time_entries where id = p_entry_id;
  if v_status is null then
    raise exception 'time entry not found';
  end if;
  if v_status not in ('confirmed','approved') then
    raise exception 'only a confirmed or approved time entry can be corrected';
  end if;
  if p_duration_minutes is null or p_duration_minutes <= 0 then
    raise exception 'corrected duration must be greater than zero';
  end if;

  perform set_config('app.bypass_time_entry_lock', 'on', true);
  update time_entries
    set duration_minutes = p_duration_minutes,
        original_duration_minutes = coalesce(original_duration_minutes, v_current_duration),
        corrected_by = my_person_id(),
        corrected_at = now(),
        correction_notes = p_notes,
        reason_category = coalesce(p_reason_category, reason_category)
    where id = p_entry_id;
end;
$$;

grant execute on function correct_time_entry(uuid, numeric, text, text) to authenticated;
