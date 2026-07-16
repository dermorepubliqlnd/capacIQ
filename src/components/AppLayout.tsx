import { NavLink, Outlet } from "react-router-dom";

const navItems = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/projects", label: "Projects" },
  { to: "/tasks", label: "Tasks" },
  { to: "/extension-requests", label: "Extension requests" },
  { to: "/capacity", label: "Capacity" },
];

export default function AppLayout() {
  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <nav
        style={{
          width: 210,
          borderRight: "1px solid var(--border)",
          background: "#fff",
          padding: "16px 10px",
        }}
      >
        <div style={{ fontWeight: 700, color: "var(--navy)", padding: "0 10px 16px", fontSize: 15 }}>
          CapacIQ
        </div>
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            style={({ isActive }) => ({
              display: "block",
              padding: "8px 10px",
              borderRadius: 6,
              marginBottom: 4,
              fontSize: 13,
              fontWeight: isActive ? 500 : 400,
              textDecoration: "none",
              color: isActive ? "#fff" : "var(--text-secondary)",
              background: isActive ? "var(--navy)" : "transparent",
              borderLeft: isActive ? "3px solid var(--teal)" : "3px solid transparent",
            })}
            onMouseEnter={(e) => {
              const active = e.currentTarget.getAttribute("aria-current") === "page";
              if (!active) {
                e.currentTarget.style.background = "var(--hover-bg)";
              }
            }}
            onMouseLeave={(e) => {
              const isActive = e.currentTarget.getAttribute("aria-current") === "page";
              if (!isActive) e.currentTarget.style.background = "transparent";
            }}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <main style={{ flex: 1, padding: 20 }}>
        <Outlet />
      </main>
    </div>
  );
}
