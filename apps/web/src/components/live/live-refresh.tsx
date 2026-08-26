"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useTransition } from "react";
import { useAutoRefresh } from "@/components/shell/auto-refresh-provider";
import type { Messages } from "@/messages/types";

export const LIVE_REFRESH_MS = 30_000;

export function LiveRefresh({ messages }: { readonly messages: Messages }) {
  const router = useRouter();
  const { enabled } = useAutoRefresh();
  const [pending, startTransition] = useTransition();
  const hiddenSinceLastRefresh = useRef(false);
  const refresh = useCallback(() => startTransition(() => router.refresh()), [router]);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
      else hiddenSinceLastRefresh.current = true;
    }, LIVE_REFRESH_MS);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") hiddenSinceLastRefresh.current = true;
      else if (hiddenSinceLastRefresh.current) {
        hiddenSinceLastRefresh.current = false;
        refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, refresh]);

  return (
    <div className="mt-3 flex items-center gap-2.5 px-0.5" aria-live="polite" data-testid="live-refresh-progress">
      <RefreshCw aria-hidden="true" className={`size-4 shrink-0 ${pending ? "animate-spin text-primary" : "text-muted"}`} />
      <span className="relative h-1 flex-1 overflow-hidden rounded-full bg-muted-soft" aria-hidden="true">
        {enabled ? <span key={pending ? "pending" : "idle"} className="refresh-progress absolute inset-0 rounded-full bg-primary" style={{ animationDuration: `${LIVE_REFRESH_MS}ms` }} /> : null}
      </span>
      <span className="sr-only">{enabled ? messages.live.autoRefresh : messages.nav.paused}{pending ? ` · ${messages.live.refreshing}` : ""}. {messages.live.hiddenTabPause}</span>
    </div>
  );
}
