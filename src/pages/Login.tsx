import { useState, type FormEvent } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import TempoMark from "../components/TempoMark";

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // "Forgot password?" (Sandra, 2026-08-14): the recovery-link handling
  // (RequireAuth redirecting anyone with a pending "recovery" auth type to
  // /set-password) already existed for the invite flow -- this just adds
  // the missing trigger to actually send that email, for pilot users who
  // forget a password shared with them manually (no CSV-invite email).
  const [resetSent, setResetSent] = useState(false);
  const [resetSending, setResetSending] = useState(false);

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

  async function handleForgotPassword() {
    if (!email.trim()) {
      setError("Enter your email above first, then click \"Forgot password?\".");
      return;
    }
    setError(null);
    setResetSending(true);
    const redirectTo = window.location.href.split("#")[0];
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo });
    setResetSending(false);
    if (resetError) {
      setError(resetError.message);
      return;
    }
    setResetSent(true);
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
        style={{ width: 420, padding: "36px 40px", display: "flex", flexDirection: "column", gap: 16 }}
      >
        <div style={{ marginBottom: 4 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--muted)",
            }}
          >
            Dermorepubliq L&amp;D
          </div>
          <div className="login-title" style={{ fontWeight: 700, color: "var(--navy)", fontSize: 30, display: "flex", alignItems: "center", gap: 10, marginTop: 4 }}>
            <TempoMark size={32} />
            Tempo
          </div>
        </div>

        <label style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text-secondary)" }}>
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{
              display: "block",
              width: "100%",
              marginTop: 6,
              padding: "11px 13px",
              fontSize: 15,
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
            }}
          />
        </label>

        <label style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text-secondary)" }}>
          Password
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{
              display: "block",
              width: "100%",
              marginTop: 6,
              padding: "11px 13px",
              fontSize: 15,
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)",
            }}
          />
        </label>

        <button
          type="button"
          onClick={handleForgotPassword}
          disabled={resetSending}
          style={{
            alignSelf: "flex-start",
            background: "none",
            border: "none",
            padding: 0,
            fontSize: 13,
            color: "var(--accent)",
            cursor: resetSending ? "default" : "pointer",
          }}
        >
          {resetSending ? "Sending…" : "Forgot password?"}
        </button>

        {resetSent && (
          <div style={{ fontSize: 13, color: "var(--success-text)", background: "var(--success-bg)", padding: "9px 11px", borderRadius: "var(--radius-sm)" }}>
            If that email has an account, a reset link is on its way.
          </div>
        )}

        {error && (
          <div style={{ fontSize: 13, color: "var(--danger-text)", background: "var(--danger-bg)", padding: "9px 11px", borderRadius: "var(--radius-sm)" }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          style={{
            marginTop: 6,
            padding: "12px 14px",
            fontSize: 15,
            fontWeight: 600,
            color: "#fff",
            background: "var(--navy)",
            border: "none",
            borderRadius: "var(--radius-sm)",
            cursor: loading ? "default" : "pointer",
          }}
        >
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
