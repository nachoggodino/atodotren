import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { Lang, LinePerformance } from "@/lib/domain/contracts";
import { formatDelay, formatPercent } from "@/lib/domain/format";
import type { Messages } from "@/messages/types";

function lineTextColor(background: string): "#000000" | "#ffffff" {
  const hex = background.replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(hex)) return "#000000";
  const channels = [0, 2, 4].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
  return luminance > 0.179 ? "#000000" : "#ffffff";
}

export function LineList({ lines, lang, messages }: { readonly lines: readonly LinePerformance[]; readonly lang: Lang; readonly messages: Messages }) {
  return <div className="divide-y divide-border border-y border-border">{lines.map((line) => <Link className="grid grid-cols-[auto_1fr_auto] items-center gap-4 py-4 hover:bg-muted-soft/50 sm:grid-cols-[auto_1fr_repeat(3,minmax(6rem,auto))_auto]" href={`/${lang}/live/line/${line.slug}`} key={line.id}><span className="grid size-10 place-items-center rounded-md font-black" style={{ background: line.color, color: lineTextColor(line.color) }}>{line.code}</span><span><strong className="block">{line.name[lang]}</strong><span className="text-xs text-muted">{line.activeTrains} {messages.live.activeTrains}</span></span><span className="hidden text-right sm:block"><small className="block text-muted">{messages.common.punctuality}</small><strong>{formatPercent(line.stats.punctuality)}</strong></span><span className="hidden text-right sm:block"><small className="block text-muted">{messages.common.mean}</small><strong>{formatDelay(line.stats.meanDelaySeconds, lang)}</strong></span><span className="hidden text-right sm:block"><small className="block text-muted">{messages.common.coverage}</small><strong>{formatPercent(line.stats.scheduled === 0 ? null : line.stats.observed / line.stats.scheduled)}</strong></span><ArrowRight className="size-4 text-muted" /></Link>)}</div>;
}
