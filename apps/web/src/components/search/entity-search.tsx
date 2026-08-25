"use client";

import * as Ariakit from "@ariakit/react";
import { ArrowRight, History, Radio, Search, TrainFront } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import type { Lang, SearchResponse, SearchResult } from "@/lib/domain/contracts";
import type { Messages } from "@/messages/types";

const SEARCH_DEBOUNCE_MS = 160;

function routeFor(result: SearchResult, lang: Lang, mode: "live" | "history"): string {
  const slug = result.kind === "line" ? result.slug.es : result.slug[lang];
  return `/${lang}/${mode}/${result.kind}/${slug}`;
}

export function EntitySearch({ lang, messages }: { readonly lang: Lang; readonly messages: Messages }) {
  const inputId = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly SearchResult[]>([]);
  const [selected, setSelected] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  const onQueryChange = (value: string) => {
    setQuery(value);
    setFailed(false);
    if (value.trim() === "") {
      setResults([]);
      setSelected(null);
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
        const response = await fetch(`/api/v1/catalog/search?q=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Search request failed with ${response.status}`);
        const payload = await response.json() as SearchResponse;
        setResults(payload.results);
        setSelected((current) => payload.results.find((result) => result.id === current?.id) ?? null);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setResults([]);
        setSelected(null);
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
        <Ariakit.ComboboxLabel className="mb-2 block text-sm font-bold" htmlFor={inputId}>
          {messages.landing.searchLabel}
        </Ariakit.ComboboxLabel>
        <div className="flex min-h-14 items-center gap-3 border-b-2 border-foreground bg-transparent px-1">
          <Search aria-hidden="true" className="size-5 text-muted" />
          <Ariakit.Combobox
            id={inputId}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent py-3 text-lg outline-none placeholder:text-muted/70"
            placeholder={messages.landing.searchPlaceholder}
          />
          {loading ? <span aria-label={messages.common.loading} className="size-4 animate-spin rounded-full border-2 border-border border-t-primary motion-reduce:animate-none" /> : null}
        </div>
        <Ariakit.ComboboxPopover
          gutter={8}
          sameWidth
          className="z-[80] overflow-hidden rounded-xl border border-border bg-surface-strong shadow-[var(--shadow-float)]"
        >
          {failed ? <p className="px-4 py-4 text-sm text-danger" role="status">{messages.landing.searchError}</p> : null}
          {!failed && results.length === 0 && !loading ? <p className="px-4 py-4 text-sm text-muted" role="status">{messages.landing.emptySearch}</p> : null}
          {!failed && results.length > 0 ? <Ariakit.ComboboxList>
            {results.map((result) => (
              <Ariakit.ComboboxItem
                key={`${result.kind}-${result.id}`}
                value={result.name[lang]}
                selectValueOnClick={false}
                className="flex w-full cursor-pointer items-center gap-3 border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-muted-soft data-[active-item]:bg-muted-soft"
                onClick={() => {
                  setSelected(result);
                  setOpen(false);
                }}
              >
                {result.kind === "line" ? <TrainFront className="size-5" /> : <Radio className="size-5" />}
                <span className="min-w-0 flex-1">
                  <strong className="block">{result.code ? `${result.code} · ` : ""}{result.name[lang]}</strong>
                  <span className="text-xs text-muted">{result.kind === "line" ? messages.common.line : messages.common.station}</span>
                </span>
                <ArrowRight className="size-4 text-muted" />
              </Ariakit.ComboboxItem>
            ))}
          </Ariakit.ComboboxList> : null}
        </Ariakit.ComboboxPopover>
        {selected ? <div className="mt-4 grid grid-cols-2 gap-2">
          <Link className="flex min-h-12 items-center justify-center gap-2 rounded-lg bg-primary px-3 font-bold text-background" href={routeFor(selected, lang, "live")}>
            <Radio className="size-4" />{messages.landing.liveAction}
          </Link>
          <Link className="flex min-h-12 items-center justify-center gap-2 rounded-lg border border-border px-3 font-bold hover:bg-muted-soft" href={routeFor(selected, lang, "history")}>
            <History className="size-4" />{messages.landing.historyAction}
          </Link>
        </div> : null}
      </div>
    </Ariakit.ComboboxProvider>
  );
}
