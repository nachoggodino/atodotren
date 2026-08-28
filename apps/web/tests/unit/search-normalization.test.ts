import { describe, expect, it } from "vitest";
import { normalizeSearch, normalizedLineAlias } from "@/lib/domain/search";

describe("search normalization", () => {
  it("normalizes equivalent Cercanías line-code spellings", () => {
    for (const value of ["C-1", "c 01", "C1"]) expect(normalizedLineAlias(value)).toBe("c1");
  });

  it("ignores accents, punctuation and surrounding whitespace for station matching", () => {
    expect(normalizeSearch("  Méndez-Álvaro ")).toBe("mendezalvaro");
  });
});
