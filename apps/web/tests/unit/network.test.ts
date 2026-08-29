import { describe, expect, it } from "vitest";
import { fallbackLineColor, MADRID_NETWORK, preferredLineTextColor } from "@/lib/domain/network";

describe("Madrid network presentation catalog", () => {
  it("owns the quick-line codes, order, colors and foregrounds in one catalog", () => {
    expect(MADRID_NETWORK.lines.map(({ code }) => code)).toEqual(["C1", "C2", "C3", "C4", "C5", "C7", "C8", "C10"]);
    expect(new Set(MADRID_NETWORK.lines.map(({ slug }) => slug)).size).toBe(MADRID_NETWORK.lines.length);
    for (const line of MADRID_NETWORK.lines) {
      expect(fallbackLineColor(line.slug)).toBe(line.color);
      expect(preferredLineTextColor(line.slug)).toBe(line.textColor);
    }
    expect(preferredLineTextColor("c1")).toBe("#ffffff");
  });
});
