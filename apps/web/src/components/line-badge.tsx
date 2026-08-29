import type { CSSProperties } from "react";
import { MADRID_LINE_TEXT_COLOR } from "@/lib/domain/network";

export function lineBadgeTextColor(_background: string): typeof MADRID_LINE_TEXT_COLOR {
  return MADRID_LINE_TEXT_COLOR;
}

export function LineBadge({ code, color, className = "", variant = "default" }: { readonly code: string; readonly color: string; readonly className?: string; readonly variant?: "default" | "compact" }) {
  const style: CSSProperties = { backgroundColor: color, color: lineBadgeTextColor(color) };
  const sizing = variant === "compact" ? "size-7 rounded text-[10px]" : "size-10 rounded-md text-sm";
  return <span className={`grid shrink-0 place-items-center font-black ${sizing} ${className}`} style={style}>{code}</span>;
}
