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

  it("uses a known station as the fallback position but never fabricates an unknown one", async () => {
    const line = await createFixtureAdapter("reverse-branch").liveLine("c1");
    const plotted = layoutSchematicPatterns(line!.patterns);
    const unknown = line!.trains.find((train) => train.position.kind === "unknown");
    expect(unknown).toBeDefined();
    expect(pointForTrain(unknown!, plotted)).not.toBeNull();
    if (unknown?.position.kind !== "unknown") throw new Error("Expected unknown-position fixture");
    expect(pointForTrain({ ...unknown, patternId: null, position: { ...unknown.position, stationHintId: null } }, plotted)).toBeNull();

    const atStation = line!.trains.find((train) => train.position.kind === "at_station");
    expect(atStation).toBeDefined();
    expect(pointForTrain({ ...atStation!, patternId: null }, plotted)).not.toBeNull();

    const between = line!.trains.find((train) => train.position.kind === "between_stations");
    expect(between).toBeDefined();
    if (between?.position.kind !== "between_stations") throw new Error("Expected between-stations fixture");
    expect(pointForTrain({ ...between, position: { ...between.position, progress: null } }, plotted)).toBeNull();
  });
});
