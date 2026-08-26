export function LiveHeader({ title, subtitle, serviceDate }: { readonly title: string; readonly subtitle: string; readonly serviceDate: string | null }) {
  return (
    <header>
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-4xl font-black tracking-[-.045em] sm:text-5xl">{title}</h1>
        {serviceDate === null ? null : <time className="shrink-0 text-sm text-muted sm:text-base" dateTime={serviceDate}>{serviceDate}</time>}
      </div>
      <p className="mt-1 text-xs font-bold uppercase tracking-[.12em] text-muted sm:text-sm" data-testid="live-context-title">{subtitle}</p>
    </header>
  );
}
