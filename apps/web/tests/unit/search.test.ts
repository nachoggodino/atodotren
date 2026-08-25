import { describe, expect, it } from "vitest";
import { normalizeSearch, normalizedLineAlias } from "@/lib/domain/search";

 describe("search normalization", () => {
  it("treats compact and punctuated Cercanías codes as the same alias", () => {
    expect(normalizedLineAlias("C-1")).toBe("c1");
    expect(normalizedLineAlias("c 01")).toBe("c1");
    expect(normalizedLineAlias("C1")).toBe("c1");
  });

  it("is accent and punctuation insensitive for station matching", () => {
    expect(normalizeSearch("  Méndez-Álvaro ")).toBe("mendezalvaro");
  });
});
