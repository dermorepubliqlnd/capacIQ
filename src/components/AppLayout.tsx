import { NavLink, Outlet } from "react-router-dom";

const navItems = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/projects", label: "Projects" },
  { to: "/tasks", label: "Tasks" },
  { to: "/extension-requests", label: "Extension Requests" },
  { to: "/capacity", label: "Capacity" },
];

export default function AppLayout() {
  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <nav
        style={{
          width: 200,
          borderRight: "1px solid var(--border)",
          background: "#fff",
          padding: "16px 10px",
        }}
      >
        <div style={{ fontWeight: 700, color: "var(--navy)", padding: "0 8px 16px" }}>
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
              marginBottom: 2,
              fontSize: 13,
              textDecoration: "none",
              color: isActive ? "#fff" : "var(--text)",
              background: isActive ? "var(--navy)" : "transparent",
            })}
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
