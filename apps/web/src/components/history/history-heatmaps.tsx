"use client";

import * as Ariakit from "@ariakit/react";
import { CircleArrowRight, SlidersHorizontal } from "lucide-react";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import type { DirectionDescriptor, DirectionId, HistoryFilters, Lang } from "@/lib/domain/contracts";
import { formatDelay } from "@/lib/domain/format";
import type { HistoryAnalysisContext, HistoryHeatmapCell, HistoryHeatmapMetric, HistoryHeatmapResponse, HistoryHeatmapType } from "@/lib/domain/history-analysis";
import { historyHeatmapTypeRequiresLine, historyHeatmapTypeUsesSegments, historyHeatmapTypesForContext } from "@/lib/domain/history-analysis";
import { MADRID_LINES } from "@/lib/domain/network";
import { historyAnalysisCopy } from "./history-analysis-copy";

interface HeatmapConfig {
  readonly type: HistoryHeatmapType;
  readonly lineSlug: string | null;
  readonly direction: DirectionId | null;
}

const COMMON_METRICS: readonly HistoryHeatmapMetric[] = ["punctuality", "mean-delay", "median-delay", "cancellation-rate", "coverage"];
const MINIMUM_SAMPLES = [10, 25, 50, 100] as const;
const CHIP_CLASS = "h-7 rounded-full border border-border bg-surface px-2.5 text-[12px] font-semibold leading-none transition-[background-color,border-color,color,transform] active:scale-95 aria-pressed:border-[var(--landing-highlight)] aria-pressed:bg-[var(--landing-highlight)] aria-pressed:text-[var(--background)]";
const GROUP_LABEL_CLASS = "mb-1.5 text-[13px] font-bold leading-none text-muted";

function HeatmapSkeleton() {
  return <div className="rounded-xl border border-border bg-surface-strong p-3" data-testid="explore-heatmap-skeleton">
    <div className="skeleton h-5 w-40 rounded" />
    <div className="mt-4 grid grid-cols-[5rem_repeat(5,1fr)] gap-1">
      {Array.from({ length: 30 }, (_, index) => <div className={`skeleton rounded ${index % 6 === 0 ? "h-7" : "h-10"}`} key={index} />)}
    </div>
  </div>;
}

function filtersIntoParams(params: URLSearchParams, filters: HistoryFilters) {
  params.set("from", filters.from);
  params.set("to", filters.to);
  if (filters.weekdays.length > 0) params.set("weekdays", filters.weekdays.join(","));
  if (filters.hour !== null) {
    params.set("hourFrom", String(filters.hour));
    params.set("hourTo", String(filters.hourTo ?? filters.hour));
  }
  if (filters.direction !== null) params.set("direction", String(filters.direction));
}

function sameConfig(left: HeatmapConfig, right: HeatmapConfig): boolean {
  return left.type === right.type && left.lineSlug === right.lineSlug && left.direction === right.direction;
}

function directionName(direction: DirectionDescriptor, lang: Lang): string {
  return direction.headsign?.[lang] ?? direction.to?.name[lang] ?? (lang === "es" ? `sentido ${direction.id + 1}` : `direction ${direction.id + 1}`);
}

function metricValue(cell: HistoryHeatmapCell, metric: HistoryHeatmapMetric): number | null {
  if (metric === "punctuality") return cell.punctuality;
  if (metric === "mean-delay") return cell.meanDelaySeconds;
  if (metric === "median-delay") return cell.medianDelaySeconds;
  if (metric === "cancellation-rate") return cell.cancellationRate;
  if (metric === "coverage") return cell.coverage;
  return cell.addedDelaySeconds;
}

function formatMetric(value: number | null, metric: HistoryHeatmapMetric, lang: Lang): string {
  if (value === null) return "—";
  if (metric === "punctuality" || metric === "cancellation-rate" || metric === "coverage") return `${Math.round(value * 1000) / 10}%`;
  return formatDelay(Math.round(value), lang);
}

function heatStyle(value: number | null, min: number, max: number, metric: HistoryHeatmapMetric): CSSProperties {
  if (value === null) return { background: "var(--surface)" };
  const normalized = max <= min ? 0.5 : Math.max(0, Math.min(1, (value - min) / (max - min)));
  const lowerIsBad = metric === "punctuality" || metric === "coverage";
  const badness = lowerIsBad ? 1 - normalized : normalized;
  const danger = Math.round(16 + badness * 50);
  return { background: `color-mix(in srgb, var(--danger) ${danger}%, color-mix(in srgb, var(--success) ${Math.round((1 - badness) * 28)}%, var(--surface)))` };
}

function axisLabel(dimension: HistoryHeatmapResponse["xDimension"], key: string, fallback: string, lang: Lang): string {
  if (dimension !== "weekday") return fallback;
  const labels = historyAnalysisCopy(lang).weekdays;
  return labels[Number(key)] ?? fallback;
}

function HeatmapGrid({ data, metric, minimumSamples, lang }: { readonly data: HistoryHeatmapResponse; readonly metric: HistoryHeatmapMetric; readonly minimumSamples: number; readonly lang: Lang }) {
  const xs = useMemo(() => [...new Map(data.cells.map((cell) => [cell.x, { key: cell.x, label: cell.xLabel, order: cell.xOrder }])).values()].sort((a, b) => a.order - b.order), [data]);
  const ys = useMemo(() => [...new Map(data.cells.map((cell) => [cell.y, { key: cell.y, label: cell.yLabel, order: cell.yOrder }])).values()].sort((a, b) => a.order - b.order), [data]);
  const byCell = useMemo(() => new Map(data.cells.map((cell) => [`${cell.y}:${cell.x}`, cell])), [data]);
  const values = data.cells.filter((cell) => cell.observed >= minimumSamples).map((cell) => metricValue(cell, metric)).filter((value): value is number => value !== null);
  const min = values.length === 0 ? 0 : Math.min(...values);
  const max = values.length === 0 ? 1 : Math.max(...values);

  if (data.cells.length === 0) return <p className="border-y border-border py-8 text-sm text-muted">{historyAnalysisCopy(lang).noData}</p>;

  return <div className="overflow-x-auto rounded-xl border border-border" data-testid="explore-heatmap-grid">
    <div className="grid min-w-max gap-px bg-border" style={{ gridTemplateColumns: `minmax(7rem, 10rem) repeat(${xs.length}, minmax(3.75rem, 1fr))` }}>
      <span className="bg-surface-strong" />
      {xs.map((x) => <strong className="bg-surface-strong px-2 py-2 text-center text-[11px]" key={x.key}>{axisLabel(data.xDimension, x.key, x.label, lang)}</strong>)}
      {ys.flatMap((y) => [
        <strong className="sticky left-0 z-10 bg-surface-strong px-2 py-3 text-left text-[11px]" key={`label-${y.key}`}>{axisLabel(data.yDimension, y.key, y.label, lang)}</strong>,
        ...xs.map((x) => {
          const cell = byCell.get(`${y.key}:${x.key}`);
          const eligible = cell !== undefined && cell.observed >= minimumSamples;
          const value = eligible ? metricValue(cell, metric) : null;
          return <span
            className="grid min-h-11 place-items-center px-1.5 py-2 text-center text-[11px] font-bold tabular-nums"
            key={`${y.key}:${x.key}`}
            style={eligible ? heatStyle(value, min, max, metric) : { background: "var(--surface)" }}
            title={cell === undefined ? undefined : `${formatMetric(metricValue(cell, metric), metric, lang)} · n=${cell.observed} · ${Math.round((cell.coverage ?? 0) * 100)}% coverage`}
          >
            {eligible ? formatMetric(value, metric, lang) : <span className="text-muted">—</span>}
          </span>;
        }),
      ])}
    </div>
  </div>;
}

export function HistoryHeatmaps({
  context,
  filters,
  fixedLineSlug,
  initialDirections,
  lang,
  scenario,
}: {
  readonly context: HistoryAnalysisContext;
  readonly filters: HistoryFilters;
  readonly fixedLineSlug: string | null;
  readonly initialDirections: readonly DirectionDescriptor[];
  readonly lang: Lang;
  readonly scenario?: string;
}) {
  const copy = historyAnalysisCopy(lang);
  const sectionRef = useRef<HTMLElement>(null);
  const requestSequence = useRef(0);
  const allowedTypes = historyHeatmapTypesForContext(context.kind);
  const defaultType: HistoryHeatmapType = context.kind === "line" ? "station-hour" : context.kind === "station" ? "line-hour" : "hour-weekday";
  const [config, setConfig] = useState<HeatmapConfig>({ type: defaultType, lineSlug: fixedLineSlug, direction: null });
  const [metric, setMetric] = useState<HistoryHeatmapMetric>("mean-delay");
  const [minimumSamples, setMinimumSamples] = useState(25);
  const [data, setData] = useState<HistoryHeatmapResponse | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [visible, setVisible] = useState(false);
  const [open, setOpen] = useState(false);
  const [typeDraft, setTypeDraft] = useState<HistoryHeatmapType>(defaultType);
  const [lineDraft, setLineDraft] = useState<string | null>(fixedLineSlug);
  const [directionDraft, setDirectionDraft] = useState<DirectionId | null>(null);
  const [metricDraft, setMetricDraft] = useState<HistoryHeatmapMetric>("mean-delay");
  const [minimumDraft, setMinimumDraft] = useState(25);
  const [directions, setDirections] = useState<readonly DirectionDescriptor[]>(initialDirections);

  const load = async (next: HeatmapConfig) => {
    const sequence = ++requestSequence.current;
    setStatus("loading");
    const params = new URLSearchParams();
    filtersIntoParams(params, filters);
    params.set("context", context.kind);
    params.set("contextKey", context.key);
    params.set("type", next.type);
    if (next.lineSlug !== null) params.set("line", next.lineSlug);
    if (next.direction !== null) params.set("heatmapDirection", String(next.direction));
    if (scenario !== undefined) params.set("scenario", scenario);
    try {
      const response = await fetch(`/api/v1/history/heatmap?${params.toString()}`);
      if (!response.ok) throw new Error(`Heatmap request failed with ${response.status}`);
      const body = await response.json() as HistoryHeatmapResponse;
      if (sequence !== requestSequence.current) return;
      setData(body);
      setStatus("ready");
    } catch {
      if (sequence !== requestSequence.current) return;
      setStatus("error");
    }
  };

  useEffect(() => {
    const element = sectionRef.current;
    if (element === null || visible) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "400px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (visible && status === "idle") void load(config);
  }, [visible, status, config]);

  useEffect(() => {
    if (!open) return;
    const activeLine = fixedLineSlug ?? (historyHeatmapTypeRequiresLine(typeDraft) ? lineDraft : null);
    if (activeLine === null) {
      setDirections([]);
      return;
    }
    if (fixedLineSlug !== null && activeLine === fixedLineSlug) {
      setDirections(initialDirections);
      return;
    }
    const params = new URLSearchParams();
    if (scenario !== undefined) params.set("scenario", scenario);
    void fetch(`/api/v1/history/lines/${encodeURIComponent(activeLine)}/directions?${params.toString()}`)
      .then((response) => response.ok ? response.json() as Promise<{ directions: readonly DirectionDescriptor[] }> : Promise.reject(new Error("directions")))
      .then((body) => setDirections(body.directions))
      .catch(() => setDirections([]));
  }, [open, typeDraft, lineDraft, fixedLineSlug, initialDirections, scenario]);

  const setPopoverOpen = (nextOpen: boolean) => {
    if (nextOpen) {
      setTypeDraft(config.type);
      setLineDraft(config.lineSlug);
      setDirectionDraft(config.direction);
      setMetricDraft(metric);
      setMinimumDraft(minimumSamples);
      setDirections(initialDirections);
    }
    setOpen(nextOpen);
  };

  const selectType = (type: HistoryHeatmapType) => {
    setTypeDraft(type);
    if (context.kind === "network" && historyHeatmapTypeRequiresLine(type) && lineDraft === null) setLineDraft(MADRID_LINES[0].slug);
    if (!historyHeatmapTypeUsesSegments(type) && metricDraft === "added-delay") setMetricDraft("mean-delay");
    setDirectionDraft(null);
  };

  const apply = () => {
    const needsLine = context.kind === "line" || (context.kind === "network" && historyHeatmapTypeRequiresLine(typeDraft));
    const nextLine = context.kind === "line" ? fixedLineSlug : needsLine ? lineDraft : null;
    if (needsLine && nextLine === null) return;
    const next: HeatmapConfig = { type: typeDraft, lineSlug: nextLine, direction: filters.direction ?? directionDraft };
    setMetric(metricDraft);
    setMinimumSamples(minimumDraft);
    setOpen(false);
    if (!sameConfig(config, next)) {
      setConfig(next);
      void load(next);
    }
  };

  const availableMetrics = historyHeatmapTypeUsesSegments(typeDraft) ? [...COMMON_METRICS, "added-delay" as const] : COMMON_METRICS;
  const activeLineDraft = fixedLineSlug ?? (historyHeatmapTypeRequiresLine(typeDraft) ? lineDraft : null);
  const showDirection = filters.direction === null && activeLineDraft !== null;

  return <section className="mt-12 border-t border-border pt-8" ref={sectionRef} data-testid="explore-heatmaps">
    <div className="flex items-center justify-between gap-4">
      <div>
        <h2 className="text-2xl font-black">{copy.heatmaps}</h2>
        <p className="mt-1 text-xs font-semibold text-muted">{copy.heatmapTypes[config.type]} · {copy.metrics[metric]}</p>
      </div>
      <Ariakit.PopoverProvider open={open} setOpen={setPopoverOpen}>
        <Ariakit.PopoverDisclosure className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface-strong px-2.5 text-[11px] font-bold transition-[background-color,transform] hover:bg-muted-soft active:scale-95" type="button">
          <SlidersHorizontal className="size-3.5 text-[var(--landing-highlight)]" />
          {copy.customize}
        </Ariakit.PopoverDisclosure>
        <Ariakit.Popover className="z-[80] w-[min(34rem,calc(100vw-1rem))] rounded-xl border border-border bg-surface-strong p-3 text-foreground shadow-[var(--shadow-float)] outline-none" gutter={8} portal>
          <Ariakit.PopoverHeading className="sr-only">{copy.customizeHeatmap}</Ariakit.PopoverHeading>
          <div>
            <p className={GROUP_LABEL_CLASS}>{copy.heatmapType}</p>
            <div className="flex flex-wrap gap-1" role="radiogroup">
              {allowedTypes.map((type) => <button aria-checked={typeDraft === type} aria-pressed={typeDraft === type} className={CHIP_CLASS} key={type} onClick={() => selectType(type)} role="radio" type="button">{copy.heatmapTypes[type]}</button>)}
            </div>
          </div>
          <div className="mt-3">
            <p className={GROUP_LABEL_CLASS}>{copy.metric}</p>
            <div className="flex flex-wrap gap-1" role="radiogroup">
              {availableMetrics.map((option) => <button aria-checked={metricDraft === option} aria-pressed={metricDraft === option} className={CHIP_CLASS} key={option} onClick={() => setMetricDraft(option)} role="radio" type="button">{copy.metrics[option]}</button>)}
            </div>
          </div>
          {context.kind === "network" && historyHeatmapTypeRequiresLine(typeDraft) ? <div className="mt-3">
            <p className={GROUP_LABEL_CLASS}>{copy.line}</p>
            <div className="flex flex-wrap gap-1" role="radiogroup">
              {MADRID_LINES.map((line) => <button aria-checked={lineDraft === line.slug} aria-pressed={lineDraft === line.slug} className={CHIP_CLASS} key={line.slug} onClick={() => { setLineDraft(line.slug); setDirectionDraft(null); }} role="radio" type="button">{line.code}</button>)}
            </div>
          </div> : null}
          {showDirection ? <div className="mt-3">
            <p className={GROUP_LABEL_CLASS}>{copy.direction}</p>
            <div className="flex flex-wrap gap-1" role="radiogroup">
              <button aria-checked={directionDraft === null} aria-pressed={directionDraft === null} className={CHIP_CLASS} onClick={() => setDirectionDraft(null)} role="radio" type="button">{copy.bothDirections}</button>
              {directions.map((direction) => <button aria-checked={directionDraft === direction.id} aria-pressed={directionDraft === direction.id} className={CHIP_CLASS} key={direction.id} onClick={() => setDirectionDraft(direction.id)} role="radio" type="button">{copy.towards} {directionName(direction, lang)}</button>)}
            </div>
          </div> : null}
          <div className="mt-3">
            <p className={GROUP_LABEL_CLASS}>{copy.minimumSamples}</p>
            <div className="flex flex-wrap gap-1" role="radiogroup">
              {MINIMUM_SAMPLES.map((sample) => <button aria-checked={minimumDraft === sample} aria-pressed={minimumDraft === sample} className={CHIP_CLASS} key={sample} onClick={() => setMinimumDraft(sample)} role="radio" type="button">{sample}</button>)}
            </div>
          </div>
          <div className="mt-3 flex justify-end">
            <button aria-label={copy.customize} className="grid size-7 place-items-center rounded-full text-[var(--landing-highlight)] transition-[background-color,transform] hover:bg-muted-soft active:scale-90" onClick={apply} type="button"><CircleArrowRight className="size-4" /></button>
          </div>
        </Ariakit.Popover>
      </Ariakit.PopoverProvider>
    </div>
    <div className="mt-4">
      {status === "idle" || status === "loading" ? <HeatmapSkeleton /> : null}
      {status === "error" ? <div className="rounded-xl border border-border bg-surface-strong p-5 text-sm text-muted"><p>{copy.loadError}</p><button className="mt-3 font-bold text-[var(--landing-highlight)]" onClick={() => void load(config)} type="button">{copy.retry}</button></div> : null}
      {status === "ready" && data !== null ? <HeatmapGrid data={data} metric={metric} minimumSamples={minimumSamples} lang={lang} /> : null}
    </div>
  </section>;
}
