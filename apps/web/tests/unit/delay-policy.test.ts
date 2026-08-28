import { describe, expect, it } from "vitest";
import { delayBand } from "@/lib/domain/delay-policy";
import { formatDelay } from "@/lib/domain/format";

describe("delay policy", () => {
  it("owns the punctual, mild and severe boundaries", () => {
    expect(delayBand(120)).toBe("punctual");
    expect(delayBand(121)).toBe("mild");
    expect(delayBand(300)).toBe("mild");
    expect(delayBand(301)).toBe("delayed");
    expect(delayBand(600)).toBe("delayed");
    expect(delayBand(601)).toBe("severe");
  });

  it("keeps precise seconds while presenting friendly units", () => {
    expect(formatDelay(186, "es")).toBe("+3 min 06 s");
  });
});
