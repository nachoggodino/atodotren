import { expect, test } from "@playwright/test";

test("live network uses the compact status hierarchy and two-column line grid", async ({ page }) => {
  await page.goto("/es/live");

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("En directo");
  await expect(page.getByTestId("live-context-title")).toHaveText("Todas las líneas");
  await expect(page.getByText("Estado de hoy", { exact: true })).toHaveCount(0);
  await expect(page.getByText("2026-08-24", { exact: true })).toBeVisible();

  const meta = page.getByTestId("live-data-meta");
  await expect(meta).toBeVisible();
  await expect(meta).not.toContainText("Procesando");
  await expect(meta.locator('[data-tone="good"]')).toHaveCount(3);
  await expect(meta.locator('[data-tone="warning"]')).toHaveCount(1);

  const refresh = page.getByTestId("live-refresh-progress");
  await expect(refresh).toBeVisible();
  await expect(refresh.locator("svg")).toHaveCount(1);
  await expect(refresh.locator(".refresh-progress")).toHaveCount(1);
  await expect(refresh.locator(".sr-only")).toHaveCount(1);

  const stats = page.getByTestId("live-stats-grid");
  await expect(stats.locator(":scope > div")).toHaveCount(4);
  await expect(stats).toHaveClass(/grid-cols-2/);

  const lines = page.getByTestId("live-line-grid");
  await expect(lines.locator(":scope > a")).toHaveCount(8);
  await expect(lines).toHaveClass(/grid-cols-2/);
  const firstLine = lines.locator(":scope > a").first();
  await expect(firstLine).toContainText("trenes activos");
  await expect(firstLine).toContainText("Puntualidad");
  await expect(firstLine).toContainText("Media");
  await expect(firstLine).toContainText("Cobertura");
});

test("live context title follows line and station selection", async ({ page }) => {
  await page.goto("/es/live/line/c1");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("En directo");
  await expect(page.getByTestId("live-context-title")).toHaveText("Línea C1");

  await page.goto("/es/live/station/atocha");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("En directo");
  await expect(page.getByTestId("live-context-title")).toHaveText("Atocha");
});

test("live metadata coverage status follows the red-orange-green thresholds", async ({ page }) => {
  await page.goto("/es/live?scenario=partial");
  await expect(page.getByTestId("live-data-meta").locator('[data-tone="warning"]').filter({ hasText: "Cobertura" })).toHaveCount(1);

  await page.goto("/es/live?scenario=outage");
  await expect(page.getByTestId("live-data-meta").locator('[data-tone="bad"]').filter({ hasText: "Cobertura" })).toHaveCount(1);
});
