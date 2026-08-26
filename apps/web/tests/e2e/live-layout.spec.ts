import { expect, test } from "@playwright/test";

test("live network uses the compact status hierarchy and interactive two-column cards", async ({ page }) => {
  await page.goto("/es/live");

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("En directo");
  await expect(page.getByTestId("live-context-title")).toHaveText("Todas las líneas");
  await expect(page.getByRole("button", { name: "Volver" })).toHaveCount(0);
  await expect(page.getByTestId("live-title-icon")).toBeVisible();
  await expect(page.getByTestId("live-title-icon")).toHaveClass(/landing-positive/);
  await expect(page.getByText("Estado de hoy", { exact: true })).toHaveCount(0);
  await expect(page.getByText("2026-08-24", { exact: true })).toHaveCount(0);

  const meta = page.getByTestId("live-data-meta");
  await expect(meta).toBeVisible();
  await expect(meta).not.toContainText("Procesando");
  await expect(meta.locator('[data-tone="good"]')).toHaveCount(3);
  await expect(meta.locator('[data-tone="warning"]')).toHaveCount(1);

  const refresh = page.getByTestId("live-refresh-progress");
  await expect(refresh).toBeVisible();
  await expect(refresh.locator("svg")).toHaveCount(1);
  await expect(refresh.locator("svg")).toHaveClass(/size-3\.5/);
  await expect(refresh.locator(".refresh-progress")).toHaveCount(1);
  await expect(refresh.locator(".sr-only")).toHaveCount(1);

  const stats = page.getByTestId("live-stats-grid");
  const statButtons = stats.getByRole("button");
  await expect(statButtons).toHaveCount(4);
  await expect(statButtons.nth(0)).toContainText("Puntualidad");
  await expect(statButtons.nth(1)).toContainText("Cobertura");
  await expect(statButtons.nth(2)).toContainText("Media");
  await expect(statButtons.nth(3)).toContainText("Mediana aprox.");
  await statButtons.nth(0).click();
  const punctualityHelp = page.getByText("Una parada se considera puntual cuando su retraso es de 2 minutos o menos respecto a la hora prevista.");
  await expect(punctualityHelp).toBeVisible();
  await page.getByRole("heading", { level: 1, name: "En directo" }).click();
  await expect(punctualityHelp).toBeHidden();

  const lines = page.getByTestId("live-line-grid");
  await expect(lines.locator(":scope > a")).toHaveCount(8);
  await expect(lines).toHaveClass(/grid-cols-2/);
  const firstLine = lines.locator(":scope > a").first();
  const firstLineHeader = firstLine.getByTestId("live-line-header");
  await expect(firstLineHeader).toHaveClass(/justify-between/);
  await expect(firstLineHeader).toContainText("•");
  await expect(firstLineHeader).toContainText("trenes activos");
  await expect(firstLineHeader.locator("svg")).toHaveCount(1);
  await expect(firstLineHeader.locator("svg")).toHaveClass(/size-4/);
  await expect(firstLineHeader.locator("svg")).toHaveClass(/translate-x-1\.5/);
  await expect(firstLine.getByTestId("live-line-metric")).toHaveCount(4);
  await expect(firstLine).not.toContainText(" min ");
  await expect(firstLine).not.toContainText("Puntualidad");
  await expect(firstLine).not.toContainText("Cobertura");
  await expect(firstLine).not.toContainText("Media");
  await expect(firstLine).not.toContainText("Mediana aprox.");

  await expect(page.getByRole("heading", { level: 2, name: "Distribución del retraso" })).toBeVisible();
  await expect(page.getByText("La distribución usa únicamente observaciones con retraso utilizable; cobertura y ausencias se muestran por separado.")).toHaveCount(0);
  await expect(page.locator(".sr-only table").filter({ hasText: "Distribución de retrasos" })).toContainText("Paradas");
});

test("live detail headers expose a prominent working back button", async ({ page }) => {
  await page.goto("/es/live");
  await page.goto("/es/live/line/c1");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("En directo");
  await expect(page.getByTestId("live-context-title")).toHaveText("Línea C1");
  await expect(page.getByTestId("live-title-icon")).toHaveCount(0);
  const lineBack = page.getByRole("button", { name: "Volver" });
  await expect(lineBack).toBeVisible();
  await expect(lineBack).toHaveClass(/size-11/);
  await expect(lineBack).toHaveClass(/active:-translate-x-1/);
  await expect(lineBack.locator("svg")).toHaveClass(/size-7/);
  await lineBack.click();
  await expect(page).toHaveURL(/\/es\/live$/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

  await page.goto("/es/live/station/atocha");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("En directo");
  await expect(page.getByTestId("live-context-title")).toHaveText("Atocha");
  await expect(page.getByRole("button", { name: "Volver" })).toBeVisible();
});

test("live metadata coverage status follows the red-orange-green thresholds", async ({ page }) => {
  await page.goto("/es/live?scenario=partial");
  await expect(page.getByTestId("live-data-meta").locator('[data-tone="warning"]').filter({ hasText: "Cobertura" })).toHaveCount(1);

  await page.goto("/es/live?scenario=outage");
  await expect(page.getByTestId("live-data-meta").locator('[data-tone="bad"]').filter({ hasText: "Cobertura" })).toHaveCount(1);
});
