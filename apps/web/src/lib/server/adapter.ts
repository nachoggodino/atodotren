import "server-only";

import { createFixtureAdapter } from "@/lib/fixtures/scenarios";
import type { PublicDataAdapter } from "./data-adapter";
import { getWebServerConfig } from "./config";

export async function getDataAdapter(scenarioOverride?: string): Promise<PublicDataAdapter> {
  const config = getWebServerConfig();
  if (config.mode === "fixture") return createFixtureAdapter(scenarioOverride ?? config.fixtureScenario);
  const { createPostgresAdapter } = await import("./postgres-adapter");
  return createPostgresAdapter(config);
}
