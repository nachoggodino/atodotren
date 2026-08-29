import { expect, test } from "@playwright/test";

test("station upcoming train detail opens from the keyboard", async ({ page }) => {
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
});
