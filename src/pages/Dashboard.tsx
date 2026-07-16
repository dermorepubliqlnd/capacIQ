export default function Dashboard() {
  return (
    <div>
      <h1>Dashboard</h1>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 16 }}>
        <div className="metric-card">
          <p className="metric-label">Team utilization</p>
          <p className="metric-value">78%</p>
        </div>
        <div className="metric-card">
          <p className="metric-label">Open extension requests</p>
          <p className="metric-value">3</p>
        </div>
        <div className="metric-card">
          <p className="metric-label">Projects at risk</p>
          <p className="metric-value">2</p>
        </div>
        <div className="metric-card">
          <p className="metric-label">Active projects</p>
          <p className="metric-value">12</p>
        </div>
      </div>
      <p style={{ color: "var(--muted)", fontSize: 13 }}>
        Placeholder metrics — live data comes in Phase 3.
      </p>
    </div>
  );
}
