"use client";

import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";

const STORAGE_KEY = "atodotren:auto-refresh:v1";
const CHANGE_EVENT = "atodotren:auto-refresh-change";

interface AutoRefreshContextValue {
  readonly enabled: boolean;
  readonly setEnabled: (enabled: boolean) => void;
}

const AutoRefreshContext = createContext<AutoRefreshContextValue | null>(null);

function getSnapshot(): boolean {
  return window.localStorage.getItem(STORAGE_KEY) !== "paused";
}

function getServerSnapshot(): boolean {
  return true;
}

function subscribe(onStoreChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) onStoreChange();
  };
  const onLocalChange = () => onStoreChange();
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGE_EVENT, onLocalChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGE_EVENT, onLocalChange);
  };
}

function storeEnabled(enabled: boolean): void {
  window.localStorage.setItem(STORAGE_KEY, enabled ? "active" : "paused");
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function AutoRefreshProvider({ children }: { readonly children: ReactNode }) {
  const enabled = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const value = useMemo<AutoRefreshContextValue>(() => ({ enabled, setEnabled: storeEnabled }), [enabled]);
  return <AutoRefreshContext.Provider value={value}>{children}</AutoRefreshContext.Provider>;
}

export function useAutoRefresh(): AutoRefreshContextValue {
  const value = useContext(AutoRefreshContext);
  if (value === null) throw new Error("useAutoRefresh must be used inside AutoRefreshProvider");
  return value;
}
