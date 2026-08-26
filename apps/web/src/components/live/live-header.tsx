"use client";

import { ArrowLeft, Radio } from "lucide-react";
import { useRouter } from "next/navigation";

export function LiveHeader({ title, subtitle, backLabel }: { readonly title: string; readonly subtitle: string; readonly backLabel?: string }) {
  const router = useRouter();
  const heading = (
    <div className="min-w-0">
      <h1 className="text-4xl font-black tracking-[-.045em] sm:text-5xl">{title}</h1>
      <p className="mt-1 text-xs font-bold uppercase tracking-[.12em] text-muted sm:text-sm" data-testid="live-context-title">{subtitle}</p>
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
    <header className="grid grid-cols-[auto_1fr] items-start gap-x-1.5 sm:gap-x-2">
      {leading}
      {heading}
    </header>
  );
}
