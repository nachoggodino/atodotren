import { expect, test } from "@playwright/test";

test("station live exposes clickable upcoming trains and station-only insights", async ({ page }) => {
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
  await expect(detail).toContainText("Última parada");

  await expect(page.getByTestId("station-total-delay")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Evolución del retraso" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Distribución del retraso" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Puntualidad por línea" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Cadencia y regularidad" })).toHaveCount(0);
});
