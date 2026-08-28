"use client";

import { Moon, Sun } from "lucide-react";
import Link from "next/link";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";
import type { Lang } from "@/lib/domain/contracts";
import { LANGUAGE_OPTIONS, localizedPath } from "@/lib/i18n";
import type { Messages } from "@/messages/types";
import { useAutoRefresh } from "./auto-refresh-provider";

function subscribeToAppliedTheme(onStoreChange: () => void): () => void {
  const observer = new MutationObserver(onStoreChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

function getAppliedTheme(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function getServerTheme(): "light" {
  return "light";
}

function ThemeControl({ messages }: { readonly messages: Messages }) {
  const { setTheme } = useTheme();
  const currentTheme = useSyncExternalStore(subscribeToAppliedTheme, getAppliedTheme, getServerTheme);
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm font-semibold">{messages.nav.theme}</span>
      <div aria-label={messages.nav.theme} className="relative flex h-9 w-[4.5rem] items-center justify-between rounded-full border border-border bg-muted-soft p-px" role="group">
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute left-px top-1/2 size-8 -translate-y-1/2 rounded-full bg-primary/10 shadow-sm transition-transform duration-200 ease-out motion-reduce:transition-none ${currentTheme === "dark" ? "translate-x-9" : "translate-x-0"}`}
          data-testid="theme-thumb"
        />
        <button aria-label={messages.nav.light} aria-pressed={currentTheme === "light"} className="relative z-10 grid size-8 place-items-center rounded-full transition-[transform,opacity] duration-100 active:scale-75 active:opacity-65" onClick={() => setTheme("light")} type="button"><Sun className="size-4" /></button>
        <button aria-label={messages.nav.dark} aria-pressed={currentTheme === "dark"} className="relative z-10 grid size-8 place-items-center rounded-full transition-[transform,opacity] duration-100 active:scale-75 active:opacity-65" onClick={() => setTheme("dark")} type="button"><Moon className="size-4" /></button>
      </div>
    </div>
  );
}

function AutoRefreshControl({ messages }: { readonly messages: Messages }) {
  const refresh = useAutoRefresh();
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm font-semibold">{messages.nav.refresh}</span>
      <button
        aria-checked={refresh.enabled}
        aria-label={messages.nav.refresh}
        className={`relative h-7 w-12 shrink-0 rounded-full border transition-[background-color,border-color,transform,opacity] duration-100 active:scale-90 active:opacity-75 ${refresh.enabled ? "border-primary bg-primary" : "border-border bg-muted-soft"}`}
        onClick={() => refresh.setEnabled(!refresh.enabled)}
        role="switch"
        type="button"
      >
        <span aria-hidden="true" className={`absolute left-[3px] top-1/2 size-5 -translate-y-1/2 rounded-full bg-surface shadow-sm transition-transform ${refresh.enabled ? "translate-x-5" : "translate-x-0"}`} />
      </button>
    </div>
  );
}

function localizedHref(pathname: string, lang: Lang, search: string): string {
  const path = localizedPath(pathname, lang);
  return search === "" ? path : `${path}?${search}`;
}

function LanguageControl({ lang, messages, pathname, search, onNavigate }: { readonly lang: Lang; readonly messages: Messages; readonly pathname: string; readonly search: string; readonly onNavigate: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm font-semibold">{messages.nav.language}</span>
      <div aria-label={messages.nav.language} className="flex rounded-md border border-border p-0.5" role="group">
        {LANGUAGE_OPTIONS.map((option) => (
          <Link
            aria-current={lang === option.lang ? "true" : undefined}
            className={`min-w-10 rounded-sm px-2 py-1.5 text-center text-xs font-bold transition-[background-color,transform,opacity] duration-100 active:scale-90 active:opacity-70 ${lang === option.lang ? "bg-muted-soft text-primary" : "hover:bg-muted-soft"}`}
            href={localizedHref(pathname, option.lang, search)}
            key={option.lang}
            onClick={onNavigate}
          >
            {option.shortLabel}
          </Link>
        ))}
      </div>
    </div>
  );
}

export function AppHeaderControls({ lang, messages, pathname, search, onNavigate }: { readonly lang: Lang; readonly messages: Messages; readonly pathname: string; readonly search: string; readonly onNavigate: () => void }) {
  return (
    <div className="grid gap-4 border-t border-border pt-4 md:border-l md:border-t-0 md:pl-5 md:pt-0">
      <ThemeControl messages={messages} />
      <AutoRefreshControl messages={messages} />
      <LanguageControl lang={lang} messages={messages} pathname={pathname} search={search} onNavigate={onNavigate} />
    </div>
  );
}
