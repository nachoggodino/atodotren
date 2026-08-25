"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useTransition } from "react";
import { LIVE_REFRESH_MS } from "@/lib/design/tokens";
import { useAutoRefresh } from "@/components/shell/auto-refresh-provider";
import type { Messages } from "@/messages/types";

export function LiveRefresh({ messages }: { readonly messages: Messages }) {
  const router = useRouter();
  const { enabled } = useAutoRefresh();
  const [pending, startTransition] = useTransition();
  const hiddenSinceLastRefresh = useRef(false);
  const refresh = useCallback(() => startTransition(() => router.refresh()), [router]);

  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") refresh(); else hiddenSinceLastRefresh.current = true; }, LIVE_REFRESH_MS);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") hiddenSinceLastRefresh.current = true;
      else if (hiddenSinceLastRefresh.current) { hiddenSinceLastRefresh.current = false; refresh(); }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisibility); };
  }, [enabled, refresh]);

  return <div className="mt-2 flex items-center gap-3 text-xs text-muted" aria-live="polite"><span>{enabled ? messages.live.autoRefresh : messages.nav.paused}</span>{pending ? <span>{messages.live.refreshing}</span> : null}<span className="relative h-0.5 flex-1 overflow-hidden bg-muted-soft" aria-hidden="true">{enabled ? <span key={pending ? "pending" : "idle"} className="refresh-progress absolute inset-0 bg-primary" /> : null}</span><span className="sr-only">{messages.live.hiddenTabPause}</span></div>;
}
