import "server-only";

import { createFixtureAdapter } from "@/lib/fixtures/scenarios";
import type { PublicDataAdapter } from "./data-adapter";
import { getWebServerConfig } from "./config";

let postgresAdapter: PublicDataAdapter | null = null;

export async function getDataAdapter(scenarioOverride?: string): Promise<PublicDataAdapter> {
  const config = getWebServerConfig();
  if (config.mode === "fixture") return createFixtureAdapter(scenarioOverride ?? config.fixtureScenario);
  if (postgresAdapter !== null) return postgresAdapter;
  const { createPostgresAdapter } = await import("./postgres-adapter");
  postgresAdapter = createPostgresAdapter(config);
  return postgresAdapter;
}
