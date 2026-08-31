import { expect, test } from "@playwright/test";

test("Explore trend switches metrics locally without changing the page filters", async ({ page }) => {
  await page.goto("/es/explore?from=2026-08-18&to=2026-08-24");
  const originalUrl = page.url();
  const trend = page.getByTestId("explore-trend");
  const mean = trend.getByRole("radio", { name: "Media", exact: true });
  const punctuality = trend.getByRole("radio", { name: "Puntualidad", exact: true });
  const delayedStops = trend.getByRole("radio", { name: "Paradas retrasadas", exact: true });

  await expect(mean).toHaveAttribute("aria-checked", "true");
  await punctuality.click();
  await expect(punctuality).toHaveAttribute("aria-checked", "true");
  await expect(mean).toHaveAttribute("aria-checked", "false");
  await delayedStops.click();
  await expect(delayedStops).toHaveAttribute("aria-checked", "true");
  expect(page.url()).toBe(originalUrl);
});

test("Explore heatmaps lazy-load and only refetch when their data scope changes", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "The heatmap interaction contract only needs one Chromium acceptance path.");
  let heatmapRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/v1/history/heatmap") heatmapRequests += 1;
  });

  await page.goto("/es/explore?from=2026-08-18&to=2026-08-24");
  const section = page.getByTestId("explore-heatmaps");
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByTestId("explore-heatmap-grid")).toBeVisible();
  await expect.poll(() => heatmapRequests).toBe(1);

  const customize = section.getByRole("button", { name: "Personalizar", exact: true });
  await customize.click();
  let popover = page.getByRole("heading", { name: "Personalizar heatmap", exact: true }).locator("..");
  await popover.getByRole("radio", { name: "Puntualidad", exact: true }).click();
  await popover.getByRole("radio", { name: "50", exact: true }).click();
  await popover.getByRole("button", { name: "Personalizar", exact: true }).click();
  await expect(section).toContainText("Hora × día · Puntualidad");
  await expect.poll(() => heatmapRequests).toBe(1);

  await customize.click();
  popover = page.getByRole("heading", { name: "Personalizar heatmap", exact: true }).locator("..");
  await popover.getByRole("radio", { name: "Estación × hora", exact: true }).click();
  await expect(popover.getByRole("radio", { name: "C1", exact: true })).toBeVisible();
  await popover.getByRole("radio", { name: "C1", exact: true }).click();
  await popover.getByRole("button", { name: "Personalizar", exact: true }).click();
  await expect(section.getByTestId("explore-heatmap-grid")).toBeVisible();
  await expect(section).toContainText("Estación × hora · Puntualidad");
  await expect.poll(() => heatmapRequests).toBe(2);
});
