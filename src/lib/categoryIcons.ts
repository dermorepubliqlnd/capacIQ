// Self-service Project Category icons/colors (Phase 36, 2026-09-03).
//
// Category names themselves are admin-editable (project_categories table,
// managed in Site Settings). Each category also carries an `icon` (a key
// into CATEGORY_ICON_LIBRARY below) and a `color` (a key into
// CATEGORY_TONE_COLOR / one of the app's existing status-pill tones) --
// both stored as plain text columns on project_categories and picked by
// Sandra from the fixed palettes below, rather than hardcoded per name in
// Projects.tsx like before. A category row with an icon name not present
// in this library (or none set) falls back to Folder/neutral -- this can
// only happen if the DB value drifts from what the picker offers, since
// the picker only ever writes a name from this exact list.
//
// Keeping this list here (rather than duplicated in Projects.tsx and
// SiteSettings.tsx) is what lets the "Manage Project Categories" picker
// grid and the actual rendered badges everywhere else (Projects table,
// Board, Timeline, Dashboard) always stay in sync automatically.
import {
  Folder,
  Handshake,
  ShieldCheck,
  Cpu,
  Crown,
  TrendingUp,
  Wrench,
  Sparkles,
  Settings2,
  ClipboardList,
  BookOpen,
  GraduationCap,
  Users,
  Target,
  Rocket,
  Lightbulb,
  FileText,
  Layers,
  Calendar,
  MessageSquare,
  Award,
  Briefcase,
  Building2,
  Compass,
  type LucideIcon,
} from "lucide-react";

// 24 icons total -- the original 7 hardcoded categories' icons (Handshake,
// ShieldCheck, Cpu, Crown, TrendingUp, Wrench, Sparkles) plus Folder (the
// fallback) and 16 more general-purpose options, so there's always a
// reasonable fit for any new category name Sandra adds.
export const CATEGORY_ICON_LIBRARY: Record<string, LucideIcon> = {
  Folder,
  Handshake,
  ShieldCheck,
  Cpu,
  Crown,
  TrendingUp,
  Wrench,
  Sparkles,
  Settings2,
  ClipboardList,
  BookOpen,
  GraduationCap,
  Users,
  Target,
  Rocket,
  Lightbulb,
  FileText,
  Layers,
  Calendar,
  MessageSquare,
  Award,
  Briefcase,
  Building2,
  Compass,
};

export const CATEGORY_ICON_NAMES = Object.keys(CATEGORY_ICON_LIBRARY);

// Matches the existing .status-pill.* tones already used app-wide (see
// index.css) so a category badge's color always looks consistent with
// every other status/priority/phase pill in the app.
export const CATEGORY_TONE_NAMES = [
  "neutral",
  "accent",
  "success",
  "warning",
  "danger",
  "purple",
  "pink",
  "gold",
  "mint",
] as const;
export type CategoryTone = (typeof CATEGORY_TONE_NAMES)[number];

// Solid hex/CSS-var color for rendering an SVG icon in a given tone
// (status-pill classes only style background+text of pill/badge elements,
// not a standalone icon's stroke color).
export const CATEGORY_TONE_ICON_COLOR: Record<string, string> = {
  success: "var(--success-text)",
  warning: "var(--warning-text)",
  danger: "var(--danger-text)",
  neutral: "var(--muted)",
  accent: "var(--accent)",
  purple: "#7b4fb0",
  pink: "#c1447e",
  gold: "#a3790a",
  mint: "#3f9d6e",
  // Slate: see TONE_STYLES.slate in tableTypes.ts -- kept in sync here so
  // this map (reused by Dashboard.tsx for donut-chart fill colors, not
  // just category icons) never falls back to a mismatched color for it.
  slate: "#5b6472",
};
