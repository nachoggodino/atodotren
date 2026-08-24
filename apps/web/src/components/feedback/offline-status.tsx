"use client";

import { WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import type { Messages } from "@/messages/types";

const OFFLINE_SESSION_KEY = "atodotren:offline";

export function OfflineStatus({ messages }: { readonly messages: Messages }) {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const sync = () => {
      if (navigator.onLine) {
        sessionStorage.removeItem(OFFLINE_SESSION_KEY);
        setOffline(false);
      } else {
        sessionStorage.setItem(OFFLINE_SESSION_KEY, "1");
        setOffline(true);
      }
    };
    setOffline(!navigator.onLine || sessionStorage.getItem(OFFLINE_SESSION_KEY) === "1");
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => { window.removeEventListener("online", sync); window.removeEventListener("offline", sync); };
  }, []);
  if (!offline) return null;
  return <div className="fixed inset-x-0 bottom-3 z-[70] mx-auto flex w-[min(94vw,40rem)] items-center gap-3 rounded-xl border border-border bg-surface-strong px-4 py-3 text-sm shadow-[var(--shadow-float)]" role="status" data-testid="offline-status"><WifiOff className="size-4 shrink-0 text-warning" /><span><strong>{messages.offline.status}</strong> {messages.offline.cached}</span></div>;
}
