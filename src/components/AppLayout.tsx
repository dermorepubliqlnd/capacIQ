import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { LogOut } from "lucide-react";
import { supabase } from "../lib/supabaseClient";
import { useSession } from "../lib/useSession";

const mainItems = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/projects", label: "Projects" },
  { to: "/tasks", label: "Tasks" },
  { to: "/extension-requests", label: "Extension requests" },
  { to: "/capacity", label: "Capacity" },
];

const adminItems = [{ to: "/admin", label: "User management" }];

function NavGroup({ title, items }: { title: string; items: typeof mainItems }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div className="nav-section-label" style={{ color: "#7C8AA0", padding: "0 10px 6px" }}>
        {title}
      </div>
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className="nav-item"
          style={({ isActive }) => ({
            display: "block",
            padding: "7px 10px",
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
          {item.label}
        </NavLink>
      ))}
    </div>
  );
}

export default function AppLayout() {
  const navigate = useNavigate();
  const { person } = useSession();
  const groups = person?.access_level === "full" ? [mainItems, adminItems] : [mainItems];

  async function handleSignOut() {
    await supabase.auth.signOut();
    navigate("/login", { replace: true });
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <nav style={{ width: 208, background: "var(--navy)", padding: "16px 10px", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "0 10px 20px" }}>
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
          <div className="sidebar-appname" style={{ color: "#fff" }}>
            CapacIQ
          </div>
        </div>

        <NavGroup title="Main" items={mainItems} />
        {groups.length > 1 && <NavGroup title="Admin" items={adminItems} />}

        <div className="nav-spacer" style={{ flex: 1 }} />

        {person && (
          <div style={{ padding: "10px 10px 0", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: "#fff", marginBottom: 2 }}>{person.name}</div>
            <button
              onClick={handleSignOut}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                background: "none",
                border: "none",
                color: "#9BA8BB",
                fontSize: 11,
                padding: 0,
                cursor: "pointer",
              }}
            >
              <LogOut size={12} /> Sign out
            </button>
          </div>
        )}
      </nav>
      <main style={{ flex: 1, padding: 20 }}>
        <Outlet />
      </main>
    </div>
  );
}
