import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import {
  LogOut,
  LayoutDashboard,
  FolderKanban,
  CalendarClock,
  Timer,
  Gauge,
  Scale,
  Palmtree,
  Users,
  Settings,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useSession } from "../lib/useSession";
import TimeTrackerBar from "./TimeTrackerBar";
import TempoMark from "./TempoMark";

type NavItem = { to: string; label: string; icon: LucideIcon; end?: boolean };

const mainItems: NavItem[] = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/projects", label: "Projects & Tasks", icon: FolderKanban },
  { to: "/extension-requests", label: "Extension Requests", icon: CalendarClock },
  { to: "/time-tracking", label: "Time Tracking", icon: Timer },
];

const resourcePlanningItems: NavItem[] = [
  { to: "/utilization", label: "Utilization", icon: Gauge },
  { to: "/hours-overview", label: "Scoped vs Logged", icon: Scale },
  { to: "/time-off", label: "Time Off", icon: Palmtree },
];

const adminItems: NavItem[] = [
  // `end: true` -- without it, NavLink's default prefix match makes this
  // item "active" on every /admin/* sub-route too (e.g. /admin/holidays),
  // since that path starts with /admin. Bug found 2026-09-03: Holiday
  // calendar highlighted both itself AND User management at once.
  { to: "/admin", label: "User management", icon: Users, end: true },
  { to: "/site-settings", label: "Site settings", icon: Settings },
  { to: "/admin/holidays", label: "Holiday calendar", icon: CalendarDays },
];

// Sandra, 2026-09-03: collapse the nav pane down to icons-only, to give
// the working pane (WBS/Dashboard/etc) more room on smaller screens.
// Persisted per-browser in localStorage, same convention as every other
// per-person UI preference in this app (column widths, collapsed
// groups, dismissed suggestions -- see WbsPlanning.tsx/Projects.tsx).
const NAV_COLLAPSED_STORAGE_KEY = "tempo_nav_collapsed";
const NAV_EXPANDED_WIDTH = 208;
const NAV_COLLAPSED_WIDTH = 56;

function NavGroup({ title, items, collapsed }: { title: string; items: NavItem[]; collapsed: boolean }) {
  return (
    <div style={{ marginBottom: 18 }}>
      {!collapsed && (
        <div className="nav-section-label" style={{ color: "#7C8AA0", padding: "0 10px 6px" }}>
          {title}
        </div>
      )}
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className="nav-item"
            title={collapsed ? item.label : undefined}
            style={({ isActive }) => ({
              display: "flex",
              alignItems: "center",
              gap: 9,
              justifyContent: collapsed ? "center" : "flex-start",
              padding: collapsed ? "9px 0" : "7px 10px",
              borderRadius: 3,
              marginBottom: 2,
              fontSize: 12.5,
              fontWeight: isActive ? 700 : 500,
              textDecoration: "none",
              color: isActive ? "#fff" : "#C7D0DD",
              background: isActive ? "var(--navy-deep)" : "transparent",
              borderLeft: isActive ? "3px solid var(--teal)" : "3px solid transparent",
            })}
            onMouseEnter={(e) => {
              const active = e.currentTarget.getAttribute("aria-current") === "page";
              if (!active) e.currentTarget.style.background = "rgba(255,255,255,0.06)";
            }}
            onMouseLeave={(e) => {
              const active = e.currentTarget.getAttribute("aria-current") === "page";
              if (!active) e.currentTarget.style.background = "transparent";
            }}
          >
            <Icon size={15.5} style={{ flexShrink: 0 }} />
            {!collapsed && <span>{item.label}</span>}
          </NavLink>
        );
      })}
    </div>
  );
}

export default function AppLayout() {
  const navigate = useNavigate();
  const { person } = useSession();
  const groups = person?.access_level === "full" ? [mainItems, adminItems] : [mainItems];

  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(NAV_COLLAPSED_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(NAV_COLLAPSED_STORAGE_KEY, next ? "1" : "0");
      } catch {
        // ignore -- purely a UI preference, fine to lose on a blocked store
      }
      return next;
    });
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    navigate("/login", { replace: true });
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <nav
        style={{
          width: collapsed ? NAV_COLLAPSED_WIDTH : NAV_EXPANDED_WIDTH,
          flexShrink: 0,
          background: "var(--navy)",
          padding: collapsed ? "16px 4px" : "16px 10px",
          display: "flex",
          flexDirection: "column",
          position: "relative",
          transition: "width 0.15s ease, padding 0.15s ease",
        }}
      >
        {/* 2026-09-03 (Sandra: "move the collapse/expand to the top, use
            the icon, put it in the blue bar"): a small round toggle
            straddling the sidebar's top-right edge, chevron flips
            direction with state -- same pattern as LEAP Insights'
            sidebar. Replaces the old bottom-of-sidebar "Collapse" row.
            Repositioned (2026-09-03, Sandra: "align the collapse/expand
            button along with the filter or group pills") -- top:14 sat
            level with the page H1 title, well above where a list page's
            toolbar/filter-pills row actually renders (~y100-110 on
            Projects/Tasks, confirmed live via getBoundingClientRect).
            top:108 lines the button up with that row instead. */}
        <button
          onClick={toggleCollapsed}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          style={{
            position: "absolute",
            top: 108,
            right: -12,
            width: 24,
            height: 24,
            borderRadius: "50%",
            background: "#fff",
            border: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
            cursor: "pointer",
            zIndex: 5,
            boxShadow: "0 1px 4px rgba(0,0,0,0.25)",
          }}
        >
          {collapsed ? <ChevronRight size={14} color="var(--navy)" /> : <ChevronLeft size={14} color="var(--navy)" />}
        </button>
        <div style={{ padding: collapsed ? "0 0 20px" : "0 10px 20px", display: "flex", flexDirection: "column", alignItems: collapsed ? "center" : "stretch" }}>
          {!collapsed && (
            <div
              style={{
                fontFamily: "var(--font)",
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: "0.06em",
                color: "#7C8AA0",
                textTransform: "uppercase",
              }}
            >
              Dermorepubliq L&amp;D
            </div>
          )}
          <div
            className="sidebar-appname"
            style={{ color: "#fff", display: "flex", alignItems: "center", gap: 7, justifyContent: collapsed ? "center" : "flex-start" }}
          >
            <TempoMark size={20} />
            {!collapsed && "Tempo"}
          </div>
        </div>

        <NavGroup title="Main" items={mainItems} collapsed={collapsed} />
        <NavGroup title="Resource Planning" items={resourcePlanningItems} collapsed={collapsed} />
        {groups.length > 1 && <NavGroup title="Admin" items={adminItems} collapsed={collapsed} />}

        <div className="nav-spacer" style={{ flex: 1 }} />

        {person && (
          <div style={{ padding: collapsed ? "10px 0 0" : "10px 10px 0", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
            {!collapsed && <div style={{ fontSize: 11.5, fontWeight: 600, color: "#fff", marginBottom: 2 }}>{person.name}</div>}
            <button
              onClick={handleSignOut}
              title={collapsed ? "Sign out" : undefined}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: collapsed ? "center" : "flex-start",
                gap: 5,
                width: "100%",
                background: "none",
                border: "none",
                color: "#9BA8BB",
                fontSize: 11,
                padding: 0,
                cursor: "pointer",
              }}
            >
              <LogOut size={12} /> {!collapsed && "Sign out"}
            </button>
          </div>
        )}
      </nav>
      <main style={{ flex: 1, minWidth: 0, padding: 20 }}>
        <Outlet />
      </main>
      <TimeTrackerBar />
    </div>
  );
}
