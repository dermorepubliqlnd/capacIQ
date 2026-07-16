import { useEffect, useState } from "react";
import type { TableView, DefaultView } from "./tableTypes";

const STORAGE_PREFIX = "capaciq_views";

function makeDefault(defaultView: DefaultView): TableView {
  return { id: "default", name: "All", ...defaultView };
}

function load(storageKey: string, defaultView: DefaultView): TableView[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const parsed = JSON.parse(raw) as TableView[];
      // Backfill any fields added after a view was first saved (e.g.
      // hiddenGroups) so older localStorage data doesn't crash newer code.
      if (Array.isArray(parsed) && parsed.length > 0) return parsed.map((v) => ({ ...defaultView, ...v }));
    }
  } catch {
    // ignore corrupt storage, fall through to default
  }
  return [makeDefault(defaultView)];
}

// Notion-style saved "views" for a data table: each view remembers its own
// column order, hidden columns, widths, and grouping. Stored per-person
// (keyed by personId) in localStorage so everyone gets their own layout.
export function useTableViews(tableKey: string, personId: string | undefined, defaultView: DefaultView) {
  const storageKey = `${STORAGE_PREFIX}_${tableKey}_${personId ?? "anon"}`;
  const [views, setViews] = useState<TableView[]>(() => load(storageKey, defaultView));
  const [activeViewId, setActiveViewId] = useState<string>(() => load(storageKey, defaultView)[0].id);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const loaded = load(storageKey, defaultView);
    setViews(loaded);
    setActiveViewId(loaded[0].id);
  }, [storageKey]);

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(views));
  }, [views, storageKey]);

  const activeView = views.find((v) => v.id === activeViewId) ?? views[0];

  function updateActiveView(patch: Partial<TableView>) {
    setViews((vs) => vs.map((v) => (v.id === activeView.id ? { ...v, ...patch } : v)));
  }

  function createView(name: string) {
    const id = `view_${Date.now()}`;
    setViews((vs) => [...vs, { ...makeDefault(defaultView), id, name }]);
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

  return { views, activeView, activeViewId, setActiveViewId, updateActiveView, createView, renameView, duplicateView, setViewColor, deleteView };
}
