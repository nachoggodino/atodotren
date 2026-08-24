import { BRAND } from "@/lib/brand/config";

export function BrandSymbol({ className = "size-8" }: { readonly className?: string }) {
  return (
    <svg aria-label={BRAND.symbolLabel} className={className} role="img" viewBox="0 0 40 40">
      <rect x="7" y="5" width="26" height="27" rx="7" fill="currentColor" />
      <rect x="11" y="9" width="18" height="10" rx="3" fill="var(--background)" />
      <circle cx="14" cy="27" r="2.2" fill="var(--background)" />
      <circle cx="26" cy="27" r="2.2" fill="var(--background)" />
      <path d="M12 35 16 30h8l4 5" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2.5" />
    </svg>
  );
}

export function BrandWordmark() {
  return <span className="text-[1.05rem] font-black tracking-[-0.055em]">{BRAND.wordmark}</span>;
}
