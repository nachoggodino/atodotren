import type { CSSProperties } from "react";

export function lineBadgeTextColor(background: string): "#000000" | "#ffffff" {
  const hex = background.replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(hex)) return "#000000";
  const channels = [0, 2, 4].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
  return luminance > 0.179 ? "#000000" : "#ffffff";
}

export function LineBadge({ code, color, className = "", variant = "default" }: { readonly code: string; readonly color: string; readonly className?: string; readonly variant?: "default" | "compact" }) {
  const style: CSSProperties = { backgroundColor: color, color: lineBadgeTextColor(color) };
  const sizing = variant === "compact" ? "size-7 rounded text-[10px]" : "size-10 rounded-md text-sm";
  return <span className={`grid shrink-0 place-items-center font-black ${sizing} ${className}`} style={style}>{code}</span>;
}
