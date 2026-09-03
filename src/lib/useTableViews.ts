import { useEffect, useRef, useState } from "react";
import { supabase } from "./supabaseClient";
import type { TableView, DefaultView, ViewType } from "./tableTypes";

const STORAGE_PREFIX = "capaciq_views";
// How long to wait after the last change (a column drag, a resize, a
// sort tweak, ...) before writing the current view state to Supabase.
// Column resize in particular can fire many state updates a second while
// dragging -- without this, each of those would be its own round-trip.
const WRITE_DEBOUNCE_MS = 800;

function makeDefault(defaultView: DefaultView): TableView {
  return { id: "default", name: "All", ...defaultView };
}

// Shared by both the localStorage path (load, below) and the Supabase
// path (the fetch effect in useTableViews) -- backfills any fields added
// after a view was first saved (e.g. hiddenGroups, viewType) so older
// saved data doesn't crash newer code, and refreshes the "default" ("All")
// view's column order whenever PROJECT_COLUMN_ORDER/TASK_COLUMN_ORDER's
// hand-picked order changes (Sandra, 2026-09-02: re-prioritized both
// tables' default layouts). Without that second part, a saved "default"
// view's own columnOrder always wins over the new code default, so nobody
// who'd already used the app would ever see an updated order. Only the
// untouched "default" view id is refreshed this way; any other
// (person-created) view keeps whatever order it was deliberately given.
// hiddenColumns/widths/sorts/groupBy are left alone either way.
function backfillView(v: TableView, defaultView: DefaultView): TableView {
  const merged = { ...defaultView, ...v };
  if (v.id === "default" && (v.columnOrderVersion ?? 0) < (defaultView.columnOrderVersion ?? 0)) {
    merged.columnOrder = defaultView.columnOrder;
    merged.columnOrderVersion = defaultView.columnOrderVersion;
  }
  return merged;
}

function load(storageKey: string, defaultView: DefaultView): TableView[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const parsed = JSON.parse(raw) as TableView[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed.map((v) => backfillView(v, defaultView));
    }
  } catch {
    // ignore corrupt storage, fall through to default
  }
  return [makeDefault(defaultView)];
}

// Which view was last active also needs its own persisted slot -- without
// this, a refresh always fell back to views[0] (the "All" table view) no
// matter what the person was actually looking at, e.g. reloading while on
// a Timeline view silently dropped them back to the Table view (caught by
// Sandra 2026-07-22). Stored as a tiny separate key rather than folded
// into the main views array so bumping it doesn't touch the (much larger,
// already-JSON'd) view list on every tab switch.
function loadActiveId(activeKey: string, views: TableView[]): string {
  try {
    const raw = localStorage.getItem(activeKey);
    if (raw && views.some((v) => v.id === raw)) return raw;
  } catch {
    // ignore corrupt storage
  }
  return views[0].id;
}

// Notion-style saved "views" for a data table: each view remembers its own
// column order, hidden columns, widths, and grouping.
//
// Storage (Sandra, 2026-09-02): the real source of truth is now the
// person_table_views table in Supabase -- one row per (person, table_key)
// -- so a person's layout follows them across devices/browsers instead of
// resetting the moment they open a different one, or clearing site data.
// localStorage is still written on every change (same keys as before,
// `capaciq_views_<tableKey>_<personId>` / `..._active`) purely as (a) a
// fast synchronous first paint before the Supabase fetch below resolves,
// and (b) an offline fallback if a write to Supabase ever fails -- it's
// no longer where anything is read from once the initial fetch completes.
//
// Migration: the first time a person with no existing person_table_views
// row loads this hook, whatever's sitting in their browser's localStorage
// (their pre-this-feature layout) is read once and pushed up as that row,
// so nobody's current customization is silently lost in the changeover.
export function useTableViews(tableKey: string, personId: string | undefined, defaultView: DefaultView) {
  const storageKey = `${STORAGE_PREFIX}_${tableKey}_${personId ?? "anon"}`;
  const activeKey = `${storageKey}_active`;

  // Fast synchronous first paint from whatever's cached locally -- gets
  // replaced the moment the Supabase fetch below resolves (for a
  // returning person, on effectively every load, since normal render
  // beats a network round-trip).
  const [views, setViews] = useState<TableView[]>(() => load(storageKey, defaultView));
  const [activeViewId, setActiveViewId] = useState<string>(() => loadActiveId(activeKey, load(storageKey, defaultView)));

  // Guards against the write-effect below re-uploading data the instant
  // it just came DOWN from a fetch (or was seeded from legacy localStorage
  // and already written up in that same round-trip) -- without this, every
  // fetch would immediately trigger a pointless matching write.
  const skipNextWriteRef = useRef(false);
  // The write-effect no-ops until the initial Supabase fetch has actually
  // resolved once, so a person's local-only first paint never races a
  // write that would clobber whatever's already saved for them remotely.
  const readyToWriteRef = useRef(false);
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch (or migrate) this person's row from Supabase whenever the
  // person or table changes.
  useEffect(() => {
    let cancelled = false;
    readyToWriteRef.current = false;

    if (!personId) {
      // No signed-in person yet (still loading session) -- nothing to
      // fetch; keep whatever the synchronous localStorage fast-path gave.
      return;
    }

    (async () => {
      const { data, error } = await supabase
        .from("person_table_views")
        .select("views, active_view_id")
        .eq("person_id", personId)
        .eq("table_key", tableKey)
        .maybeSingle();

      if (cancelled) return;

      if (!error && data && Array.isArray(data.views) && data.views.length > 0) {
        const merged = (data.views as TableView[]).map((v) => backfillView(v, defaultView));
        const activeId = data.active_view_id && merged.some((v) => v.id === data.active_view_id) ? data.active_view_id : merged[0].id;
        skipNextWriteRef.current = true;
        setViews(merged);
        setActiveViewId(activeId);
        readyToWriteRef.current = true;
      } else {
        // No account-level row yet -- one-time migration: seed from
        // whatever's already sitting in this browser's local storage (or
        // the code default if there's nothing there), then push it up so
        // it becomes this person's account-level copy from now on.
        const legacy = load(storageKey, defaultView);
        const legacyActiveId = loadActiveId(activeKey, legacy);
        skipNextWriteRef.current = true;
        setViews(legacy);
        setActiveViewId(legacyActiveId);
        readyToWriteRef.current = true;
        const { error: upsertError } = await supabase
          .from("person_table_views")
          .upsert({ person_id: personId, table_key: tableKey, views: legacy, active_view_id: legacyActiveId }, { onConflict: "person_id,table_key" });
        if (upsertError) {
          console.error(`Couldn't migrate ${tableKey} view to your account:`, upsertError.message);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personId, tableKey]);

  // Local mirror on every change -- fast first paint next time, and an
  // offline fallback if the Supabase write below ever fails.
  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(views));
  }, [views, storageKey]);

  useEffect(() => {
    if (views.some((v) => v.id === activeViewId)) {
      localStorage.setItem(activeKey, activeViewId);
    }
  }, [activeViewId, activeKey, views]);

  // Debounced write-through to Supabase, so this person's layout is what
  // shows up the next time they (or their next device/browser) load this
  // table.
  useEffect(() => {
    if (!personId) return;
    if (skipNextWriteRef.current) {
      // This state update came FROM Supabase (or was just seeded from
      // legacy data and already written up, above) -- don't immediately
      // write it straight back.
      skipNextWriteRef.current = false;
      return;
    }
    if (!readyToWriteRef.current) return; // still waiting on the initial fetch

    if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    writeTimerRef.current = setTimeout(() => {
      supabase
        .from("person_table_views")
        .upsert({ person_id: personId, table_key: tableKey, views, active_view_id: activeViewId }, { onConflict: "person_id,table_key" })
        .then(({ error }) => {
          if (error) console.error(`Couldn't save ${tableKey} view:`, error.message);
        });
    }, WRITE_DEBOUNCE_MS);

    return () => {
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    };
  }, [views, activeViewId, personId, tableKey]);

  const activeView = views.find((v) => v.id === activeViewId) ?? views[0];

  function updateActiveView(patch: Partial<TableView>) {
    setViews((vs) => vs.map((v) => (v.id === activeView.id ? { ...v, ...patch } : v)));
  }

  function createView(name: string, viewType: ViewType = "table", initialGroupBy?: string, initialHiddenColumns?: string[]) {
    const id = `view_${Date.now()}`;
    setViews((vs) => [
      ...vs,
      {
        ...makeDefault(defaultView),
        id,
        name,
        viewType,
        groupBy: initialGroupBy ?? defaultView.groupBy,
        hiddenColumns: initialHiddenColumns ?? defaultView.hiddenColumns,
      },
    ]);
    setActiveViewId(id);
  }

  function renameView(id: string, name: string) {
    setViews((vs) => vs.map((v) => (v.id === id ? { ...v, name } : v)));
  }

  function duplicateView(id: string) {
    const source = views.find((v) => v.id === id);
    if (!source) return;
    const newId = `view_${Date.now()}`;
    const copy: TableView = { ...source, id: newId, name: `${source.name} copy` };
    setViews((vs) => {
      const idx = vs.findIndex((v) => v.id === id);
      const next = [...vs];
      next.splice(idx + 1, 0, copy);
      return next;
    });
    setActiveViewId(newId);
  }

  function setViewColor(id: string, color: string) {
    setViews((vs) => vs.map((v) => (v.id === id ? { ...v, color } : v)));
  }

  function setViewIcon(id: string, icon: string | null) {
    setViews((vs) => vs.map((v) => (v.id === id ? { ...v, icon } : v)));
  }

  function deleteView(id: string) {
    setViews((vs) => {
      const remaining = vs.filter((v) => v.id !== id);
      return remaining.length ? remaining : [makeDefault(defaultView)];
    });
    setActiveViewId((current) => {
      if (current !== id) return current;
      const remaining = views.filter((v) => v.id !== id);
      return remaining[0]?.id ?? "default";
    });
  }

  return { views, activeView, activeViewId, setActiveViewId, updateActiveView, createView, renameView, duplicateView, setViewColor, setViewIcon, deleteView };
}
