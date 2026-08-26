import { expect, test } from "@playwright/test";

test("live line detail switches between a compact schematic and the daily delay matrix", async ({ page }) => {
  await page.goto("/es/live/line/c1?scenario=reverse-branch");

  await expect(page.getByTestId("live-active-trains")).toHaveText("5 trenes activos");
  const modes = page.getByRole("radiogroup", { name: "Vista de línea" });
  await expect(modes.getByRole("radio")).toHaveCount(2);
  await expect(modes.getByRole("radio", { name: "Esquema" })).toHaveAttribute("aria-checked", "true");

  const schematic = page.getByTestId("schematic-map");
  await expect(schematic).toBeVisible();
  const schematicImage = schematic.getByRole("img", { name: "Esquema" });
  await expect(schematicImage).toContainText("Hacia");
  await expect(schematicImage).not.toContainText("→");
  expect(await schematic.getByRole("button").count()).toBeGreaterThan(0);

  const reportedTrain = schematic.getByRole("button").first();
  await reportedTrain.click();
  const trainDetail = page.getByTestId("train-detail");
  await expect(trainDetail).toBeVisible();
  await expect(trainDetail).toContainText("Última actualización de posición");
  await page.getByRole("heading", { level: 1, name: "En directo" }).click();
  await expect(trainDetail).toBeHidden();

  const unavailableTrain = schematic.getByRole("button", { name: /Posición exacta no disponible/ });
  await expect(unavailableTrain).toBeVisible();
  await unavailableTrain.click();
  await expect(trainDetail).toContainText("Última actualización de posición");
  await page.getByRole("heading", { level: 1, name: "En directo" }).click();

  await modes.getByRole("radio", { name: "Matriz diaria" }).click();
  const matrix = page.getByTestId("live-daily-matrix");
  await expect(matrix).toBeVisible();
  await expect(schematic).toBeHidden();
  await expect(matrix.locator("th")).toHaveCount(0);
  await expect(matrix.getByText(/^\d{2}:\d{2}$/).first()).toBeVisible();

  const directions = page.getByTestId("live-matrix-directions");
  await expect(directions.getByRole("radio")).toHaveCount(2);
  await expect(directions.getByRole("radio").first()).toContainText("Hacia");
  await expect(directions.getByRole("radio").last()).toContainText("Hacia");

  const matrixCell = matrix.getByRole("button").first();
  await matrixCell.click();
  const matrixDetail = page.getByTestId("live-matrix-detail");
  await expect(matrixDetail).toBeVisible();
  await expect(matrixDetail).toContainText("Hora prevista");
  await expect(matrixDetail).toContainText("Retraso");
  await expect(matrixDetail).not.toContainText("Estado");
  await expect(matrixDetail).not.toContainText("Confianza");
  await page.getByRole("heading", { level: 1, name: "En directo" }).click();
  await expect(matrixDetail).toBeHidden();

  await directions.getByRole("radio").last().click();
  await expect(directions.getByRole("radio").last()).toHaveAttribute("aria-checked", "true");
  await expect(matrix.getByRole("button").first()).toBeVisible();
});
