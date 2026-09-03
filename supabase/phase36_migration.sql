-- Phase 36 (2026-09-03): self-service icon + color for Project Categories.
-- Sandra: "let's do self service" for category icons (previously hardcoded
-- in Projects.tsx's PROJECT_CATEGORY_ICON_COMPONENTS/PROJECT_CATEGORY_TONES
-- maps, so a brand-new custom category always fell back to a generic
-- Folder icon / neutral color with no way for her to change it herself).
--
-- Adds icon/color columns to project_categories, backfilled to match the
-- exact icon+tone each of the 7 existing hardcoded categories already had,
-- so nothing visually changes for existing data -- only new/edited
-- categories going forward use the new self-service picker in Site
-- Settings (see src/lib/categoryIcons.ts for the fixed icon/tone palettes
-- the picker offers).

alter table project_categories add column if not exists icon text not null default 'Folder';
alter table project_categories add column if not exists color text not null default 'neutral';

update project_categories set icon = 'Handshake', color = 'warning' where name = 'Onboarding';
update project_categories set icon = 'ShieldCheck', color = 'warning' where name = 'Compliance & Safety';
update project_categories set icon = 'Cpu', color = 'success' where name = 'Technical & Systems';
update project_categories set icon = 'Crown', color = 'purple' where name = 'Leadership';
update project_categories set icon = 'TrendingUp', color = 'pink' where name = 'Professional Development';
update project_categories set icon = 'Wrench', color = 'danger' where name = 'Operational Support';
update project_categories set icon = 'Sparkles', color = 'neutral' where name = 'L&D Improvments';
