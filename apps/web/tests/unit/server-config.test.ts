import { describe, expect, it } from "vitest";
import { getWebServerConfig } from "@/lib/server/config";

describe("web data mode safety", () => {
  it("rejects fixture mode in production without an explicit private-preview override", () => {
    expect(() => getWebServerConfig({ NODE_ENV: "production", WEB_DATA_MODE: "fixture" })).toThrow(/Fixture data mode is forbidden/);
  });

  it("accepts the explicit fixture production override", () => {
    expect(getWebServerConfig({ NODE_ENV: "production", WEB_DATA_MODE: "fixture", WEB_ALLOW_FIXTURE_PRODUCTION: "true" }).mode).toBe("fixture");
  });

  it("requires WEB_DATABASE_URL for postgres mode", () => {
    expect(() => getWebServerConfig({ NODE_ENV: "production", WEB_DATA_MODE: "postgres" })).toThrow(/WEB_DATABASE_URL/);
  });
});
