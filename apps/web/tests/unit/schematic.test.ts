import { describe, expect, it } from "vitest";
import { createFixtureAdapter } from "@/lib/fixtures/scenarios";
import { layoutSchematicPatterns, pointForTrain } from "@/lib/domain/schematic";

describe("schematic geometry", () => {
  it("positions forward and reverse trains from their own ordered patterns", async () => {
    const line = await createFixtureAdapter("reverse-branch").liveLine("c1");
    expect(line).not.toBeNull();
    const plotted = layoutSchematicPatterns(line!.patterns);
    const reverse = line!.trains.find((train) => train.direction?.id === 1 && train.position.kind === "between_stations");
    expect(reverse).toBeDefined();
    const point = pointForTrain(reverse!, plotted);
    expect(point?.patternId).toBe(reverse?.patternId);
    expect(point?.x).toBeTypeOf("number");
  });

  it("does not fabricate coordinates for unknown or progress-less positions", async () => {
    const line = await createFixtureAdapter("reverse-branch").liveLine("c1");
    const plotted = layoutSchematicPatterns(line!.patterns);
    const unknown = line!.trains.find((train) => train.position.kind === "unknown");
    expect(unknown).toBeDefined();
    expect(pointForTrain(unknown!, plotted)).toBeNull();

    const between = line!.trains.find((train) => train.position.kind === "between_stations");
    expect(between).toBeDefined();
    if (between?.position.kind !== "between_stations") throw new Error("Expected between-stations fixture");
    expect(pointForTrain({ ...between, position: { ...between.position, progress: null } }, plotted)).toBeNull();
  });
});
