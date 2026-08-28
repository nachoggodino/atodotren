"use client";

import * as Ariakit from "@ariakit/react";
import { BarChart3, MapPin, Radio, Search, TrainFront } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import type { Lang, SearchResponse, SearchResult } from "@/lib/domain/contracts";
import type { Messages } from "@/messages/types";

const SEARCH_DEBOUNCE_MS = 160;

function routeFor(result: SearchResult, lang: Lang, mode: "live" | "history"): string {
  const slug = result.kind === "line" ? result.slug.es : result.slug[lang];
  return `/${lang}/${mode}/${result.kind}/${slug}`;
}

function resultLabel(result: SearchResult, lang: Lang): string {
  return result.code ? `${result.code} · ${result.name[lang]}` : result.name[lang];
}

export function EntitySearch({
  lang,
  messages,
  onNavigate,
  compact = false,
}: {
  readonly lang: Lang;
  readonly messages: Messages;
  readonly onNavigate?: () => void;
  readonly compact?: boolean;
}) {
  const inputId = useId();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  const onQueryChange = (value: string) => {
    setQuery(value);
    setFailed(false);
    if (value.trim() === "") {
      setResults([]);
      setLoading(false);
      setOpen(false);
      return;
    }
    setOpen(true);
  };

  const navigateToResult = (result: SearchResult, mode: "live" | "history") => {
    setOpen(false);
    onNavigate?.();
    router.push(routeFor(result, lang, mode), { scroll: false });
  };

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === "") return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setFailed(false);
      try {
        const response = await fetch(`/api/v1/catalog/search?q=${encodeURIComponent(trimmed)}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`Search request failed with ${response.status}`);
        const payload = await response.json() as SearchResponse;
        setResults(payload.results);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setResults([]);
        setFailed(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query]);

  return (
    <Ariakit.ComboboxProvider value={query} setValue={onQueryChange} open={open} setOpen={setOpen}>
      <div className="relative">
        <Ariakit.ComboboxLabel className={compact ? "mb-2 block text-xs font-bold" : "mb-3 block text-sm font-bold"} htmlFor={inputId}>{messages.landing.searchLabel}</Ariakit.ComboboxLabel>
        {compact ? (
          <div className="relative" data-testid="landing-search-field">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-primary" />
            <Ariakit.Combobox
              id={inputId}
              autoComplete="off"
              autoSelect="always"
              className="landing-search-input min-h-11 w-full appearance-none rounded-xl border border-border bg-surface-strong py-2.5 pl-9 pr-9 text-sm shadow-sm outline-none transition placeholder:text-muted/65 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/15 focus-visible:outline-none"
              placeholder={messages.landing.searchPlaceholder}
            />
            {loading ? <span aria-label={messages.common.loading} className="absolute right-3 top-1/2 size-3.5 -translate-y-1/2 animate-spin rounded-full border-2 border-border border-t-primary motion-reduce:animate-none" /> : null}
          </div>
        ) : (
          <div className="flex min-h-[3.2rem] items-center gap-3 rounded-2xl border border-border bg-surface-strong px-4 shadow-sm transition focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15" data-testid="landing-search-field">
            <Search aria-hidden="true" className="size-5 shrink-0 text-primary" />
            <Ariakit.Combobox
              id={inputId}
              autoComplete="off"
              autoSelect="always"
              className="landing-search-input min-w-0 flex-1 appearance-none border-0 bg-transparent py-3 text-base shadow-none outline-none ring-0 placeholder:text-muted/65 focus:border-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 sm:text-lg"
              placeholder={messages.landing.searchPlaceholder}
            />
            {loading ? <span aria-label={messages.common.loading} className="size-4 shrink-0 animate-spin rounded-full border-2 border-border border-t-primary motion-reduce:animate-none" /> : null}
          </div>
        )}
        <Ariakit.ComboboxPopover gutter={6} sameWidth className="z-[80] overflow-hidden rounded-2xl border border-border bg-surface-strong shadow-[var(--shadow-float)]">
          {failed ? <p className="px-4 py-4 text-sm text-danger" role="status">{messages.landing.searchError}</p> : null}
          {!failed && results.length === 0 && !loading ? <p className="px-4 py-4 text-sm text-muted" role="status">{messages.landing.emptySearch}</p> : null}
          {!failed && results.length > 0 ? <Ariakit.ComboboxList>{results.map((result) => {
            const label = resultLabel(result, lang);
            return (
              <div className="relative border-b border-border last:border-b-0" key={`${result.kind}-${result.id}`}>
                <Ariakit.ComboboxItem
                  className={compact
                    ? "flex w-full cursor-pointer items-center px-3 py-2.5 pr-[4.75rem] text-left text-sm transition-[background-color,transform,opacity] duration-100 hover:bg-muted-soft active:scale-[.99] active:opacity-75 data-[active-item]:bg-muted-soft"
                    : "flex w-full cursor-pointer items-center gap-3 px-4 py-3.5 pr-[6.5rem] text-left transition-[background-color,transform,opacity] duration-100 hover:bg-muted-soft active:scale-[.99] active:opacity-75 data-[active-item]:bg-muted-soft"}
                  onClick={() => navigateToResult(result, "live")}
                  resetValueOnSelect={false}
                  setValueOnClick={false}
                  value={`${result.kind}:${result.id}`}
                >
                  {!compact ? (result.kind === "line" ? <TrainFront aria-hidden="true" className="size-5 shrink-0 text-primary" /> : <MapPin aria-hidden="true" className="size-5 shrink-0 text-primary" />) : null}
                  <strong className="min-w-0 flex-1 truncate">{label}</strong>
                </Ariakit.ComboboxItem>
                <div className={compact ? "absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1" : "absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1.5"}>
                  <Link
                    aria-label={`${messages.landing.liveAction}: ${label}`}
                    className={`${compact ? "size-8" : "size-9"} grid place-items-center rounded-lg text-[var(--landing-positive)] transition-[background-color,transform,opacity] duration-100 hover:bg-[color-mix(in_srgb,var(--landing-positive)_10%,transparent)] active:scale-90 active:opacity-70 focus-visible:outline-offset-1`}
                    href={routeFor(result, lang, "live")}
                    onClick={(event) => {
                      event.preventDefault();
                      navigateToResult(result, "live");
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    title={messages.landing.liveAction}
                  >
                    <Radio className="size-4" />
                  </Link>
                  <Link
                    aria-label={`${messages.landing.historyAction}: ${label}`}
                    className={`${compact ? "size-8" : "size-9"} grid place-items-center rounded-lg text-[var(--landing-highlight)] transition-[background-color,transform,opacity] duration-100 hover:bg-[color-mix(in_srgb,var(--landing-highlight)_10%,transparent)] active:scale-90 active:opacity-70 focus-visible:outline-offset-1`}
                    href={routeFor(result, lang, "history")}
                    onClick={(event) => {
                      event.preventDefault();
                      navigateToResult(result, "history");
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    title={messages.landing.historyAction}
                  >
                    <BarChart3 className="size-4" />
                  </Link>
                </div>
              </div>
            );
          })}</Ariakit.ComboboxList> : null}
        </Ariakit.ComboboxPopover>
      </div>
    </Ariakit.ComboboxProvider>
  );
}
