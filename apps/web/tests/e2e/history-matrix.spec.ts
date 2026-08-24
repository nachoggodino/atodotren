import { expect, test } from "@playwright/test";

test("historical filters are URL-addressable and the matrix exposes keyboard detail", async ({ page }, testInfo) => {
  await page.goto("/es/history/line/c1?from=2026-08-18&to=2026-08-24");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("C1");
  await page.getByLabel("Hora").selectOption("8");
  await page.getByLabel("Dirección").selectOption("1");
  await page.getByRole("button", { name: "Aplicar" }).click();
  await expect(page).toHaveURL(/hour=8/);
  await expect(page).toHaveURL(/direction=1/);
  const matrix = page.getByTestId("timetable-matrix");
  await expect(matrix).toBeVisible();
  const cell = matrix.getByRole("button").first();
  await cell.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("matrix-detail")).toBeVisible();
  await expect(page.getByText(/✓ ≤2m/)).toBeVisible();
  if (testInfo.project.name.startsWith("desktop")) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: "test-results/screenshots/history-matrix-desktop.png", fullPage: true });
  }
});

test("current-day cancellation and missing-evidence fixtures remain distinct", async ({ page }) => {
  await page.goto("/en/history/line/c1?from=2026-08-24&to=2026-08-24&scenario=cancellations");
  await expect(page.getByText(/× canceled/)).toBeVisible();
  await expect(page.locator('[data-state="canceled"]').first()).toBeVisible();
  await page.goto("/en/history/line/c1?from=2026-08-24&to=2026-08-24&scenario=missing");
  await expect(page.getByText(/— missing evidence/)).toBeVisible();
  await expect(page.locator('[data-state="missing_evidence"]').first()).toBeVisible();
});
