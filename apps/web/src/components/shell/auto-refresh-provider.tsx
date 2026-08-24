"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

const STORAGE_KEY = "atodotren:auto-refresh:v1";

interface AutoRefreshContextValue {
  readonly enabled: boolean;
  readonly setEnabled: (enabled: boolean) => void;
}

const AutoRefreshContext = createContext<AutoRefreshContextValue | null>(null);

export function AutoRefreshProvider({ children }: { readonly children: ReactNode }) {
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "paused") setEnabled(false);
  }, []);
  const value = useMemo<AutoRefreshContextValue>(() => ({
    enabled,
    setEnabled: (next) => {
      setEnabled(next);
      window.localStorage.setItem(STORAGE_KEY, next ? "active" : "paused");
    },
  }), [enabled]);
  return <AutoRefreshContext.Provider value={value}>{children}</AutoRefreshContext.Provider>;
}

export function useAutoRefresh(): AutoRefreshContextValue {
  const value = useContext(AutoRefreshContext);
  if (value === null) throw new Error("useAutoRefresh must be used inside AutoRefreshProvider");
  return value;
}
