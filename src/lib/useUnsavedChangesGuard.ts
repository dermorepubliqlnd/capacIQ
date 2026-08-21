import { useEffect } from "react";

/**
 * Prompts the user before closing/reloading the tab with unsaved changes.
 *
 * NOTE (2026-08-21, Phase 6 hotfix): this originally also called
 * react-router's useBlocker() to catch in-app navigation, but this app
 * mounts a plain <HashRouter> (see App.tsx), not a Data Router
 * (createHashRouter/createBrowserRouter + RouterProvider) -- useBlocker
 * throws an invariant violation outside a Data Router, which crashed
 * WBS Planning with a full white-screen React error the moment this hook
 * was actually wired in (Phase 6's staged-edit Save model). Removed the
 * useBlocker call rather than migrating the whole app's router, which
 * would be a much larger, riskier change for this. beforeunload alone
 * still covers the main risk (closing/reloading the tab); in-app
 * navigation away with unsaved changes is not currently caught.
 */
export function useUnsavedChangesGuard(hasUnsavedChanges: boolean) {
  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedChanges]);
}
