"use client";

import * as Ariakit from "@ariakit/react";
import { History, MapPin, Radio, Search, TrainFront } from "lucide-react";
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

export function EntitySearch({ lang, messages }: { readonly lang: Lang; readonly messages: Messages }) {
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
        <Ariakit.ComboboxLabel className="mb-3 block text-sm font-bold" htmlFor={inputId}>{messages.landing.searchLabel}</Ariakit.ComboboxLabel>
        <div className="flex min-h-16 items-center gap-3 rounded-2xl border border-border bg-surface-strong px-4 shadow-sm transition focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15" data-testid="landing-search-field">
          <Search aria-hidden="true" className="size-5 shrink-0 text-primary" />
          <Ariakit.Combobox id={inputId} autoComplete="off" autoSelect="always" className="landing-search-input min-w-0 flex-1 appearance-none border-0 bg-transparent py-4 text-base shadow-none outline-none ring-0 placeholder:text-muted/65 focus:border-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 sm:text-lg" placeholder={messages.landing.searchPlaceholder} />
          {loading ? <span aria-label={messages.common.loading} className="size-4 shrink-0 animate-spin rounded-full border-2 border-border border-t-primary motion-reduce:animate-none" /> : null}
        </div>
        <Ariakit.ComboboxPopover gutter={6} sameWidth className="z-[80] overflow-hidden rounded-2xl border border-border bg-surface-strong shadow-[var(--shadow-float)]">
          {failed ? <p className="px-4 py-4 text-sm text-danger" role="status">{messages.landing.searchError}</p> : null}
          {!failed && results.length === 0 && !loading ? <p className="px-4 py-4 text-sm text-muted" role="status">{messages.landing.emptySearch}</p> : null}
          {!failed && results.length > 0 ? <Ariakit.ComboboxList>{results.map((result) => {
            const label = resultLabel(result, lang);
            return (
              <div className="relative border-b border-border last:border-b-0" key={`${result.kind}-${result.id}`}>
                <Ariakit.ComboboxItem
                  className="flex w-full cursor-pointer items-center gap-3 px-4 py-3.5 pr-[6.5rem] text-left hover:bg-muted-soft data-[active-item]:bg-muted-soft"
                  onClick={() => router.push(routeFor(result, lang, "live"))}
                  resetValueOnSelect={false}
                  setValueOnClick={false}
                  value={`${result.kind}:${result.id}`}
                >
                  {result.kind === "line" ? <TrainFront aria-hidden="true" className="size-5 shrink-0 text-primary" /> : <MapPin aria-hidden="true" className="size-5 shrink-0 text-primary" />}
                  <strong className="min-w-0 flex-1 truncate">{label}</strong>
                </Ariakit.ComboboxItem>
                <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
                  <Link
                    aria-label={`${messages.landing.liveAction}: ${label}`}
                    className="grid size-9 place-items-center rounded-lg text-[var(--landing-positive)] transition hover:bg-[color-mix(in_srgb,var(--landing-positive)_10%,transparent)] focus-visible:outline-offset-1"
                    href={routeFor(result, lang, "live")}
                    onPointerDown={(event) => event.stopPropagation()}
                    title={messages.landing.liveAction}
                  >
                    <Radio className="size-4" />
                  </Link>
                  <Link
                    aria-label={`${messages.landing.historyAction}: ${label}`}
                    className="grid size-9 place-items-center rounded-lg text-[var(--landing-highlight)] transition hover:bg-[color-mix(in_srgb,var(--landing-highlight)_10%,transparent)] focus-visible:outline-offset-1"
                    href={routeFor(result, lang, "history")}
                    onPointerDown={(event) => event.stopPropagation()}
                    title={messages.landing.historyAction}
                  >
                    <History className="size-4" />
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
