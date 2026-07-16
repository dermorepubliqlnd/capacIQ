import { NavLink, Outlet } from "react-router-dom";

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
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "#7C8AA0",
          padding: "0 10px 6px",
        }}
      >
        {title}
      </div>
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          style={({ isActive }) => ({
            display: "block",
            padding: "7px 10px",
            borderRadius: 3,
            marginBottom: 2,
            fontSize: 12.5,
            fontWeight: isActive ? 700 : 400,
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
  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <nav
        style={{
          width: 208,
          background: "var(--navy)",
          padding: "16px 10px",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ padding: "0 10px 20px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", color: "#7C8AA0", textTransform: "uppercase" }}>
            Dermorepubliq L&amp;D
          </div>
          <div style={{ fontWeight: 700, color: "#fff", fontSize: 15 }}>CapacIQ</div>
        </div>

        <NavGroup title="Main" items={mainItems} />
        <NavGroup title="Admin" items={adminItems} />
      </nav>
      <main style={{ flex: 1, padding: 20 }}>
        <Outlet />
      </main>
    </div>
  );
}
