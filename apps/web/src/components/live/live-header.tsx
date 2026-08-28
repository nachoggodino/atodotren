"use client";

import { ArrowLeft, Radio } from "lucide-react";
import { useRouter } from "next/navigation";
import type { Lang } from "@/lib/domain/contracts";
import type { Messages } from "@/messages/types";
import { LiveContextSelector } from "./live-context-selector";

export function LiveHeader({
  title,
  subtitle,
  backLabel,
  contextColor,
  lang,
  messages,
}: {
  readonly title: string;
  readonly subtitle: string;
  readonly backLabel?: string;
  readonly contextColor?: string;
  readonly lang: Lang;
  readonly messages: Messages;
}) {
  const router = useRouter();
  const heading = (
    <div className="flex min-w-0 items-baseline gap-2 overflow-hidden">
      <h1 className="shrink-0 whitespace-nowrap text-[31px] font-black tracking-[-.045em] sm:text-[43px]">{title}</h1>
      <LiveContextSelector contextColor={contextColor} lang={lang} messages={messages} subtitle={subtitle} />
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
