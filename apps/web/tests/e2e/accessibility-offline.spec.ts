import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

for (const path of ["/es", "/en/live", "/es/history/line/c1?from=2026-08-18&to=2026-08-24", "/en/methodology"]) {
  test(`axe smoke ${path}`, async ({ page }) => {
    await page.goto(path);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations, results.violations.map((violation) => `${violation.id}: ${violation.help}`).join("\n")).toEqual([]);
  });
}

test("a cached live page remains explicit when the browser goes offline", async ({ page, context }) => {
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

test("uncached historical detail receives the explicit no-cache offline page", async ({ page, context }) => {
  await page.goto("/es");
  await page.waitForFunction(() => navigator.serviceWorker?.controller !== null);
  await context.setOffline(true);
  await page.goto("/es/history/station/atocha?from=2026-08-01&to=2026-08-02", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "No hay una copia guardada de esta vista." })).toBeVisible();
  await context.setOffline(false);
});
