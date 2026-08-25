import { describe, expect, it } from "vitest";
import { getWebServerConfig } from "@/lib/server/config";

describe("web server configuration safety", () => {
  it("rejects fixture mode in production without an explicit private-preview override", () => {
    expect(() => getWebServerConfig({ NODE_ENV: "production", WEB_DATA_MODE: "fixture" })).toThrow(/Fixture data mode is forbidden/);
  });

  it("gates fixture scenario query overrides separately from fixture mode", () => {
    const config = getWebServerConfig({ NODE_ENV: "production", WEB_DATA_MODE: "fixture", WEB_ALLOW_FIXTURE_PRODUCTION: "true", WEB_ENABLE_FIXTURE_SCENARIOS: "true" });
    expect(config.mode).toBe("fixture");
    expect(config.fixtureScenarioOverridesEnabled).toBe(true);
  });

  it("requires a database URL and verified TLS by default in postgres production", () => {
    expect(() => getWebServerConfig({ NODE_ENV: "production", WEB_DATA_MODE: "postgres" })).toThrow(/WEB_DATABASE_URL/);
    const config = getWebServerConfig({ NODE_ENV: "production", WEB_DATA_MODE: "postgres", WEB_DATABASE_URL: "postgres://example.invalid/atodotren" });
    expect(config.databaseSslMode).toBe("verify-full");
    expect(config.databaseSslCa).toBeNull();
  });

  it("accepts an explicit CA bundle and rejects insecure production TLS unless deliberately overridden", () => {
    const config = getWebServerConfig({ NODE_ENV: "production", WEB_DATA_MODE: "postgres", WEB_DATABASE_URL: "postgres://example.invalid/atodotren", WEB_DATABASE_SSL_CA: "line1\\nline2" });
    expect(config.databaseSslCa).toBe("line1\nline2");
    expect(() => getWebServerConfig({ NODE_ENV: "production", WEB_DATA_MODE: "postgres", WEB_DATABASE_URL: "postgres://example.invalid/atodotren", WEB_DATABASE_SSL_MODE: "disable" })).toThrow(/TLS cannot be disabled/);
  });
});
