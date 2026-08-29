import type { CSSProperties } from "react";
import { MADRID_LINE_TEXT_COLOR } from "@/lib/domain/network";

export function LineBadge({ code, color, className = "" }: { readonly code: string; readonly color: string; readonly className?: string }) {
  const style: CSSProperties = { backgroundColor: color, color: MADRID_LINE_TEXT_COLOR };
  return <span className={`grid size-10 shrink-0 place-items-center rounded-md text-sm font-black ${className}`} style={style}>{code}</span>;
}
