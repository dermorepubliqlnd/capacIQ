// Project Portfolio Dashboard (Phase 20, 2026-08-24) -- replaces the old
// Phase-3-placeholder version (hardcoded 78%/3/2/12 metric cards that
// were never wired to real data). Built from Sandra's own mockup +
// modification list: filter bar (Period/Owner/Source, no Department),
// a 7-card top stat strip (incl. a Materials Output placeholder pending
// that feature's own build), 3 donuts (Project Status, Active Project
// Health, Source), a By-Category breakdown + Portfolio Movement
// (started vs. closed, by month) row, a 5-chip Needs Attention row
// (Baseline approvals pending, Extension requests pending, At Risk,
// Overdue, Due in next 7 Days -- kept as separate chips per Sandra's
// explicit call, not merged into one "Approvals" chip), and an Active
// Projects table. Same view for every signed-in user (Sandra: "can be
// the same for everyone").
//
// Reuses healthOf/actualProgress (and their ProjectRow/TaskRow shapes)
// directly from Projects.tsx rather than re-deriving the same formulas
// here, so this page's Health/Progress numbers can never drift out of
// sync with what the Projects table itself shows for the same project.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Folder,
  Activity,
  CheckCircle2,
  PauseCircle,
  AlertTriangle,
  Clock3,
  Package,
  Search,
  Bell,
  Filter as FilterIcon,
  ChevronRight,
  ShieldQuestion,
  Ban,
  CalendarClock,
} from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { formatDate } from "../lib/formatDate";
import { colorForPerson } from "../lib/personColors";
// Category list/colors are self-service now (Phase 36, 2026-09-03) --
// fetched live from project_categories below instead of the old
// hardcoded PROJECT_CATEGORY_OPTIONS/PROJECT_CATEGORY_TONES.
import { healthOf, actualProgress, countWorkingDays, type ProjectRow, type TaskRow } from "./Projects";

interface PersonRow {
  id: string;
  name: string;
  color?: string | null;
}
interface SourceRow {
  id: string;
  name: string;
  is_active: boolean;
  sort_order: number;
}
interface PlanningTypeRow {
  id: string;
  name: string;
  is_active: boolean;
  sort_order: number;
}
interface CategoryRow {
  id: string;
  name: string;
  is_active: boolean;
  sort_order: number;
  color: string;
}
interface OutputTypeRow {
  id: string;
  name: string;
  is_active: boolean;
  sort_order: number;
}
interface ExtReqLite {
  id: string;
  status: string;
}
interface BaselineReqLite {
  id: string;
  status: string;
  project_id: string;
}
interface CloseoutLite {
  closed_at: string;
}
// Lightweight, UNFILTERED (includes archived/closed) projection used only
// for the Portfolio Movement chart's "Started" series -- a project that's
// since closed still "started" at some point, and the main `projects`
// fetch below deliberately excludes archived rows (same "the real
// portfolio in view" convention Projects.tsx itself uses).
interface ProjectStartLite {
  start_date: string | null;
}

const TODAY = new Date();
const TODAY_ISO = TODAY.toISOString().slice(0, 10);

function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function monthLabel(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short" });
}
function monthKey(iso: string): string {
  return iso.slice(0, 7); // YYYY-MM
}

// Last 8 calendar months including the current one, oldest first -- used
// as the shared x-axis for Portfolio Movement.
function lastMonths(n: number): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  const d = new Date(TODAY.getFullYear(), TODAY.getMonth(), 1);
  for (let i = n - 1; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    const key = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}`;
    out.push({ key, label: m.toLocaleDateString("en-US", { month: "short" }) });
  }
  return out;
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const HEALTH_TONE: Record<string, { fill: string; pill: string }> = {
  "On track": { fill: "#1e8a5f", pill: "success" },
  "At risk": { fill: "#b8860b", pill: "warning" },
  "Off track": { fill: "#c1443c", pill: "danger" },
  Overdue: { fill: "#c1443c", pill: "danger" },
  "Not started": { fill: "#8a94a6", pill: "neutral" },
  Completed: { fill: "#1e8a5f", pill: "success" },
  Paused: { fill: "#7b4fb0", pill: "purple" },
  "Health unavailable": { fill: "#8a94a6", pill: "neutral" },
};

const STATUS_TONE: Record<string, { fill: string; pill: string }> = {
  "Not Started": { fill: "#8a94a6", pill: "neutral" },
  "In Progress": { fill: "#2e75b6", pill: "accent" },
  Completed: { fill: "#1e8a5f", pill: "success" },
  Paused: { fill: "#b8860b", pill: "warning" },
  Cancelled: { fill: "#7b4fb0", pill: "purple" },
};

const SOURCE_PALETTE = ["#2e75b6", "#4fd1a5", "#f59e0b", "#a855f7", "#ec4899", "#06b6d4"];

// -- Small, dependency-free chart primitives ------------------------------
// No chart library is installed in this app; these two SVG components
// cover everything the mockup needs (a labeled donut, a two-series
// monthly bar chart) without adding a new dependency for one page.

function Donut({ segments, centerLabel, centerValue }: { segments: { label: string; value: number; color: string }[]; centerLabel: string; centerValue: number }) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  const radius = 52;
  const stroke = 18;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <svg viewBox="0 0 140 140" width={140} height={140}>
      <g transform="translate(70,70) rotate(-90)">
        {total === 0 ? (
          <circle r={radius} fill="none" stroke="var(--border)" strokeWidth={stroke} />
        ) : (
          segments
            .filter((seg) => seg.value > 0)
            .map((seg, i) => {
              const frac = seg.value / total;
              const dash = frac * circumference;
              const el = (
                <circle
                  key={i}
                  r={radius}
                  fill="none"
                  stroke={seg.color}
                  strokeWidth={stroke}
                  strokeDasharray={`${dash} ${circumference - dash}`}
                  strokeDashoffset={-offset}
                  strokeLinecap="butt"
                />
              );
              offset += dash;
              return el;
            })
        )}
      </g>
      <text x={70} y={66} textAnchor="middle" fontSize={20} fontWeight={700} fill="var(--navy)">
        {centerValue}
      </text>
      <text x={70} y={82} textAnchor="middle" fontSize={9.5} fill="var(--muted)">
        {centerLabel}
      </text>
    </svg>
  );
}

function DonutLegend({ segments, total }: { segments: { label: string; value: number; color: string }[]; total: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {segments.map((seg) => (
        <div key={seg.label} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: seg.color, flexShrink: 0 }} />
          <span style={{ color: "var(--text-secondary)", flex: 1 }}>{seg.label}</span>
          <span style={{ fontWeight: 600, color: "var(--navy)" }}>{seg.value}</span>
        </div>
      ))}
      {total === 0 && <div style={{ fontSize: 11, color: "var(--muted)" }}>No data yet.</div>}
    </div>
  );
}

function MonthlyBarChart({ months, series }: { months: { key: string; label: string }[]; series: { name: string; color: string; values: number[] }[] }) {
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const chartH = 140;
  return (
    <div>
      {/* preserveAspectRatio="none" (needed so the bars stretch to fill
          the card's actual width, since the viewBox is a fixed pixel grid
          unrelated to the card's real rendered width) applies a NON-
          uniform x/y scale to everything drawn in the SVG -- including
          <text>, whose glyphs get horizontally squashed/stretched along
          with the bars. Sandra: "the month text in the portfolio movement
          is stretched." Fix: keep the bars in SVG (a plain rect doesn't
          visibly suffer from non-uniform scaling) but render the month
          labels as normal HTML text in a flex row below, one per month,
          so their glyphs are never run through that transform. */}
      <svg viewBox={`0 0 ${months.length * 40} ${chartH}`} width="100%" height={chartH} preserveAspectRatio="none">
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} x1={0} x2={months.length * 40} y1={chartH - chartH * f} y2={chartH - chartH * f} stroke="var(--border)" strokeWidth={0.5} />
        ))}
        {months.map((m, i) => {
          const groupX = i * 40 + 6;
          const barW = 12;
          return (
            <g key={m.key}>
              {series.map((s, si) => {
                const v = s.values[i] ?? 0;
                const h = (v / max) * chartH;
                return (
                  <rect
                    key={s.name}
                    x={groupX + si * (barW + 3)}
                    y={chartH - h}
                    width={barW}
                    height={h}
                    fill={s.color}
                    rx={1.5}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>
      <div style={{ display: "flex", marginTop: 4 }}>
        {months.map((m) => (
          <div key={m.key} style={{ flex: 1, textAlign: "center", fontSize: 10, color: "var(--muted)" }}>
            {m.label}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 14, marginTop: 8 }}>
        {series.map((s) => (
          <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color }} />
            <span style={{ color: "var(--text-secondary)" }}>{s.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CategoryBarList({ rows, total }: { rows: { label: string; value: number; tone: string }[]; total: number }) {
  const TONE_FILL: Record<string, string> = {
    success: "#1e8a5f",
    warning: "#b8860b",
    danger: "#c1443c",
    purple: "#7b4fb0",
    pink: "#c1447e",
    neutral: "#8a94a6",
    accent: "#2e75b6",
  };
  if (total === 0) return <div style={{ fontSize: 11, color: "var(--muted)" }}>No data yet.</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {rows.map((r) => {
        const pct = Math.round((r.value / total) * 100);
        return (
          <div key={r.label}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, marginBottom: 3 }}>
              <span style={{ color: "var(--text-secondary)" }}>{r.label}</span>
              <span style={{ fontWeight: 600, color: "var(--navy)" }}>{pct}%</span>
            </div>
            <div style={{ height: 6, borderRadius: 3, background: "var(--hover-bg)", overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${pct}%`, background: TONE_FILL[r.tone] ?? "#2e75b6", borderRadius: 3 }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Materials Output's own bar list -- a two-color STACKED variant of
// CategoryBarList, per Sandra: "mark those closed green, then if still
// plotted (tentative count) make it blue, so it will be a stacked bar."
// Closed-project output is the "real"/counted number (also what the
// Materials Output stat card's own total reflects); tentative is output
// logged on a project that hasn't reached Closed yet -- shown for
// visibility, but deliberately excluded from the authoritative total per
// Sandra: "only count the output type when the project is tagged closed."
function MaterialsOutputBarList({ rows, total }: { rows: { label: string; closed: number; tentative: number }[]; total: number }) {
  if (total === 0) return <div style={{ fontSize: 11, color: "var(--muted)" }}>No output logged yet -- set Output Type + Output Count on tasks in WBS Planning.</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {rows.map((r) => {
        const rowTotal = r.closed + r.tentative;
        const closedPct = Math.round((r.closed / total) * 100);
        const tentativePct = Math.round((r.tentative / total) * 100);
        return (
          <div key={r.label}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, marginBottom: 3 }}>
              <span style={{ color: "var(--text-secondary)" }}>{r.label}</span>
              <span style={{ fontWeight: 600, color: "var(--navy)" }}>
                {rowTotal}
                {r.tentative > 0 && <span style={{ fontWeight: 400, color: "var(--muted)" }}> ({r.closed} closed, {r.tentative} tentative)</span>}
              </span>
            </div>
            <div style={{ height: 6, borderRadius: 3, background: "var(--hover-bg)", overflow: "hidden", display: "flex" }}>
              <div style={{ height: "100%", width: `${closedPct}%`, background: "var(--success-text)" }} />
              <div style={{ height: "100%", width: `${tentativePct}%`, background: "var(--accent)" }} />
            </div>
          </div>
        );
      })}
      <div style={{ display: "flex", gap: 14, marginTop: 2, fontSize: 11 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--success-text)" }} />
          <span style={{ color: "var(--text-secondary)" }}>Closed (counted)</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--accent)" }} />
          <span style={{ color: "var(--text-secondary)" }}>Tentative (not yet closed)</span>
        </div>
      </div>
    </div>
  );
}

function StatCard({
  icon,
  tone,
  label,
  value,
  placeholder,
}: {
  icon: React.ReactNode;
  tone: "teal" | "warning" | "danger" | "accent" | "neutral";
  label: string;
  value: string | number;
  placeholder?: boolean;
}) {
  return (
    <div className="metric-card" style={placeholder ? { opacity: 0.7, borderStyle: "dashed" } : undefined}>
      <div className="metric-card-row">
        <span className={`metric-icon-flat ${tone}`}>{icon}</span>
        <div>
          <p className="metric-label">{label}</p>
          <p className={`metric-value metric-value-lg metric-value-${tone}`}>{value}</p>
        </div>
      </div>
    </div>
  );
}

function AttentionChip({
  icon,
  tone,
  count,
  label,
  to,
}: {
  icon: React.ReactNode;
  tone: "danger" | "warning" | "accent" | "purple";
  count: number;
  label: string;
  to: string;
}) {
  // Flat (no circle-background) icon, colored per tone, and the whole
  // chip gets a light tinted card fill in that same tone -- per Sandra's
  // mockup ("follow the light card fill color too") -- rather than every
  // chip sharing one plain white surface with only the icon/count colored.
  // Sizing bumped ~1.5x across the board ("increase all objects by .5
  // more") from the original compact chip.
  const TONE_COLOR: Record<string, string> = {
    danger: "var(--danger-text)",
    warning: "var(--warning-text)",
    accent: "var(--accent)",
    purple: "var(--purple-text)",
  };
  const TONE_BG: Record<string, string> = {
    danger: "var(--danger-bg)",
    warning: "var(--warning-bg)",
    accent: "var(--accent-bg)",
    purple: "var(--purple-bg)",
  };
  return (
    <Link
      to={to}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "13px 18px",
        border: "none",
        borderRadius: "var(--radius-md)",
        background: TONE_BG[tone],
        textDecoration: "none",
        flex: "1 1 180px",
        minWidth: 170,
      }}
    >
      <span style={{ color: TONE_COLOR[tone], display: "flex" }}>{icon}</span>
      <span style={{ fontSize: 22, fontWeight: 700, color: TONE_COLOR[tone] }}>{count}</span>
      <span style={{ fontSize: 12, color: "var(--text-secondary)", flex: 1 }}>{label}</span>
      <ChevronRight size={19} color="var(--muted)" />
    </Link>
  );
}

export default function Dashboard() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [planningTypes, setPlanningTypes] = useState<PlanningTypeRow[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [outputTypes, setOutputTypes] = useState<OutputTypeRow[]>([]);
  const [holidayDates, setHolidayDates] = useState<Set<string>>(new Set());
  const [extReqs, setExtReqs] = useState<ExtReqLite[]>([]);
  const [baselineReqs, setBaselineReqs] = useState<BaselineReqLite[]>([]);
  const [closeouts, setCloseouts] = useState<CloseoutLite[]>([]);
  const [allProjectStarts, setAllProjectStarts] = useState<ProjectStartLite[]>([]);
  const [loading, setLoading] = useState(true);

  const [periodFilter, setPeriodFilter] = useState<"all" | "month" | "quarter" | "year">("all");
  const [ownerFilter, setOwnerFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");

  useEffect(() => {
    (async () => {
      const [
        { data: projectData },
        { data: taskData },
        { data: peopleData },
        { data: sourceData },
        { data: categoryData },
        { data: outputTypeData },
        { data: holidayData },
        { data: extReqData },
        { data: baselineReqData },
        { data: closeoutData },
        { data: allStartsData },
        { data: planningTypeData },
      ] = await Promise.all([
        supabase.from("projects").select("*").eq("is_archived", false),
        supabase.from("tasks").select("*").eq("is_archived", false),
        supabase.from("people").select("id,name,color").eq("is_active", true),
        supabase.from("project_sources").select("id,name,is_active,sort_order").order("sort_order"),
        supabase.from("project_categories").select("id,name,is_active,sort_order,color").order("sort_order"),
        supabase.from("output_types").select("id,name,is_active,sort_order").order("sort_order"),
        supabase.from("holidays").select("date"),
        supabase.from("extension_requests").select("id,status"),
        supabase.from("project_baseline_requests").select("id,status,project_id"),
        supabase.from("project_closeouts").select("closed_at"),
        supabase.from("projects").select("start_date"),
        supabase.from("project_planning_types").select("id,name,is_active,sort_order").order("sort_order"),
      ]);
      setProjects((projectData as ProjectRow[]) ?? []);
      setTasks((taskData as TaskRow[]) ?? []);
      setPeople((peopleData as PersonRow[]) ?? []);
      setSources((sourceData as SourceRow[]) ?? []);
      setCategories((categoryData as CategoryRow[]) ?? []);
      setOutputTypes((outputTypeData as OutputTypeRow[]) ?? []);
      setHolidayDates(new Set(((holidayData as { date: string }[]) ?? []).map((h) => h.date)));
      setExtReqs((extReqData as ExtReqLite[]) ?? []);
      setBaselineReqs((baselineReqData as BaselineReqLite[]) ?? []);
      setCloseouts((closeoutData as CloseoutLite[]) ?? []);
      setAllProjectStarts((allStartsData as ProjectStartLite[]) ?? []);
      setPlanningTypes((planningTypeData as PlanningTypeRow[]) ?? []);
      setLoading(false);
    })();
  }, []);

  const ownerName = (id: string | null) => people.find((p) => p.id === id)?.name ?? "Unassigned";

  // Period filter -- applied against a project's own Start date, same
  // dimension Portfolio Movement's own "Started" series buckets by.
  const periodMatches = (p: ProjectRow): boolean => {
    if (periodFilter === "all" || !p.start_date) return true;
    const start = p.start_date.slice(0, 10);
    if (periodFilter === "month") return start.slice(0, 7) === TODAY_ISO.slice(0, 7);
    if (periodFilter === "quarter") {
      const startDate = new Date(start + "T00:00:00");
      const q = Math.floor(startDate.getMonth() / 3);
      const nowQ = Math.floor(TODAY.getMonth() / 3);
      return startDate.getFullYear() === TODAY.getFullYear() && q === nowQ;
    }
    return start.slice(0, 4) === TODAY_ISO.slice(0, 4); // year
  };

  const filteredProjects = useMemo(
    () =>
      projects.filter(
        (p) =>
          periodMatches(p) &&
          (ownerFilter === "all" || p.owner_id === ownerFilter) &&
          (sourceFilter === "all" || p.source_id === sourceFilter)
      ),
    [projects, periodFilter, ownerFilter, sourceFilter]
  );

  const filteredProjectIds = useMemo(() => new Set(filteredProjects.map((p) => p.id)), [filteredProjects]);

  const stats = useMemo(() => {
    const total = filteredProjects.length;
    const active = filteredProjects.filter((p) => p.status === "In Progress").length;
    const completed = filteredProjects.filter((p) => p.status === "Completed").length;
    const onHold = filteredProjects.filter((p) => p.status === "Paused").length;
    let atRisk = 0;
    let overdue = 0;
    for (const p of filteredProjects) {
      const h = healthOf(p, tasks, holidayDates).label;
      if (h === "At risk" || h === "Off track") atRisk++;
      if (h === "Overdue") overdue++;
    }
    return { total, active, completed, onHold, atRisk, overdue };
  }, [filteredProjects, tasks, holidayDates]);

  const statusDonut = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const p of filteredProjects) {
      const key = p.status ?? "Not Started";
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return Object.entries(counts).map(([label, value]) => ({
      label,
      value,
      color: STATUS_TONE[label]?.fill ?? "#8a94a6",
    }));
  }, [filteredProjects]);

  const healthDonut = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const p of filteredProjects) {
      const key = healthOf(p, tasks, holidayDates).label;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return Object.entries(counts).map(([label, value]) => ({
      label,
      value,
      color: HEALTH_TONE[label]?.fill ?? "#8a94a6",
    }));
  }, [filteredProjects, tasks, holidayDates]);

  const sourceDonut = useMemo(() => {
    const counts: Record<string, number> = {};
    let unset = 0;
    for (const p of filteredProjects) {
      if (!p.source_id) {
        unset++;
        continue;
      }
      counts[p.source_id] = (counts[p.source_id] ?? 0) + 1;
    }
    const segs = sources
      .filter((s) => counts[s.id])
      .map((s, i) => ({ label: s.name, value: counts[s.id] ?? 0, color: SOURCE_PALETTE[i % SOURCE_PALETTE.length] }));
    if (unset) segs.push({ label: "Not set", value: unset, color: "#c7cdd6" });
    return segs;
  }, [filteredProjects, sources]);

  const planningTypeDonut = useMemo(() => {
    const counts: Record<string, number> = {};
    let unset = 0;
    for (const p of filteredProjects) {
      if (!p.planning_type_id) {
        unset++;
        continue;
      }
      counts[p.planning_type_id] = (counts[p.planning_type_id] ?? 0) + 1;
    }
    const segs = planningTypes
      .filter((t) => counts[t.id])
      .map((t, i) => ({ label: t.name, value: counts[t.id] ?? 0, color: SOURCE_PALETTE[i % SOURCE_PALETTE.length] }));
    if (unset) segs.push({ label: "Not set", value: unset, color: "#c7cdd6" });
    return segs;
  }, [filteredProjects, planningTypes]);

  const categoryRows = useMemo(() => {
    const counts: Record<string, number> = {};
    let uncategorized = 0;
    for (const p of filteredProjects) {
      if (!p.category) {
        uncategorized++;
        continue;
      }
      counts[p.category] = (counts[p.category] ?? 0) + 1;
    }
    const toneByName = Object.fromEntries(categories.map((c) => [c.name, c.color]));
    // 2026-09-03 bugfix: this used to filter against a hardcoded
    // PROJECT_CATEGORY_OPTIONS list, so any category added after that list
    // was written (or any custom one Sandra adds herself now that
    // Categories are self-service) silently vanished from this breakdown
    // even with real project counts. Iterate the actual counted names
    // instead -- tone still comes from the live project_categories table,
    // falling back to neutral for a name with no matching row.
    const rows = Object.keys(counts).map((c) => ({
      label: c,
      value: counts[c],
      tone: toneByName[c] ?? "neutral",
    }));
    if (uncategorized) rows.push({ label: "Uncategorized", value: uncategorized, tone: "neutral" });
    return rows.sort((a, b) => b.value - a.value);
  }, [filteredProjects, categories]);

  // Category moved from its own row-3 bar list into a 4th row-2 donut
  // (Sandra: "moving the category breakdown into the 2nd row as a donut
  // too") -- same counts as categoryRows above, just re-shaped for Donut's
  // {label,value,color} contract with hex colors instead of tone classes.
  const categoryDonut = useMemo(
    () => categoryRows.map((r, i) => ({ label: r.label, value: r.value, color: SOURCE_PALETTE[i % SOURCE_PALETTE.length] })),
    [categoryRows]
  );

  // Materials Output (Phase 21, 2026-08-24; stacked-bar redesign
  // 2026-08-24): takes over By Category's old row-3 slot. Sums
  // tasks.output_count grouped by Output Type, scoped to tasks belonging
  // to a currently-filtered project (same period/owner/source filters as
  // everything else on this page) -- split into a "closed" bucket
  // (project's wbs_status === "closed", the only output that actually
  // counts per Sandra) and a "tentative" bucket (everything else --
  // logged, but the project isn't done yet, so it's a preview number, not
  // a final one).
  const projectClosedById = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const p of filteredProjects) m.set(p.id, p.wbs_status === "closed");
    return m;
  }, [filteredProjects]);

  const materialsOutputRows = useMemo(() => {
    const closedCounts: Record<string, number> = {};
    const tentativeCounts: Record<string, number> = {};
    let untypedClosed = 0;
    let untypedTentative = 0;
    for (const t of tasks) {
      if (!filteredProjectIds.has(t.project_id)) continue;
      const n = t.output_count ?? 0;
      if (n <= 0) continue;
      const isClosed = projectClosedById.get(t.project_id) ?? false;
      if (!t.output_type_id) {
        if (isClosed) untypedClosed += n;
        else untypedTentative += n;
        continue;
      }
      if (isClosed) closedCounts[t.output_type_id] = (closedCounts[t.output_type_id] ?? 0) + n;
      else tentativeCounts[t.output_type_id] = (tentativeCounts[t.output_type_id] ?? 0) + n;
    }
    const rows = outputTypes
      .filter((o) => closedCounts[o.id] || tentativeCounts[o.id])
      .map((o) => ({ label: o.name, closed: closedCounts[o.id] ?? 0, tentative: tentativeCounts[o.id] ?? 0 }));
    if (untypedClosed || untypedTentative) rows.push({ label: "Untyped", closed: untypedClosed, tentative: untypedTentative });
    return rows.sort((a, b) => b.closed + b.tentative - (a.closed + a.tentative));
  }, [tasks, filteredProjectIds, projectClosedById, outputTypes]);

  // Stat card total: closed-only, per Sandra ("only count the output type
  // when the project is tagged closed") -- the headline number is the
  // real, final count, never a still-in-progress preview.
  const materialsOutputTotal = useMemo(() => materialsOutputRows.reduce((sum, r) => sum + r.closed, 0), [materialsOutputRows]);
  // Grand total (closed + tentative) is only used to scale the stacked
  // bar list's percentages, so the chart visually represents everything
  // plotted so far, not just the counted portion.
  const materialsOutputGrandTotal = useMemo(
    () => materialsOutputRows.reduce((sum, r) => sum + r.closed + r.tentative, 0),
    [materialsOutputRows]
  );

  const portfolioMovement = useMemo(() => {
    const months = lastMonths(8);
    const startedByMonth = new Map<string, number>();
    for (const p of allProjectStarts) {
      if (!p.start_date) continue;
      const key = monthKey(p.start_date.slice(0, 10));
      startedByMonth.set(key, (startedByMonth.get(key) ?? 0) + 1);
    }
    const closedByMonth = new Map<string, number>();
    for (const c of closeouts) {
      const key = monthKey(c.closed_at.slice(0, 10));
      closedByMonth.set(key, (closedByMonth.get(key) ?? 0) + 1);
    }
    return {
      months,
      series: [
        { name: "Started", color: "#2e75b6", values: months.map((m) => startedByMonth.get(m.key) ?? 0) },
        { name: "Closed", color: "#4fd1a5", values: months.map((m) => closedByMonth.get(m.key) ?? 0) },
      ],
    };
  }, [allProjectStarts, closeouts]);

  const needsAttention = useMemo(() => {
    const baselinePending = baselineReqs.filter((r) => r.status === "pending" && filteredProjectIds.has(r.project_id)).length;
    const extPending = extReqs.filter((r) => r.status === "Pending").length; // extension requests aren't project-scoped in this projection
    const dueSoonCutoff = addDaysISO(TODAY_ISO, 7);
    const dueSoon = filteredProjects.filter((p) => {
      if (!p.end_date || p.status === "Completed" || p.status === "Cancelled") return false;
      const end = p.end_date.slice(0, 10);
      return end >= TODAY_ISO && end <= dueSoonCutoff;
    }).length;
    return {
      baselinePending,
      extPending,
      atRisk: stats.atRisk,
      overdue: stats.overdue,
      dueSoon,
    };
  }, [baselineReqs, extReqs, filteredProjects, filteredProjectIds, stats.atRisk, stats.overdue]);

  const activeProjectsList = useMemo(
    () =>
      filteredProjects
        .filter((p) => p.status !== "Completed" && p.status !== "Cancelled")
        .map((p) => ({
          project: p,
          health: healthOf(p, tasks, holidayDates),
          progress: actualProgress(p.id, tasks),
        }))
        .sort((a, b) => (a.health.label === "Overdue" ? -1 : b.health.label === "Overdue" ? 1 : 0))
        .slice(0, 8),
    [filteredProjects, tasks, holidayDates]
  );

  if (loading) {
    return (
      <div>
        <h1>Project Portfolio Dashboard</h1>
        <p className="subtitle">Loading…</p>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
        <div>
          <h1>Project Portfolio Dashboard</h1>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, border: "1px solid var(--border)", borderRadius: "var(--radius-btn)", padding: "6px 10px", background: "var(--surface)" }}>
            <Search size={13} color="var(--muted)" />
            <input
              placeholder="Search projects, owners…"
              style={{ border: "none", outline: "none", fontSize: 11.5, width: 170, background: "transparent" }}
              disabled
              title="Coming soon"
            />
          </div>
          <Bell size={16} color="var(--muted)" />
          <FilterIcon size={16} color="var(--muted)" />
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        <select value={periodFilter} onChange={(e) => setPeriodFilter(e.target.value as typeof periodFilter)} style={selectStyle}>
          <option value="all">Period: All Time</option>
          <option value="month">Period: This Month</option>
          <option value="quarter">Period: This Quarter</option>
          <option value="year">Period: This Year</option>
        </select>
        <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)} style={selectStyle}>
          <option value="all">Owner: All Owners</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              Owner: {p.name}
            </option>
          ))}
        </select>
        <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} style={selectStyle}>
          <option value="all">Source: All Sources</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              Source: {s.name}
            </option>
          ))}
        </select>
      </div>

      {/* Top stat strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 16 }}>
        <StatCard icon={<Folder size={26} />} tone="accent" label="Total Projects" value={stats.total} />
        <StatCard icon={<Activity size={26} />} tone="accent" label="Active" value={stats.active} />
        <StatCard icon={<CheckCircle2 size={26} />} tone="teal" label="Completed" value={stats.completed} />
        <StatCard icon={<PauseCircle size={26} />} tone="warning" label="On Hold" value={stats.onHold} />
        <StatCard icon={<AlertTriangle size={26} />} tone="warning" label="At Risk" value={stats.atRisk} />
        <StatCard icon={<Clock3 size={26} />} tone="danger" label="Overdue" value={stats.overdue} />
        <StatCard icon={<Package size={26} />} tone="neutral" label="Materials Output" value={materialsOutputTotal} />
      </div>

      {/* Row 2: 4 donuts (Category moved in here, per Sandra: "moving the
          category breakdown into the 2nd row as a donut too") */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 10, marginBottom: 16 }}>
        <div className="card">
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 10 }}>Project Status</div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <Donut segments={statusDonut} centerLabel="Total" centerValue={stats.total} />
            <DonutLegend segments={statusDonut} total={stats.total} />
          </div>
        </div>
        <div className="card">
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 10 }}>Active Project Health</div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <Donut segments={healthDonut} centerLabel="Projects" centerValue={filteredProjects.length} />
            <DonutLegend segments={healthDonut} total={filteredProjects.length} />
          </div>
        </div>
        <div className="card">
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 10 }}>Source</div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <Donut segments={sourceDonut} centerLabel="Total" centerValue={stats.total} />
            <DonutLegend segments={sourceDonut} total={stats.total} />
          </div>
        </div>
        <div className="card">
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 10 }}>By Category</div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <Donut segments={categoryDonut} centerLabel="Total" centerValue={filteredProjects.length} />
            <DonutLegend segments={categoryDonut} total={filteredProjects.length} />
          </div>
        </div>
        <div className="card">
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 10 }}>Planning Type</div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <Donut segments={planningTypeDonut} centerLabel="Total" centerValue={stats.total} />
            <DonutLegend segments={planningTypeDonut} total={stats.total} />
          </div>
        </div>
      </div>

      {/* Row 3: Materials Output (took over By Category's old bar-list
          slot) + Portfolio Movement */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
        <div className="card">
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 10 }}>Materials Output</div>
          <MaterialsOutputBarList rows={materialsOutputRows} total={materialsOutputGrandTotal} />
        </div>
        <div className="card">
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 10 }}>Portfolio Movement</div>
          <div style={{ fontSize: 10.5, color: "var(--muted)", marginBottom: 6 }}>By Start month vs. Closed month -- last 8 months, all projects</div>
          <MonthlyBarChart months={portfolioMovement.months} series={portfolioMovement.series} />
        </div>
      </div>

      {/* Needs Attention */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 10 }}>Needs Attention</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          <AttentionChip icon={<ShieldQuestion size={24} />} tone="purple" count={needsAttention.baselinePending} label="Baseline approvals pending" to="/projects" />
          <AttentionChip icon={<Clock3 size={24} />} tone="accent" count={needsAttention.extPending} label="Extension requests pending" to="/extension-requests" />
          <AttentionChip icon={<AlertTriangle size={24} />} tone="warning" count={needsAttention.atRisk} label="At risk" to="/projects" />
          <AttentionChip icon={<Ban size={24} />} tone="danger" count={needsAttention.overdue} label="Overdue" to="/projects" />
          <AttentionChip icon={<CalendarClock size={24} />} tone="accent" count={needsAttention.dueSoon} label="Due in next 7 days" to="/projects" />
        </div>
      </div>

      {/* Active Projects table */}
      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>Active Projects</div>
          <Link to="/projects" style={{ fontSize: 11.5, color: "var(--accent)", fontWeight: 600, textDecoration: "none" }}>
            View All
          </Link>
        </div>
        <table className="data-table" style={{ width: "100%" }}>
          <thead>
            <tr>
              <th>Project</th>
              <th>Health</th>
              <th>Progress</th>
              <th>Owner</th>
              <th>Timeline</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {activeProjectsList.length === 0 && (
              <tr>
                <td colSpan={6} style={{ color: "var(--muted)" }}>
                  No active projects in the current view.
                </td>
              </tr>
            )}
            {activeProjectsList.map(({ project: p, health, progress }) => {
              const owner = people.find((pe) => pe.id === p.owner_id);
              const sourceName = sources.find((s) => s.id === p.source_id)?.name;
              return (
                <tr key={p.id}>
                  <td style={{ fontWeight: 600, color: "var(--navy)" }}>
                    <Link to={`/projects/${p.id}/wbs`} style={{ color: "inherit", textDecoration: "none" }}>
                      {p.name}
                    </Link>
                  </td>
                  <td>
                    <span className={`status-pill ${HEALTH_TONE[health.label]?.pill ?? "neutral"}`}>{health.label}</span>
                  </td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div style={{ width: 70, height: 6, borderRadius: 3, background: "var(--hover-bg)", overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${progress ?? 0}%`, background: "#2e75b6", borderRadius: 3 }} />
                      </div>
                      <span style={{ fontSize: 11, color: "var(--muted)" }}>{progress === null ? "—" : `${progress}%`}</span>
                    </div>
                  </td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span
                        style={{
                          width: 20,
                          height: 20,
                          borderRadius: "50%",
                          background: colorForPerson(owner ? { id: owner.id, color: owner.color } : null),
                          color: "#fff",
                          fontSize: 9,
                          fontWeight: 700,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        {owner ? initialsFor(owner.name) : "?"}
                      </span>
                      <span style={{ fontSize: 11.5 }}>{ownerName(p.owner_id)}</span>
                    </div>
                  </td>
                  <td style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                    {p.start_date ? formatDate(p.start_date) : "—"} – {p.end_date ? formatDate(p.end_date) : "—"}
                  </td>
                  <td style={{ fontSize: 11, color: "var(--text-secondary)" }}>{sourceName ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  fontSize: 11.5,
  fontWeight: 600,
  color: "var(--navy)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  padding: "6px 10px",
  background: "var(--surface)",
};
