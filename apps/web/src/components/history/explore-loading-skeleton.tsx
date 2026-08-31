export function ExploreLoadingSkeleton({ overlay = false }: { readonly overlay?: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={overlay ? "absolute inset-0 z-[100] min-h-full bg-background pb-20 pt-7 sm:pt-9" : "page-shell pb-20 pt-7 sm:pt-9"}
      data-testid="explore-navigation-skeleton"
    >
      <div className="flex items-center gap-3">
        <div className="skeleton size-8 rounded" />
        <div className="skeleton h-11 w-72 rounded-lg" />
      </div>
      <div className="skeleton mt-5 h-10 w-full rounded-lg" />
      <div className="skeleton mt-6 h-14 w-full rounded-lg" />
      <div className="skeleton mt-6 h-40 w-full rounded-2xl" />
      <div className="mt-12 grid gap-8 lg:grid-cols-2">
        <div className="skeleton h-72 rounded-xl" />
        <div className="skeleton h-72 rounded-xl" />
      </div>
    </div>
  );
}
