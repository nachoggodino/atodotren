import { expect, test } from "@playwright/test";

test("live line detail switches between a compact schematic and the daily delay matrix", async ({ page }) => {
  await page.goto("/es/live/line/c1?scenario=reverse-branch");

  await expect(page.getByTestId("live-active-trains")).toHaveText("5 trenes activos");
  const modes = page.getByRole("radiogroup", { name: "Vista de línea" });
  await expect(modes.getByRole("radio")).toHaveCount(2);
  await expect(modes.locator('input[type="radio"]')).toHaveCount(2);
  await expect(modes).toHaveClass(/border-border/);
  await expect(modes.getByRole("radio", { name: "Esquema" })).toBeChecked();

  const schematic = page.getByTestId("schematic-map");
  await expect(schematic).toBeVisible();
  const schematicImage = schematic.getByRole("img", { name: "Esquema" });
  await expect(schematicImage).toContainText("Hacia");
  await expect(schematicImage).not.toContainText("→");
  expect(await schematic.getByRole("button").count()).toBeGreaterThan(0);

  const reportedTrain = schematic.getByRole("button").first();
  const trainSquircle = reportedTrain.getByTestId("train-marker-squircle");
  await expect(reportedTrain).toHaveAttribute("type", "button");
  await expect(reportedTrain).toHaveClass(/touch-manipulation/);
  await expect(trainSquircle).toHaveClass(/rounded-\[35%\]/);
  await expect(trainSquircle).toHaveClass(/bg-surface-strong/);
  await expect(trainSquircle.locator("svg")).toHaveClass(/size-3\.5/);
  if (test.info().project.name === "mobile-chromium") await reportedTrain.tap();
  else await reportedTrain.click();
  const trainDetail = page.getByTestId("train-detail").filter({ visible: true });
  await expect(trainDetail).toBeVisible();
  await expect(trainDetail).toHaveClass(/w-\[17rem\]/);
  await expect(trainDetail).toContainText("Hacia");
  await expect(trainDetail).toContainText(/PRÓXIMA PARADA|DETENIDO EN/);
  await expect(trainDetail).toContainText("RETRASO");
  await expect(trainDetail).toContainText("LLEGADA PROGRAMADA");
  await expect(trainDetail).toContainText(/LLEGADA PROBABLE|LLEGADA REAL/);
  await expect(trainDetail).toContainText("ÚLTIMA ACTUALIZACIÓN DE POSICIÓN");
  await expect(trainDetail).not.toContainText("Estado");
  await expect(trainDetail).not.toContainText("Confianza");
  await page.getByRole("heading", { level: 1, name: "En directo" }).click();
  await expect(trainDetail).toBeHidden();

  const unavailableTrain = schematic.getByRole("button", { name: /No disponible/ });
  await expect(unavailableTrain).toBeVisible();
  await unavailableTrain.click();
  const unavailableDetail = page.getByTestId("train-detail").filter({ visible: true });
  await expect(unavailableDetail).toContainText("ÚLTIMA ACTUALIZACIÓN DE POSICIÓN");
  await page.getByRole("heading", { level: 1, name: "En directo" }).click();

  await modes.getByRole("radio", { name: "Matriz diaria" }).click();
  const matrix = page.getByTestId("live-daily-matrix");
  await expect(matrix).toBeVisible();
  await expect(schematic).toBeHidden();
  await expect(matrix.locator("th")).toHaveCount(0);
  await expect(matrix.getByText(/^\d{2}:\d{2}$/).first()).toBeVisible();

  const directions = page.getByTestId("live-matrix-directions");
  await expect(directions.getByRole("radio")).toHaveCount(2);
  await expect(directions.locator('input[type="radio"]')).toHaveCount(2);
  await expect(directions.locator("label > span").first()).toHaveClass(/text-\[7px\]/);
  await expect(directions.getByRole("radio").first()).toHaveAccessibleName("Hacia Villaverde Bajo");
  await expect(directions.getByRole("radio").last()).toHaveAccessibleName("Hacia Chamartín Clara Campoamor");

  const stationLabels = matrix.getByTestId("live-matrix-station-label");
  await expect(stationLabels).toHaveCount(6);
  await expect(stationLabels.first()).toHaveAttribute("title", "Chamartín Clara Campoamor");
  await expect(stationLabels.first()).toHaveClass(/w-\[1\.05rem\]/);
  await expect(stationLabels.first().locator("span")).toHaveClass(/-rotate-45/);

  const matrixCell = matrix.getByRole("button").first();
  await expect(matrixCell).toHaveClass(/size-\[1\.05rem\]/);
  await matrixCell.click();
  const matrixDetail = page.getByTestId("live-matrix-detail");
  await expect(matrixDetail).toBeVisible();
  await expect(matrixCell).toHaveAttribute("data-selected", "true");
  await expect(matrixCell.getByTestId("live-matrix-selected-dot")).toBeVisible();
  await expect(matrixDetail).toContainText("Hora prevista");
  await expect(matrixDetail).toContainText("Retraso");
  await expect(matrixDetail).not.toContainText("Estado");
  await expect(matrixDetail).not.toContainText("Confianza");
  await page.getByRole("heading", { level: 1, name: "En directo" }).click();
  await expect(matrixDetail).toBeHidden();
  await expect(matrixCell).toHaveAttribute("data-selected", "false");

  await directions.getByRole("radio").last().click();
  await expect(directions.getByRole("radio").last()).toBeChecked();
  await expect(matrix.getByRole("button").first()).toBeVisible();
  await expect(matrix.getByTestId("live-matrix-station-label").first()).toHaveAttribute("title", "Villaverde Bajo");
});
