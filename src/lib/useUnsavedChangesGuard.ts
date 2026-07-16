import { useEffect } from "react";
import { useBlocker } from "react-router-dom";

/**
 * Prompts the user before navigating away from a page with unsaved
 * changes — covers both in-app route changes (extension request forms,
 * task edits) and closing/reloading the browser tab.
 */
export function useUnsavedChangesGuard(hasUnsavedChanges: boolean) {
  useBlocker(() => {
    if (!hasUnsavedChanges) return false;
    return !window.confirm("You have unsaved changes. Leave without saving?");
  });

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
