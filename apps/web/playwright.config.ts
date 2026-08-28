import { defineConfig, devices } from "@playwright/test";

const webkitOnly = /@webkit/;
const webServerCommand = process.env.PLAYWRIGHT_SKIP_BUILD === "true"
  ? "npm run start -- --hostname 127.0.0.1 --port 3100"
  : "npm run build && npm run start -- --hostname 127.0.0.1 --port 3100";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./test-results",
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never", outputFolder: "playwright-report" }]] : "list",
  use: { baseURL: "http://127.0.0.1:3100", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: {
    command: webServerCommand,
    url: "http://127.0.0.1:3100/es",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      ...process.env,
      NODE_ENV: "production",
      WEB_DATA_MODE: "fixture",
      WEB_ALLOW_FIXTURE_PRODUCTION: "true",
      WEB_ENABLE_FIXTURE_SCENARIOS: "true",
      WEB_FIXTURE_SCENARIO: "healthy",
    },
  },
  projects: [
    { name: "desktop-chromium", grepInvert: webkitOnly, use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", grepInvert: webkitOnly, use: { ...devices["Pixel 7"] } },
    { name: "webkit-acceptance", grep: webkitOnly, use: { ...devices["Desktop Safari"] } },
  ],
});
