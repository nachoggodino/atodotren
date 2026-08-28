import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

for (const path of ["/es", "/en/live", "/es/history/line/c1?from=2026-08-18&to=2026-08-24", "/en/methodology"]) {
  test(`axe smoke ${path}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "One Chromium accessibility pass per representative route is sufficient.");
    await page.goto(path);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations, results.violations.map((violation) => `${violation.id}: ${violation.help}`).join("\n")).toEqual([]);
  });
}

test("live API cache keeps the network summary and only the latest detail", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Service-worker cache semantics do not need duplicate Chromium viewport coverage.");
  await page.goto("/es");
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null);
  await page.reload();
  for (const path of ["/api/v1/live/network", "/api/v1/live/lines/c1", "/api/v1/live/stations/atocha"]) {
    await page.evaluate(async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`fixture API failed: ${response.status}`);
    }, path);
  }
  const entries = await page.evaluate(async () => {
    const names = await caches.keys();
    const liveName = names.find((name) => name.startsWith("atodotren-live-"));
    if (!liveName) return [];
    const cache = await caches.open(liveName);
    return (await cache.keys()).map((request) => new URL(request.url).pathname).sort();
  });
  expect(entries).toEqual(["/api/v1/live/network", "/api/v1/live/stations/atocha"]);
});

test("a cached live page remains explicit when the browser goes offline", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Offline navigation is covered once in Chromium and separately in WebKit.");
  await page.goto("/es/live/line/c1");
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null);
  await page.reload();
  await context.setOffline(true);
  await expect(page.getByTestId("offline-status")).toBeVisible();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("offline-status")).toBeVisible();
  await expect(page.getByTestId("schematic-map")).toBeVisible();
  await context.setOffline(false);
});

test("@webkit offline bootstrap reflects connectivity without relying on cache navigation", async ({ page, context }) => {
  await page.goto("/en");
  await context.setOffline(true);
  await expect(page.getByTestId("offline-status")).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByTestId("offline-status")).toBeHidden();
});

test("uncached historical detail receives the explicit no-cache offline page", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "The fallback contract is engine-level behavior, not viewport behavior.");
  await page.goto("/es");
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null);
  await context.setOffline(true);
  await page.goto("/es/history/station/atocha?from=2026-08-01&to=2026-08-02", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "No hay una copia guardada de esta vista." })).toBeVisible();
  await context.setOffline(false);
});
