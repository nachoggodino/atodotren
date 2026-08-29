import { expect, test } from "@playwright/test";

test("historical filters are URL-addressable and matrix detail is keyboard operable", async ({ page }) => {
  await page.goto("/es/explore/line/c1?from=2026-08-18&to=2026-08-24");
  await expect(page.getByRole("heading", { level: 1, name: "Explorar" })).toBeVisible();
  await expect(page.getByTestId("explore-context-title")).toContainText("C1");
  await page.getByLabel("Hora").selectOption("8");
  await page.getByLabel("Dirección").selectOption("1");
  await page.getByRole("button", { name: "Aplicar" }).click();
  await expect(page).toHaveURL(/hour=8/);
  await expect(page).toHaveURL(/direction=1/);

  const matrix = page.getByTestId("timetable-matrix");
  await expect(matrix).toBeVisible();
  await expect(matrix).toHaveAttribute("role", "grid");
  await expect(matrix.getByRole("gridcell").first()).toBeAttached();
  const cell = matrix.getByRole("button").first();
  await cell.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("matrix-detail")).toBeVisible();
});

test("explore context selector keeps quick links and default search navigation inside Explore", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Context selection behavior needs one Chromium acceptance path.");
  await page.goto("/es/explore?from=2026-08-18&to=2026-08-24");
  await page.getByTestId("explore-context-title").click();
  const selector = page.getByTestId("explore-context-selector");
  await expect(selector.getByRole("link", { name: "Línea C1", exact: true })).toHaveAttribute("href", "/es/explore/line/c1");

  const search = selector.getByRole("combobox", { name: "Busca una línea o estación", exact: true });
  await search.fill("Atocha");
  const station = page.getByRole("option").filter({ hasText: "Atocha" }).first();
  await expect(station).toBeVisible();
  await station.click();
  await expect(page).toHaveURL(/\/es\/explore\/station\/atocha$/);
});

test("matrix failure stays isolated from the historical page", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Failure isolation does not need duplicate Chromium viewport coverage.");
  await page.goto("/en/explore/line/c1?from=2026-08-24&to=2026-08-24&scenario=matrix-error");
  await expect(page.getByRole("heading", { level: 1, name: "Explore" })).toBeVisible();
  await expect(page.getByTestId("explore-context-title")).toContainText("C1");
  await expect(page.getByText("The detailed matrix could not be loaded safely. Try again later.")).toBeVisible();
  await expect(page.getByText("Temporal evolution")).toBeVisible();
});

test("@webkit large matrix keeps a bounded DOM while remaining scrollable and interactive", async ({ page }, testInfo) => {
  const started = Date.now();
  await page.goto("/es/explore/line/c1?from=2026-08-24&to=2026-08-24&scenario=large-matrix");
  const matrix = page.getByTestId("timetable-matrix");
  await expect(matrix).toBeVisible();
  await expect(matrix.getByTestId("matrix-virtual-column").first()).toBeVisible();

  const initialColumns = await matrix.getByTestId("matrix-virtual-column").allTextContents();
  const initialButtonCount = await matrix.getByRole("button").count();
  expect(initialColumns.length).toBeGreaterThan(0);
  expect(initialColumns.length).toBeLessThan(30);
  expect(initialButtonCount).toBeGreaterThan(0);
  expect(initialButtonCount).toBeLessThan(1000);

  const scroll = await matrix.evaluate((element) => {
    element.scrollTop = Math.min(600, element.scrollHeight);
    element.scrollLeft = Math.min(1600, element.scrollWidth);
    return { top: element.scrollTop, left: element.scrollLeft, height: element.scrollHeight, width: element.scrollWidth };
  });
  expect(scroll.top).toBeGreaterThan(0);
  expect(scroll.left).toBeGreaterThan(0);
  await expect.poll(async () => (await matrix.getByTestId("matrix-virtual-column").allTextContents()).join("|")).not.toBe(initialColumns.join("|"));

  const visibleCell = matrix.getByRole("button").first();
  await visibleCell.focus();
  await visibleCell.press("Enter");
  await expect(page.getByTestId("matrix-detail")).toBeVisible();

  await testInfo.attach("large-matrix-profile.json", {
    body: Buffer.from(JSON.stringify({ project: testInfo.project.name, renderedMs: Date.now() - started, initialColumns: initialColumns.length, initialButtonCount, ...scroll }, null, 2)),
    contentType: "application/json",
  });
});
