import { useState, type FormEvent, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { clearPendingAuthType } from "../lib/authRedirectType";

export default function SetPassword() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }

    setSubmitting(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setSubmitting(false);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    clearPendingAuthType();
    navigate("/", { replace: true });
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
        style={{ width: 340, display: "flex", flexDirection: "column", gap: 12 }}
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
            Set your password
          </div>
          <p style={{ fontSize: 11.5, color: "var(--muted)", margin: "4px 0 0" }}>
            You're signed in. Choose a password so you can log back in next time — this link only works once.
          </p>
        </div>

        <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-secondary)" }}>
          New password
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={inputStyle}
          />
        </label>

        <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-secondary)" }}>
          Confirm password
          <input
            type="password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            style={inputStyle}
          />
        </label>

        {error && (
          <div
            style={{
              fontSize: 11.5,
              color: "var(--danger-text)",
              background: "var(--danger-bg)",
              padding: "6px 8px",
              borderRadius: "var(--radius-sm)",
            }}
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting}
          style={{
            marginTop: 4,
            padding: "8px 10px",
            fontSize: 12.5,
            fontWeight: 600,
            color: "#fff",
            background: "var(--navy)",
            border: "none",
            cursor: submitting ? "default" : "pointer",
          }}
        >
          {submitting ? "Saving…" : "Save password"}
        </button>
      </form>
    </div>
  );
}

const inputStyle: CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: 4,
  padding: "7px 9px",
  fontSize: 12.5,
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
};
