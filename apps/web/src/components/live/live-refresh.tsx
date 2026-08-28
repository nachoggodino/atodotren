"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useAutoRefresh } from "@/components/shell/auto-refresh-provider";
import { LIVE_REFRESH_INTERVAL_MS } from "@/lib/domain/live-policy";
import type { Messages } from "@/messages/types";

export function LiveRefresh({ messages }: { readonly messages: Messages }) {
  const router = useRouter();
  const { enabled } = useAutoRefresh();
  const [pending, startTransition] = useTransition();
  const [refreshCycle, setRefreshCycle] = useState(0);
  const hiddenSinceLastRefresh = useRef(false);
  const refresh = useCallback(() => {
    setRefreshCycle((cycle) => cycle + 1);
    startTransition(() => router.refresh());
  }, [router]);

  useEffect(() => {
    if (!enabled) {
      hiddenSinceLastRefresh.current = false;
      return;
    }

    let timer: number | null = null;
    const clearTimer = () => {
      if (timer === null) return;
      window.clearTimeout(timer);
      timer = null;
    };
    const scheduleNext = () => {
      clearTimer();
      timer = window.setTimeout(() => {
        timer = null;
        if (document.visibilityState === "visible") {
          refresh();
          scheduleNext();
        } else {
          hiddenSinceLastRefresh.current = true;
        }
      }, LIVE_REFRESH_INTERVAL_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenSinceLastRefresh.current = true;
        clearTimer();
      } else if (hiddenSinceLastRefresh.current) {
        hiddenSinceLastRefresh.current = false;
        refresh();
        scheduleNext();
      }
    };

    if (document.visibilityState === "visible") scheduleNext();
    else hiddenSinceLastRefresh.current = true;
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, refresh]);

  return (
    <div className="mt-3 flex items-center gap-2.5" aria-live="polite" data-testid="live-refresh-progress">
      <RefreshCw aria-hidden="true" className={`size-3.5 shrink-0 ${pending ? "animate-spin text-primary" : "text-muted"}`} />
      <span className="relative h-1 flex-1 overflow-hidden rounded-full bg-muted-soft" aria-hidden="true">
        {enabled ? <span key={refreshCycle} className="refresh-progress absolute inset-0 rounded-full bg-primary" style={{ animationDuration: `${LIVE_REFRESH_INTERVAL_MS}ms` }} /> : null}
      </span>
      <span className="sr-only">{enabled ? messages.live.autoRefresh : messages.nav.paused}{pending ? ` · ${messages.live.refreshing}` : ""}. {messages.live.hiddenTabPause}</span>
    </div>
  );
}
