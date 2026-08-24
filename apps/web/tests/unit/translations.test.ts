import { describe, expect, it } from "vitest";
import { en } from "@/messages/en";
import { es } from "@/messages/es";
import { methodologyCopy } from "@/messages/methodology";

function keyShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(keyShape);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, keyShape(child)]));
  return typeof value;
}

describe("typed locale dictionaries", () => {
  it("keeps Spanish and English dictionaries structurally aligned", () => {
    expect(keyShape(en)).toEqual(keyShape(es));
  });

  it("keeps methodology sections aligned and gives English room for longer copy", () => {
    expect(methodologyCopy.en.sections.map((section) => section.title).length).toBe(methodologyCopy.es.sections.length);
    expect(methodologyCopy.en.intro.length).toBeGreaterThan(60);
  });
});
