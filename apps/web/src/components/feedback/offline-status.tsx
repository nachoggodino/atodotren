import { WifiOff } from "lucide-react";
import type { Messages } from "@/messages/types";

export function OfflineStatus({ messages }: { readonly messages: Messages }) {
  return <div className="offline-status fixed inset-x-0 bottom-3 z-[70] mx-auto w-[min(94vw,40rem)] items-center gap-3 rounded-xl border border-border bg-surface-strong px-4 py-3 text-sm shadow-[var(--shadow-float)]" role="status" data-testid="offline-status"><WifiOff className="size-4 shrink-0 text-warning" /><span><strong>{messages.offline.status}</strong> {messages.offline.cached}</span></div>;
}
