"use client";

import * as Ariakit from "@ariakit/react";
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
        className={`min-w-0 -translate-y-1 truncate rounded-md px-2.5 py-1 text-xs font-black uppercase tracking-[.08em] ${contextColor === undefined ? "bg-[var(--live-context-neutral)] text-[var(--live-context-neutral-foreground)]" : ""}`}
        data-context-tone={contextColor === undefined ? "neutral" : "line"}
        data-testid="live-context-title"
        style={contextStyle}
        title={subtitle}
        type="button"
      >
        {subtitle}
      </Ariakit.PopoverDisclosure>

      <Ariakit.Popover
        className="z-[70] w-[62vw] max-w-xs rounded-xl border border-border bg-surface-strong p-3 shadow-[var(--shadow-float)] outline-none"
        data-testid="live-context-selector"
        gutter={8}
        portal
      >
        <div className="grid grid-cols-5 gap-1.5">
          {QUICK_LINES.map((line) => (
            <Link
              aria-label={`${messages.common.line} ${line.code}`}
              className="grid aspect-square min-w-0 place-items-center rounded-md text-[13px] font-black transition-[filter,transform,opacity] duration-100 hover:brightness-95 active:scale-95 active:opacity-75 focus-visible:outline-offset-2"
              href={`/${lang}/live/line/${line.slug}`}
              key={line.slug}
              onClick={() => setOpen(false)}
              style={{ backgroundColor: line.color, color: lineBadgeTextColor(line.color) }}
            >
              {line.code}
            </Link>
          ))}
        </div>
        <div className="mt-3">
          <EntitySearch compact lang={lang} messages={messages} onNavigate={() => setOpen(false)} />
        </div>
      </Ariakit.Popover>
    </Ariakit.PopoverProvider>
  );
}
