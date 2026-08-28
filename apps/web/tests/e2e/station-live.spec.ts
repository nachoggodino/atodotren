import { expect, test } from "@playwright/test";

test("station live exposes clickable upcoming trains and current-day insights", async ({ page }) => {
  await page.goto("/es/live/station/atocha");

  const train = page.getByTestId("station-train-row").first();
  await expect(train).toBeVisible();
  await train.focus();
  await page.keyboard.press("Enter");
  const detail = page.getByTestId("station-train-detail").filter({ visible: true });
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("Hacia");
  await expect(detail).toContainText("Llegada programada");
  await expect(detail).toContainText("Llegada prevista");

  await expect(page.getByRole("heading", { name: "Evolución del retraso hoy" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Distribución del retraso" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Puntualidad por línea" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Cadencia y regularidad" })).toBeVisible();
  await expect(page.getByTestId("station-regularity")).toBeVisible();
});
