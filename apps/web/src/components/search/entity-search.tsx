"use client";

import { ArrowRight, History, Radio, Search, TrainFront } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import type { Lang, SearchResponse, SearchResult } from "@/lib/domain/contracts";
import type { Messages } from "@/messages/types";

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

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 1) { setResults([]); setSelected(null); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/v1/catalog/search?q=${encodeURIComponent(trimmed)}`, { signal: controller.signal });
        if (!response.ok) throw new Error("search failed");
        const payload = await response.json() as SearchResponse;
        setResults(payload.results);
        setSelected((current) => payload.results.find((result) => result.id === current?.id) ?? null);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) setResults([]);
      } finally { setLoading(false); }
    }, 160);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query]);

  return (
    <div className="relative">
      <label className="mb-2 block text-sm font-bold" htmlFor={inputId}>{messages.landing.searchLabel}</label>
      <div className="flex min-h-14 items-center gap-3 border-b-2 border-foreground bg-transparent px-1">
        <Search aria-hidden="true" className="size-5 text-muted" />
        <input id={inputId} autoComplete="off" className="min-w-0 flex-1 bg-transparent py-3 text-lg outline-none placeholder:text-muted/70" onChange={(event) => setQuery(event.target.value)} placeholder={messages.landing.searchPlaceholder} value={query} />
        {loading ? <span aria-label="Loading" className="size-4 animate-spin rounded-full border-2 border-border border-t-primary motion-reduce:animate-none" /> : null}
      </div>
      {query.trim() !== "" ? <div className="mt-2 overflow-hidden rounded-xl border border-border bg-surface-strong shadow-[var(--shadow-float)]" role="listbox" aria-label={messages.landing.searchLabel}>
        {results.length === 0 && !loading ? <p className="px-4 py-4 text-sm text-muted">{messages.landing.emptySearch}</p> : results.map((result) => {
          const active = selected?.id === result.id;
          return <button key={`${result.kind}-${result.id}`} aria-selected={active} className="flex w-full items-center gap-3 border-b border-border px-4 py-3 text-left last:border-b-0 hover:bg-muted-soft aria-selected:bg-muted-soft" onClick={() => setSelected(result)} role="option" type="button">
            {result.kind === "line" ? <TrainFront className="size-5" /> : <Radio className="size-5" />}
            <span className="min-w-0 flex-1"><strong className="block">{result.code ? `${result.code} · ` : ""}{result.name[lang]}</strong><span className="text-xs text-muted">{result.kind === "line" ? (lang === "es" ? "Línea" : "Line") : (lang === "es" ? "Estación" : "Station")}</span></span>
            <ArrowRight className="size-4 text-muted" />
          </button>;
        })}
      </div> : null}
      {selected ? <div className="mt-4 grid grid-cols-2 gap-2"><Link className="flex min-h-12 items-center justify-center gap-2 rounded-lg bg-primary px-3 font-bold text-background" href={routeFor(selected, lang, "live")}><Radio className="size-4" />{messages.landing.liveAction}</Link><Link className="flex min-h-12 items-center justify-center gap-2 rounded-lg border border-border px-3 font-bold hover:bg-muted-soft" href={routeFor(selected, lang, "history")}><History className="size-4" />{messages.landing.historyAction}</Link></div> : null}
    </div>
  );
}
