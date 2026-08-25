import "server-only";

import { createFixtureAdapter } from "@/lib/fixtures/scenarios";
import type { PublicDataAdapter } from "./data-adapter";
import { getWebServerConfig } from "./config";

let postgresAdapter: PublicDataAdapter | null = null;

export function effectiveFixtureScenario(scenarioOverride?: string): string | undefined {
  const config = getWebServerConfig();
  if (config.mode !== "fixture") return undefined;
  if (scenarioOverride !== undefined && config.fixtureScenarioOverridesEnabled) return scenarioOverride;
  return config.fixtureScenario;
}

export async function getDataAdapter(scenarioOverride?: string): Promise<PublicDataAdapter> {
  const config = getWebServerConfig();
  if (config.mode === "fixture") return createFixtureAdapter(effectiveFixtureScenario(scenarioOverride) ?? config.fixtureScenario);
  if (postgresAdapter !== null) return postgresAdapter;
  const { createPostgresAdapter } = await import("./postgres-adapter");
  postgresAdapter = createPostgresAdapter(config);
  return postgresAdapter;
}
