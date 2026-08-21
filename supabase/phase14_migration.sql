-- ---------------------------------------------------------------------
-- Phase 14 migration (2026-08-21): Fixed-Schedule work types.
--
-- Sandra flagged a real gap in the capacity-aware scheduler
-- ([[project_capaciq_workload_utilization_refactor]]): a person's
-- forward-walk treats ALL work as flexible -- if a day is already full,
-- a task's remaining hours quietly defer to the next day. That's the
-- right behavior for most work (Instructional Design, Content
-- Development, etc. genuinely CAN shift), but wrong for something like
-- Training Delivery: a trainer running two sessions today, plus prep/
-- reporting on top, is genuinely over capacity TODAY -- deferring the
-- overflow to tomorrow hides the real problem instead of surfacing it.
--
-- This migration just adds the admin-configurable flag; the actual
-- scheduling behavior change is in capacityScheduler.ts (see
-- [[project_capaciq_phase3_fixed_schedule_work_types]]).
-- ---------------------------------------------------------------------

alter table work_types add column if not exists is_fixed_schedule boolean not null default false;

-- Seed: Training Delivery is the concrete case that prompted this --
-- admin-editable afterward from Site Settings like everything else here.
update work_types set is_fixed_schedule = true where name = 'Training Delivery';
