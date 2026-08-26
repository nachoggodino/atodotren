export function LiveHeader({ title, subtitle }: { readonly title: string; readonly subtitle: string }) {
  return (
    <header>
      <h1 className="text-4xl font-black tracking-[-.045em] sm:text-5xl">{title}</h1>
      <p className="mt-1 text-xs font-bold uppercase tracking-[.12em] text-muted sm:text-sm" data-testid="live-context-title">{subtitle}</p>
    </header>
  );
}
