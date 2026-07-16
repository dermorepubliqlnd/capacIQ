import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useSession } from "../lib/useSession";
import { getPendingAuthType } from "../lib/authRedirectType";

export default function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useSession();
  const location = useLocation();

  if (loading) return null;

  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  // Anyone who arrived via an invite or password-recovery link is signed in
  // automatically (that's how those links work) but hasn't set a real
  // password yet. Route them to do that first, instead of dropping them
  // straight into the app with no way to log back in later.
  if (getPendingAuthType() && location.pathname !== "/set-password") {
    return <Navigate to="/set-password" replace />;
  }

  return <>{children}</>;
}
