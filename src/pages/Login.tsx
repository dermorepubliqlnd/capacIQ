import { useState, type FormEvent } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (signInError) {
      setError(signInError.message);
      return;
    }
    const redirectTo = (location.state as { from?: string } | null)?.from || "/";
    navigate(redirectTo, { replace: true });
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="card"
        style={{ width: 320, display: "flex", flexDirection: "column", gap: 12 }}
      >
        <div style={{ marginBottom: 4 }}>
          <div
            style={{
              fontSize: "var(--font-caption)",
              fontWeight: 700,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--muted)",
            }}
          >
            Dermorepubliq L&amp;D
          </div>
          <div className="login-title" style={{ fontWeight: 700, color: "var(--navy)", fontSize: 22 }}>
            CapacIQ
          </div>
        </div>

        <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-secondary)" }}>
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{
              display: "block",
              width: "100%",
              marginTop: 4,
              padding: "7px 9px",
              fontSize: 12.5,
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
            }}
          />
        </label>

        <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-secondary)" }}>
          Password
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{
              display: "block",
              width: "100%",
              marginTop: 4,
              padding: "7px 9px",
              fontSize: 12.5,
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
            }}
          />
        </label>

        {error && (
          <div style={{ fontSize: 11.5, color: "var(--danger-text)", background: "var(--danger-bg)", padding: "6px 8px", borderRadius: "var(--radius-sm)" }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          style={{
            marginTop: 4,
            padding: "8px 10px",
            fontSize: 12.5,
            fontWeight: 600,
            color: "#fff",
            background: "var(--navy)",
            border: "none",
            cursor: loading ? "default" : "pointer",
          }}
        >
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
