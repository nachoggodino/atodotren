import { ArrowRight, BarChart3, Radio } from "lucide-react";
import Link from "next/link";
import type { Lang } from "@/lib/domain/contracts";
import type { Messages } from "@/messages/types";

export function LandingActions({ lang, messages }: { readonly lang: Lang; readonly messages: Messages }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Link data-testid="landing-live-link" className="group flex min-h-[3.2rem] items-center gap-3 rounded-2xl border border-border px-4 font-black transition-[transform,box-shadow,opacity] duration-100 hover:-translate-y-0.5 hover:shadow-sm active:scale-[.97] active:opacity-80 active:shadow-none" style={{ background: "color-mix(in srgb, var(--landing-positive) 4%, var(--surface-strong))" }} href={`/${lang}/live`}><Radio className="size-5 shrink-0 text-[var(--landing-positive)]" /><span className="flex-1">{messages.landing.summaryLive}</span><ArrowRight className="size-4 text-muted transition group-hover:translate-x-0.5" /></Link>
      <Link data-testid="landing-history-link" className="group flex min-h-[3.2rem] items-center gap-3 rounded-2xl border border-border px-4 font-black transition-[transform,box-shadow,opacity] duration-100 hover:-translate-y-0.5 hover:shadow-sm active:scale-[.97] active:opacity-80 active:shadow-none" style={{ background: "color-mix(in srgb, var(--landing-highlight) 4%, var(--surface-strong))" }} href={`/${lang}/history`}><BarChart3 className="size-5 shrink-0 text-[var(--landing-highlight)]" /><span className="flex-1">{messages.landing.summaryHistory}</span><ArrowRight className="size-4 text-muted transition group-hover:translate-x-0.5" /></Link>
    </div>
  );
}
