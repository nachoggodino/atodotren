"use client";

import { ArrowLeft, Radio } from "lucide-react";
import { useRouter } from "next/navigation";
import type { CSSProperties } from "react";
import { lineBadgeTextColor } from "@/components/line-badge";

export function LiveHeader({
  title,
  subtitle,
  backLabel,
  contextColor,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly backLabel?: string;
  readonly contextColor?: string;
}) {
  const router = useRouter();
  const contextStyle: CSSProperties | undefined = contextColor === undefined
    ? undefined
    : { backgroundColor: contextColor, color: lineBadgeTextColor(contextColor) };
  const heading = (
    <div className="flex min-w-0 items-center gap-2 overflow-hidden">
      <h1 className="shrink-0 whitespace-nowrap text-[31px] font-black tracking-[-.045em] sm:text-[43px]">{title}</h1>
      <span
        className={`min-w-0 truncate rounded-md px-2.5 py-1 text-xs font-black uppercase tracking-[.08em] ${contextColor === undefined ? "bg-[var(--live-context-neutral)] text-[var(--live-context-neutral-foreground)]" : ""}`}
        data-context-tone={contextColor === undefined ? "neutral" : "line"}
        data-testid="live-context-title"
        style={contextStyle}
        title={subtitle}
      >
        {subtitle}
      </span>
    </div>
  );

  const leading = backLabel === undefined
    ? (
      <span className="-ml-2 mt-0.5 grid size-11 shrink-0 place-items-center" aria-hidden="true">
        <Radio className="size-7 text-[var(--landing-positive)]" data-testid="live-title-icon" />
      </span>
    )
    : (
      <button
        aria-label={backLabel}
        className="-ml-2 mt-0.5 grid size-11 shrink-0 place-items-center text-muted transition-[color,transform,opacity] duration-100 hover:text-foreground active:-translate-x-1 active:scale-90 active:text-[var(--landing-positive)] active:opacity-65"
        data-testid="live-back-button"
        onClick={() => router.back()}
        type="button"
      >
        <ArrowLeft aria-hidden="true" className="size-7" />
      </button>
    );

  return (
    <header className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-1.5 sm:gap-x-2">
      {leading}
      {heading}
    </header>
  );
}
