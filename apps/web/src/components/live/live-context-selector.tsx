"use client";

import * as Ariakit from "@ariakit/react";
import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { CSSProperties } from "react";
import { lineBadgeTextColor } from "@/components/line-badge";
import { EntitySearch } from "@/components/search/entity-search";
import type { Lang } from "@/lib/domain/contracts";
import { MADRID_NETWORK } from "@/lib/domain/network";
import type { Messages } from "@/messages/types";

const QUICK_LINES = Object.entries(MADRID_NETWORK.lineColors).map(([slug, color]) => ({
  slug,
  code: slug.toUpperCase(),
  color,
}));

export function LiveContextSelector({
  subtitle,
  contextColor,
  lang,
  messages,
}: {
  readonly subtitle: string;
  readonly contextColor: string | undefined;
  readonly lang: Lang;
  readonly messages: Messages;
}) {
  const [open, setOpen] = useState(false);
  const contextStyle: CSSProperties | undefined = contextColor === undefined
    ? undefined
    : { backgroundColor: contextColor, color: lineBadgeTextColor(contextColor) };

  return (
    <Ariakit.PopoverProvider open={open} setOpen={setOpen} placement="bottom-start">
      <Ariakit.PopoverDisclosure
        className={`-translate-y-1 inline-flex max-w-full min-w-0 items-center gap-1 rounded-md px-2.5 py-1 text-xs font-black uppercase tracking-[.08em] outline-none transition-[filter,transform,opacity] duration-100 hover:brightness-95 active:scale-[.97] active:opacity-75 focus-visible:ring-2 focus-visible:ring-primary ${contextColor === undefined ? "bg-[var(--live-context-neutral)] text-[var(--live-context-neutral-foreground)]" : ""}`}
        data-context-tone={contextColor === undefined ? "neutral" : "line"}
        data-testid="live-context-title"
        style={contextStyle}
        title={subtitle}
        type="button"
      >
        <span className="min-w-0 truncate">{subtitle}</span>
        <ChevronDown aria-hidden="true" className={`size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-180" : ""}`} />
      </Ariakit.PopoverDisclosure>

      <Ariakit.Popover
        className="z-[70] w-[calc(100vw-2rem)] max-w-md rounded-2xl border border-border bg-surface-strong p-4 shadow-[var(--shadow-float)] outline-none"
        data-testid="live-context-selector"
        gutter={8}
        portal
      >
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
          {QUICK_LINES.map((line) => (
            <Link
              aria-label={`${messages.common.line} ${line.code}`}
              className="grid min-h-10 place-items-center rounded-lg px-2 text-sm font-black transition-[filter,transform,opacity] duration-100 hover:brightness-95 active:scale-95 active:opacity-75 focus-visible:outline-offset-2"
              href={`/${lang}/live/line/${line.slug}`}
              key={line.slug}
              onClick={() => setOpen(false)}
              style={{ backgroundColor: line.color, color: lineBadgeTextColor(line.color) }}
            >
              {line.code}
            </Link>
          ))}
        </div>
        <div className="mt-4 border-t border-border pt-4">
          <EntitySearch lang={lang} messages={messages} onNavigate={() => setOpen(false)} />
        </div>
      </Ariakit.Popover>
    </Ariakit.PopoverProvider>
  );
}
