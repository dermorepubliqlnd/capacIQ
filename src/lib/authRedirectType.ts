// Supabase invite/recovery links carry their tokens as a URL hash fragment
// (e.g. "#access_token=...&type=invite"). Our app also uses hash-based
// routing (HashRouter), so both mechanisms fight over `location.hash` on
// the very first load after someone clicks one of those links.
//
// This module's only job is to read the `type` param out of the RAW hash
// the instant the page loads — before supabase-js's detectSessionInUrl
// rewrites the hash (once it finishes exchanging the token) and before
// React Router starts treating the hash as a route path. It's imported
// as the very first line of main.tsx specifically so this runs first.
//
// The captured value is stashed in sessionStorage (not just a JS variable)
// so it survives the page settling into its real route.
const KEY = "capaciq_pending_auth_type";

const match = window.location.hash.match(/type=(invite|recovery)/);
if (match) {
  sessionStorage.setItem(KEY, match[1]);
}

export function getPendingAuthType(): string | null {
  return sessionStorage.getItem(KEY);
}

export function clearPendingAuthType() {
  sessionStorage.removeItem(KEY);
}
