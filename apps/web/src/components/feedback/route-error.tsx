"use client";

import { RotateCcw } from "lucide-react";
import { usePathname } from "next/navigation";
import type { Messages } from "@/messages/types";
import { en } from "@/messages/en";
import { es } from "@/messages/es";

function messagesForPath(pathname: string): Messages {
  return pathname.startsWith("/en") ? en : es;
}

export function RouteError({ error, reset }: { readonly error: Error & { readonly digest?: string }; readonly reset: () => void }) {
  const pathname = usePathname();
  const messages = messagesForPath(pathname);
  return (
    <div className="page-shell pb-20 pt-12" role="alert">
      <p className="eyebrow">{messages.common.unavailable}</p>
      <h1 className="mt-3 text-3xl font-black tracking-tight">{messages.errors.temporaryTitle}</h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">{messages.errors.temporaryBody}</p>
      {error.digest ? <p className="mt-2 text-xs text-muted">{error.digest}</p> : null}
      <button className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-4 font-bold hover:bg-muted-soft" onClick={reset} type="button">
        <RotateCcw className="size-4" />{messages.errors.retry}
      </button>
    </div>
  );
}
