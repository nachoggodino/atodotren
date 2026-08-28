import { expect, test } from "@playwright/test";

test("live line detail switches between schematic and daily matrix and exposes accessible detail", async ({ page }) => {
  await page.goto("/es/live/line/c1?scenario=reverse-branch");

  await expect(page.getByTestId("live-active-trains")).toBeVisible();
  const modes = page.getByRole("radiogroup", { name: "Vista de línea" });
  await expect(modes.getByRole("radio")).toHaveCount(2);
  await expect(modes.getByRole("radio", { name: "Esquema" })).toBeChecked();

  const schematic = page.getByTestId("schematic-map");
  await expect(schematic).toBeVisible();
  expect(await schematic.getByRole("button").count()).toBeGreaterThan(0);

  const train = schematic.getByRole("button").first();
  if (test.info().project.name === "mobile-chromium") await train.tap();
  else await train.click();
  const trainDetail = page.getByTestId("train-detail").filter({ visible: true });
  await expect(trainDetail).toBeVisible();
  await expect(trainDetail).toContainText("Hacia");
  await expect(trainDetail).toContainText(/Próxima parada|Detenido en/);
  await expect(trainDetail).toContainText("Retraso");
  await expect(trainDetail).toContainText("Última actualización de posición");
  await page.getByRole("heading", { level: 1, name: "Directo" }).click();
  await expect(trainDetail).toBeHidden();

  await modes.getByRole("radio", { name: "Matriz diaria" }).click();
  const matrix = page.getByTestId("live-daily-matrix");
  await expect(matrix).toBeVisible();
  await expect(matrix).toHaveAttribute("role", "grid");
  expect(await matrix.getByRole("gridcell").count()).toBeGreaterThan(0);
  await expect(schematic).toBeHidden();

  const directions = page.getByTestId("live-matrix-directions");
  await expect(directions.getByRole("radio")).toHaveCount(2);
  expect(await matrix.getByTestId("live-matrix-station-label").count()).toBeGreaterThan(0);

  const matrixCell = matrix.getByRole("button").first();
  await matrixCell.click();
  const matrixDetail = page.getByTestId("live-matrix-detail");
  await expect(matrixDetail).toBeVisible();
  await expect(matrixDetail).toContainText("Estado");
  await expect(matrixDetail).toContainText("Hora prevista");
  await expect(matrixDetail).toContainText("Retraso");
  await page.getByRole("heading", { level: 1, name: "Directo" }).click();
  await expect(matrixDetail).toBeHidden();

  await directions.getByRole("radio").last().click();
  await expect(directions.getByRole("radio").last()).toBeChecked();
  await expect(matrix.getByRole("button").first()).toBeVisible();
});
