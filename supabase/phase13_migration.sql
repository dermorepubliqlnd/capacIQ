-- ---------------------------------------------------------------------
-- Phase 13 migration (2026-08-21): DB-level self-deactivation guard.
--
-- Follow-on to the 2026-08-20 quality/guardrails review, Security item #2:
-- Admin.tsx's toggleActive() already blocks a Full-Access user from
-- deactivating their own account in the UI (with a clear message), but
-- the underlying `people` table update had no equivalent server-side
-- check -- unlike delete-user's admin-delete-user edge function, which
-- does refuse a self-delete server-side. Any direct write bypassing the
-- Admin screen (stray API call, future bug, direct SQL) could still
-- deactivate the caller's own account, and with a small pilot user base
-- that could mean losing all active Full-Access accounts at once with no
-- path back in.
--
-- Mirrors the existing enforce_due_date_lock / enforce_done_task_lock
-- convention: a BEFORE UPDATE trigger raises unless a transaction-local
-- bypass flag (`app.bypass_self_deactivation_guard`) is set. No caller
-- today needs that bypass -- included only for parity with the other
-- lock triggers and in case a future admin correction path needs it.
-- ---------------------------------------------------------------------

create or replace function enforce_no_self_deactivation() returns trigger
language plpgsql as $$
begin
  if NEW.is_active = false and OLD.is_active = true and NEW.id = my_person_id() then
    if coalesce(current_setting('app.bypass_self_deactivation_guard', true), '') <> 'on' then
      raise exception 'you cannot deactivate your own account -- ask another Full Access person to do it';
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists people_no_self_deactivation on people;
create trigger people_no_self_deactivation
  before update on people
  for each row execute function enforce_no_self_deactivation();
