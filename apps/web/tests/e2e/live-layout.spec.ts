import { expect, test } from "@playwright/test";

test("live network exposes the status summary, metrics and line navigation", async ({ page }) => {
  await page.goto("/es/live");

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Directo");
  await expect(page.getByTestId("live-context-title")).toHaveText("Todas las líneas");
  await expect(page.getByTestId("live-data-meta")).toBeVisible();
  await expect(page.getByTestId("live-refresh-progress")).toBeVisible();

  const stats = page.getByTestId("live-stats-grid").getByRole("button");
  await expect(stats).toHaveCount(4);
  for (const label of ["Puntualidad", "Cobertura", "Media", "Mediana"]) {
    await expect(page.getByTestId("live-stats-grid").getByRole("button", { name: new RegExp(`^${label}(?:\\s|$)`) })).toBeVisible();
  }

  const punctuality = page.getByTestId("live-stats-grid").getByRole("button").first();
  await punctuality.click();
  await expect(page.getByText("Una parada se considera puntual cuando su retraso es de 2 minutos o menos respecto a la hora prevista.")).toBeVisible();

  const lineLinks = page.getByTestId("live-line-grid").locator(":scope > a");
  expect(await lineLinks.count()).toBeGreaterThan(0);
  await lineLinks.first().click();
  await expect(page).toHaveURL(/\/es\/live\/line\/c1$/);
});

test("live line and station details expose context and working back navigation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Detail navigation semantics only need one Chromium viewport.");
  await page.goto("/es/live");
  await page.getByTestId("live-line-grid").locator(':scope > a[href$="/live/line/c1"]').click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Directo");
  await expect(page.getByTestId("live-context-title")).toHaveText("Línea C1");
  const lineBack = page.getByRole("button", { name: "Volver" });
  await expect(lineBack).toBeVisible();
  await lineBack.click();
  await expect(page).toHaveURL(/\/es\/live$/);

  await page.goto("/es/live/station/atocha");
  await expect(page.getByTestId("live-context-title")).toHaveText("Atocha");
  await expect(page.getByRole("button", { name: "Volver" })).toBeVisible();
});
