import type { Lang } from "@/lib/domain/contracts";
import { formatDuration } from "@/lib/domain/format";
import type { Messages } from "@/messages/types";

export function LandingMetrics({ activeDelaySeconds, activeTrains, dayDelaySeconds, lang, messages }: { readonly activeDelaySeconds: number; readonly activeTrains: number; readonly dayDelaySeconds: number; readonly lang: Lang; readonly messages: Messages }) {
  const number = new Intl.NumberFormat(lang === "es" ? "es-ES" : "en-GB");
  return (
    <section className="mt-9 overflow-hidden rounded-2xl border border-border bg-surface-strong" data-testid="landing-live-metrics">
      <div className="grid grid-cols-3 divide-x divide-border">
        <div className="flex min-h-[5.75rem] min-w-0 flex-col items-center justify-center gap-1 px-3 py-3 text-center sm:min-h-24 sm:px-5" data-testid="landing-metric-active-delay" style={{ background: "color-mix(in srgb, var(--landing-delay) 4%, var(--surface-strong))" }}><p className="flex h-6 items-start justify-center text-[.5rem] font-bold uppercase leading-tight tracking-[.07em] text-muted sm:text-[.55rem]">{messages.landing.activeDelay}</p><p className="metric-value flex h-8 items-center justify-center text-[.94rem] font-black text-[var(--landing-delay)] sm:text-[1.18rem]">{formatDuration(activeDelaySeconds, lang)}</p></div>
        <div className="flex min-h-[5.75rem] min-w-0 flex-col items-center justify-center gap-1 px-3 py-3 text-center sm:min-h-24 sm:px-5" data-testid="landing-metric-active-trains" style={{ background: "color-mix(in srgb, var(--landing-positive) 6%, var(--surface-strong))" }}><p className="flex h-6 items-start justify-center text-[.5rem] font-bold uppercase leading-tight tracking-[.07em] text-muted sm:text-[.55rem]">{messages.landing.activeTrains}</p><p className="metric-value flex h-8 items-center justify-center text-[29px] font-black leading-none text-[var(--landing-positive)] sm:text-[33px]" data-testid="landing-active-trains-value">{number.format(activeTrains)}</p></div>
        <div className="flex min-h-[5.75rem] min-w-0 flex-col items-center justify-center gap-1 px-3 py-3 text-center sm:min-h-24 sm:px-5" data-testid="landing-metric-today-delay" style={{ background: "color-mix(in srgb, var(--landing-delay) 6%, var(--surface-strong))" }}><p className="flex h-6 items-start justify-center text-[.5rem] font-bold uppercase leading-tight tracking-[.07em] text-muted sm:text-[.55rem]">{messages.landing.todayDelay}</p><p className="metric-value flex h-8 items-center justify-center text-[.94rem] font-black text-[var(--landing-delay)] sm:text-[1.18rem]">{formatDuration(dayDelaySeconds, lang)}</p></div>
      </div>
    </section>
  );
}
