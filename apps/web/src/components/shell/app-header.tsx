"use client";

import * as Ariakit from "@ariakit/react";
import { Languages, Moon, Pause, Play, Sun } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Lang } from "@/lib/domain/contracts";
import type { Messages } from "@/messages/types";
import { BrandSymbol, BrandWordmark } from "./brand-mark";
import { useAutoRefresh } from "./auto-refresh-provider";

function swapLang(pathname: string, lang: Lang, search: string): string {
  const next = lang === "es" ? "en" : "es";
  const localizedPath = pathname.replace(/^\/(es|en)(?=\/|$)/, `/${next}`) || `/${next}`;
  return search === "" ? localizedPath : `${localizedPath}?${search}`;
}

function routeContext(pathname: string, messages: Messages): string {
  if (pathname.includes("/history")) return messages.nav.history;
  if (pathname.includes("/live")) return messages.nav.live;
  if (pathname.includes("/methodology")) return messages.nav.methodology;
  return messages.nav.home;
}

export function AppHeader({ lang, messages }: { readonly lang: Lang; readonly messages: Messages }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [openPathname, setOpenPathname] = useState<string | null>(null);
  const open = openPathname === pathname;
  const [hidden, setHidden] = useState(false);
  const [height, setHeight] = useState<number | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const previousY = useRef(0);
  const { resolvedTheme, setTheme } = useTheme();
  const refresh = useAutoRefresh();

  useEffect(() => {
    previousY.current = window.scrollY;
    const onScroll = () => {
      if (window.innerWidth >= 640 || open) {
        setHidden(false);
        return;
      }
      const y = window.scrollY;
      const delta = y - previousY.current;
      if (y < 96 || delta < -12) setHidden(false);
      else if (delta > 28) setHidden(true);
      previousY.current = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [open]);

  useLayoutEffect(() => {
    const updateHeight = () => {
      const top = topRef.current?.offsetHeight ?? 64;
      const panel = open ? panelRef.current?.scrollHeight ?? 0 : 0;
      setHeight(top + panel);
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    if (topRef.current) observer.observe(topRef.current);
    if (panelRef.current) observer.observe(panelRef.current);
    return () => observer.disconnect();
  }, [open]);

  const links = [
    [`/${lang}`, messages.nav.home],
    [`/${lang}/live`, messages.nav.live],
    [`/${lang}/history`, messages.nav.history],
    [`/${lang}/methodology`, messages.nav.methodology],
  ] as const;

  const setOpen = (next: boolean) => {
    setOpenPathname(next ? pathname : null);
    if (next) setHidden(false);
  };

  return (
    <Ariakit.DialogProvider open={open} setOpen={setOpen}>
      <header className={`sticky top-0 z-50 transition-transform duration-200 ${hidden ? "-translate-y-[120%]" : "translate-y-0"}`}>
        <div className="page-shell pt-3 sm:pt-4">
          <div
            className="overflow-hidden rounded-2xl border border-border bg-surface shadow-[var(--shadow-float)] backdrop-blur-xl transition-[height] motion-reduce:transition-none"
            style={{ height: height ?? undefined, transitionDuration: "var(--drawer-duration)" }}
          >
            <div className="flex min-h-16 items-center gap-3 px-4" ref={topRef}>
              <Link aria-label={messages.nav.home} className="flex items-center gap-2 text-primary" href={`/${lang}`}>
                <BrandSymbol className="size-8" /><BrandWordmark />
              </Link>
              <span className="hidden border-l border-border pl-3 text-xs font-semibold text-muted sm:inline">{routeContext(pathname, messages)}</span>
              <Ariakit.DialogDisclosure
                data-testid="menu-toggle"
                aria-label={open ? messages.nav.close : messages.nav.menu}
                className="ml-auto grid size-11 place-items-center rounded-lg hover:bg-muted-soft"
              >
                <span className="relative block h-4 w-5" aria-hidden="true">
                  <span className={`absolute left-0 top-0 h-0.5 w-5 bg-current transition-transform ${open ? "translate-y-[7px] rotate-45" : ""}`} />
                  <span className={`absolute left-0 top-[7px] h-0.5 w-5 bg-current transition-opacity ${open ? "opacity-0" : ""}`} />
                  <span className={`absolute left-0 top-[14px] h-0.5 w-5 bg-current transition-transform ${open ? "-translate-y-[7px] -rotate-45" : ""}`} />
                </span>
              </Ariakit.DialogDisclosure>
            </div>
            <Ariakit.Dialog
              ref={panelRef}
              portal={false}
              backdrop={false}
              aria-label={messages.nav.menu}
              className="m-0 w-full max-w-none border-0 bg-transparent p-0 text-foreground outline-none"
            >
              <div className="grid gap-6 border-t border-border px-4 pb-5 pt-4 md:grid-cols-[1.4fr_1fr]">
                <nav aria-label={messages.nav.primary} className="grid gap-1 sm:grid-cols-2">
                  {links.map(([href, label]) => (
                    <Link
                      key={href}
                      aria-current={pathname === href ? "page" : undefined}
                      className="rounded-lg px-3 py-3 text-sm font-bold hover:bg-muted-soft aria-[current=page]:bg-muted-soft aria-[current=page]:text-primary"
                      href={href}
                    >
                      {label}
                    </Link>
                  ))}
                </nav>
                <div className="grid gap-4 border-t border-border pt-4 md:border-l md:border-t-0 md:pl-5 md:pt-0">
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-2 text-sm font-semibold"><Languages className="size-4" />{messages.nav.language}</span>
                    <Link className="rounded-md border border-border px-3 py-2 text-sm font-bold" href={swapLang(pathname, lang, searchParams.toString())}>{lang === "es" ? "EN" : "ES"}</Link>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-semibold">{messages.nav.theme}</span>
                    <div className="flex rounded-md border border-border p-1">
                      <button aria-label={messages.nav.light} aria-pressed={resolvedTheme === "light"} className="grid size-9 place-items-center rounded-sm aria-pressed:bg-muted-soft" onClick={() => setTheme("light")} type="button"><Sun className="size-4" /></button>
                      <button aria-label={messages.nav.dark} aria-pressed={resolvedTheme === "dark"} className="grid size-9 place-items-center rounded-sm aria-pressed:bg-muted-soft" onClick={() => setTheme("dark")} type="button"><Moon className="size-4" /></button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-sm font-semibold">{messages.nav.refresh}</span>
                    <button aria-pressed={refresh.enabled} className="flex min-h-10 items-center gap-2 rounded-md border border-border px-3 text-sm font-bold" onClick={() => refresh.setEnabled(!refresh.enabled)} type="button">
                      {refresh.enabled ? <Pause className="size-4" /> : <Play className="size-4" />}{refresh.enabled ? messages.nav.active : messages.nav.paused}
                    </button>
                  </div>
                </div>
              </div>
            </Ariakit.Dialog>
          </div>
        </div>
      </header>
    </Ariakit.DialogProvider>
  );
}
