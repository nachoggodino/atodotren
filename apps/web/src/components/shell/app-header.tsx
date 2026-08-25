"use client";

import * as Ariakit from "@ariakit/react";
import { BookOpen, History, House, Moon, Radio, Sun } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";
import type { Lang } from "@/lib/domain/contracts";
import type { Messages } from "@/messages/types";
import { BrandSymbol, BrandWordmark } from "./brand-mark";
import { useAutoRefresh } from "./auto-refresh-provider";

function localizedHref(pathname: string, lang: Lang, search: string): string {
  const localizedPath = pathname.replace(/^\/(es|en)(?=\/|$)/, `/${lang}`) || `/${lang}`;
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
  const menuButtonRef = useRef<HTMLButtonElement>(null);
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

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenPathname(null);
        menuButtonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const links = [
    { href: `/${lang}`, label: messages.nav.home, Icon: House },
    { href: `/${lang}/live`, label: messages.nav.live, Icon: Radio },
    { href: `/${lang}/history`, label: messages.nav.history, Icon: History },
    { href: `/${lang}/methodology`, label: messages.nav.methodology, Icon: BookOpen },
  ] as const;

  const setOpen = (next: boolean) => {
    setOpenPathname(next ? pathname : null);
    if (next) setHidden(false);
  };

  const search = searchParams.toString();

  return (
    <Ariakit.DisclosureProvider open={open} setOpen={setOpen}>
      <header className={`sticky top-0 z-50 transition-transform duration-200 ${hidden ? "-translate-y-[120%]" : "translate-y-0"}`}>
        <div className="page-shell pt-3 sm:pt-4">
          <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-[var(--shadow-float)] backdrop-blur-xl">
            <div className="flex min-h-16 items-center gap-3 px-4">
              <Link aria-label={messages.nav.home} className="flex items-center gap-2 text-primary" href={`/${lang}`}>
                <BrandSymbol className="h-[1.4rem]" /><BrandWordmark />
              </Link>
              <span className="hidden border-l border-border pl-3 text-xs font-semibold text-muted sm:inline">{routeContext(pathname, messages)}</span>
              <Ariakit.Disclosure
                ref={menuButtonRef}
                data-testid="menu-toggle"
                aria-label={open ? messages.nav.close : messages.nav.menu}
                className="ml-auto grid size-11 place-items-center rounded-lg hover:bg-muted-soft"
              >
                <span className="relative block h-4 w-5" aria-hidden="true">
                  <span className={`absolute left-0 top-0 h-0.5 w-5 bg-current transition-transform ${open ? "translate-y-[7px] rotate-45" : ""}`} />
                  <span className={`absolute left-0 top-[7px] h-0.5 w-5 bg-current transition-opacity ${open ? "opacity-0" : ""}`} />
                  <span className={`absolute left-0 top-[14px] h-0.5 w-5 bg-current transition-transform ${open ? "-translate-y-[7px] -rotate-45" : ""}`} />
                </span>
              </Ariakit.Disclosure>
            </div>
            <Ariakit.DisclosureContent
              alwaysVisible
              aria-hidden={!open}
              inert={!open}
              className="grid grid-rows-[0fr] opacity-0 transition-[grid-template-rows,opacity] data-[enter]:grid-rows-[1fr] data-[enter]:opacity-100 motion-reduce:transition-none"
              style={{ transitionDuration: "var(--drawer-duration)" }}
            >
              <div className="overflow-hidden">
                <div className="grid gap-6 px-4 pb-5 pt-4 md:grid-cols-[1.4fr_1fr]">
                  <nav aria-label={messages.nav.primary} className="grid gap-1 sm:grid-cols-2">
                    {links.map(({ href, label, Icon }) => (
                      <Link
                        key={href}
                        aria-current={pathname === href ? "page" : undefined}
                        className="flex items-center gap-3 rounded-lg px-3 py-3 text-sm font-bold hover:bg-muted-soft aria-[current=page]:bg-muted-soft aria-[current=page]:text-primary"
                        href={href}
                      >
                        <Icon aria-hidden="true" className="size-5 shrink-0" />
                        {label}
                      </Link>
                    ))}
                  </nav>
                  <div className="grid gap-4 border-t border-border pt-4 md:border-l md:border-t-0 md:pl-5 md:pt-0">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-semibold">{messages.nav.theme}</span>
                      <div aria-label={messages.nav.theme} className="relative flex h-9 w-[4.5rem] rounded-full border border-border bg-muted-soft" role="group">
                        <span
                          aria-hidden="true"
                          className={`pointer-events-none absolute left-1 top-1 size-7 rounded-full bg-primary/10 shadow-sm transition-transform duration-200 ease-out motion-reduce:transition-none ${resolvedTheme === "dark" ? "translate-x-9" : "translate-x-0"}`}
                        />
                        <button aria-label={messages.nav.light} aria-pressed={resolvedTheme === "light"} className="relative z-10 grid flex-1 place-items-center rounded-full" onClick={() => setTheme("light")} type="button"><Sun className="size-4" /></button>
                        <button aria-label={messages.nav.dark} aria-pressed={resolvedTheme === "dark"} className="relative z-10 grid flex-1 place-items-center rounded-full" onClick={() => setTheme("dark")} type="button"><Moon className="size-4" /></button>
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-semibold">{messages.nav.refresh}</span>
                      <button
                        aria-checked={refresh.enabled}
                        aria-label={messages.nav.refresh}
                        className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors ${refresh.enabled ? "border-primary bg-primary" : "border-border bg-muted-soft"}`}
                        onClick={() => refresh.setEnabled(!refresh.enabled)}
                        role="switch"
                        type="button"
                      >
                        <span aria-hidden="true" className={`absolute left-[3px] top-1/2 size-5 -translate-y-1/2 rounded-full bg-surface shadow-sm transition-transform ${refresh.enabled ? "translate-x-5" : "translate-x-0"}`} />
                      </button>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-semibold">{messages.nav.language}</span>
                      <div aria-label={messages.nav.language} className="flex rounded-md border border-border p-0.5" role="group">
                        <Link
                          aria-current={lang === "es" ? "true" : undefined}
                          className={`min-w-10 rounded-sm px-2 py-1.5 text-center text-xs font-bold transition-colors ${lang === "es" ? "bg-muted-soft text-primary" : "hover:bg-muted-soft"}`}
                          href={localizedHref(pathname, "es", search)}
                        >
                          ESP
                        </Link>
                        <Link
                          aria-current={lang === "en" ? "true" : undefined}
                          className={`min-w-10 rounded-sm px-2 py-1.5 text-center text-xs font-bold transition-colors ${lang === "en" ? "bg-muted-soft text-primary" : "hover:bg-muted-soft"}`}
                          href={localizedHref(pathname, "en", search)}
                        >
                          ENG
                        </Link>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Ariakit.DisclosureContent>
          </div>
        </div>
      </header>
    </Ariakit.DisclosureProvider>
  );
}
