"use client";

import * as Ariakit from "@ariakit/react";
import { BarChart3, BookOpen, House, Radio } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { Lang } from "@/lib/domain/contracts";
import type { Messages } from "@/messages/types";
import { AppHeaderControls } from "./app-header-controls";
import { BrandSymbol, BrandWordmark } from "./brand-mark";

const HOME_ICON_CLASS = "text-primary";
const LIVE_ICON_CLASS = "text-[var(--landing-positive)]";
const HISTORY_ICON_CLASS = "text-[var(--landing-highlight)]";
const METHODOLOGY_ICON_CLASS = "text-[var(--nav-methodology)]";
const HEADER_EDGE_CONTROL_CLASS = "grid h-11 shrink-0 place-items-center rounded-lg px-3 text-primary transition-[background-color,transform,opacity] duration-100 hover:bg-muted-soft active:scale-90 active:opacity-70";
const DESKTOP_BREAKPOINT_PX = 640;
const HEADER_REVEAL_TOP_PX = 96;
const HEADER_REVEAL_SCROLL_DELTA_PX = -12;
const HEADER_HIDE_SCROLL_DELTA_PX = 28;

type NavSection = "home" | "live" | "history" | "methodology";

function activeNavSection(pathname: string): NavSection {
  if (pathname.includes("/history")) return "history";
  if (pathname.includes("/live")) return "live";
  if (pathname.includes("/methodology")) return "methodology";
  return "home";
}

export function AppHeader({ lang, messages }: { readonly lang: Lang; readonly messages: Messages }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [openPathname, setOpenPathname] = useState<string | null>(null);
  const open = openPathname === pathname;
  const [hidden, setHidden] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const previousY = useRef(0);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setOpenPathname(null);
      setHidden(false);
      previousY.current = window.scrollY;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pathname]);

  useEffect(() => {
    previousY.current = window.scrollY;
    const onScroll = () => {
      if (window.innerWidth >= DESKTOP_BREAKPOINT_PX || open) {
        setHidden(false);
        return;
      }
      const y = window.scrollY;
      const delta = y - previousY.current;
      if (y < HEADER_REVEAL_TOP_PX || delta < HEADER_REVEAL_SCROLL_DELTA_PX) setHidden(false);
      else if (delta > HEADER_HIDE_SCROLL_DELTA_PX) setHidden(true);
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
    { section: "home", href: `/${lang}`, label: messages.nav.home, Icon: House, iconClassName: HOME_ICON_CLASS },
    { section: "live", href: `/${lang}/live`, label: messages.nav.live, Icon: Radio, iconClassName: LIVE_ICON_CLASS },
    { section: "history", href: `/${lang}/history`, label: messages.nav.history, Icon: BarChart3, iconClassName: HISTORY_ICON_CLASS },
    { section: "methodology", href: `/${lang}/methodology`, label: messages.nav.methodology, Icon: BookOpen, iconClassName: METHODOLOGY_ICON_CLASS },
  ] as const;
  const context = links.find((item) => item.section === activeNavSection(pathname)) ?? links[0];
  const ContextIcon = context.Icon;

  const setOpen = (next: boolean) => {
    setOpenPathname(next ? pathname : null);
    if (next) setHidden(false);
  };
  const closeForNavigation = () => setOpenPathname(null);

  return (
    <Ariakit.DisclosureProvider open={open} setOpen={setOpen}>
      <header className={`sticky top-0 z-50 transition-transform duration-200 ${hidden ? "-translate-y-[120%]" : "translate-y-0"}`}>
        <div className="page-shell pt-3 sm:pt-4">
          <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-[var(--shadow-float)] backdrop-blur-xl">
            <div className="relative flex min-h-16 items-center gap-3 px-4">
              <Link
                aria-label={messages.nav.home}
                className={HEADER_EDGE_CONTROL_CLASS}
                href={`/${lang}`}
                onClick={closeForNavigation}
              >
                <BrandSymbol className="h-[1.4rem]" />
              </Link>
              <span className="hidden items-center gap-1.5 text-xs font-semibold text-muted sm:flex">
                <ContextIcon aria-hidden="true" className={`size-4 shrink-0 ${context.iconClassName}`} />
                {context.label}
              </span>
              <Link
                aria-label={messages.nav.home}
                className="absolute left-1/2 flex -translate-x-1/2 items-center rounded-md text-primary transition-[transform,opacity] duration-100 active:scale-[.96] active:opacity-70"
                href={`/${lang}`}
                onClick={closeForNavigation}
              >
                <BrandWordmark />
              </Link>
              <Ariakit.Disclosure
                ref={menuButtonRef}
                data-testid="menu-toggle"
                aria-label={open ? messages.nav.close : messages.nav.menu}
                className={`${HEADER_EDGE_CONTROL_CLASS} ml-auto`}
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
                    {links.map(({ href, label, Icon, iconClassName }) => (
                      <Link
                        key={href}
                        aria-current={pathname === href ? "page" : undefined}
                        className="flex items-center gap-3 rounded-lg px-3 py-3 text-sm font-bold transition-[background-color,transform,opacity] duration-100 hover:bg-muted-soft active:scale-[.97] active:opacity-75 aria-[current=page]:bg-muted-soft aria-[current=page]:text-primary"
                        href={href}
                        onClick={closeForNavigation}
                      >
                        <Icon aria-hidden="true" className={`size-5 shrink-0 ${iconClassName}`} />
                        {label}
                      </Link>
                    ))}
                  </nav>
                  <AppHeaderControls lang={lang} messages={messages} pathname={pathname} search={searchParams.toString()} onNavigate={closeForNavigation} />
                </div>
              </div>
            </Ariakit.DisclosureContent>
          </div>
        </div>
      </header>
    </Ariakit.DisclosureProvider>
  );
}
