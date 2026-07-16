import { Users, Clock3, AlertTriangle, FolderKanban } from "lucide-react";

export default function Dashboard() {
  return (
    <div>
      <h1>Dashboard</h1>
      <p className="subtitle">Team capacity, deadline health, and open requests at a glance.</p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 16 }}>
        <div className="metric-card">
          <div className="metric-icon">
            <Users size={15} />
          </div>
          <p className="metric-label">Team utilization</p>
          <p className="metric-value">78%</p>
          <p className="metric-sub">Planned, this month</p>
        </div>

        <div className="metric-card">
          <div className="metric-icon warning">
            <Clock3 size={15} />
          </div>
          <p className="metric-label">Open extension requests</p>
          <p className="metric-value">3</p>
          <p className="metric-sub">Awaiting manager decision</p>
        </div>

        <div className="metric-card">
          <div className="metric-icon danger">
            <AlertTriangle size={15} />
          </div>
          <p className="metric-label">Projects at risk</p>
          <p className="metric-value">2</p>
          <p className="metric-sub">Delayed or behind pace</p>
        </div>

        <div className="metric-card">
          <div className="metric-icon teal">
            <FolderKanban size={15} />
          </div>
          <p className="metric-label">Active projects</p>
          <p className="metric-value">12</p>
          <p className="metric-sub">In development or delivery</p>
        </div>
      </div>

      <p style={{ color: "var(--muted)", fontSize: 11 }}>
        Placeholder metrics — live data comes in Phase 3.
      </p>
    </div>
  );
}
