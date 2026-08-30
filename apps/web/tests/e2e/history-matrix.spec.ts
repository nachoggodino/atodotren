import { expect, test, type Page } from "@playwright/test";

async function delayNextExploreNavigation(page: Page) {
  await page.route(/\/es\/explore.*[?&]_rsc=/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue();
  }, { times: 1 });
}

async function expectExploreNavigation(page: Page, url: RegExp) {
  await expect(page.getByTestId("explore-navigation-skeleton")).toBeVisible();
  await expect(page).toHaveURL(url);
  await expect(page.getByTestId("explore-navigation-skeleton")).toHaveCount(0);
}

test("Explore filters are URL-addressable and matrix detail is keyboard operable", async ({ page }) => {
  await page.goto("/es/explore/line/c1?from=2026-08-18&to=2026-08-24");
  await expect(page.getByRole("heading", { level: 1, name: "Explorar" })).toBeVisible();
  await expect(page.getByTestId("explore-context-title")).toContainText("C1");
  await expect(page.getByTestId("explore-data-meta")).toContainText("Procesando");
  await expect(page.getByText("Los datos seleccionados todavía se están procesando.")).toHaveCount(0);
  await expect(page.getByText("No se pudo verificar la finalización de todos los días de servicio seleccionados.")).toHaveCount(0);

  const dateButton = page.getByTestId("explore-date-filter");
  await expect(dateButton).toContainText("18/08/2026");
  await expect(dateButton).toContainText("24/08/2026");
  await dateButton.click();

  const datePopover = page.getByTestId("explore-date-popover");
  const dateFrom = datePopover.getByLabel("Desde");
  await dateFrom.fill("2026-08-19");
  await expect(page).toHaveURL(/from=2026-08-18/);
  await delayNextExploreNavigation(page);
  await datePopover.getByTestId("explore-date-apply").click();
  await expectExploreNavigation(page, /from=2026-08-19/);

  const secondaryFilter = page.getByTestId("explore-secondary-filter");
  await expect(secondaryFilter).toBeVisible();
  await secondaryFilter.click();

  const filterPopover = page.getByTestId("explore-filter-popover");
  await expect(filterPopover).toBeVisible();
  const allDays = filterPopover.getByRole("button", { name: "Todos", exact: true });
  const monday = filterPopover.getByRole("button", { name: "Lun", exact: true });
  await expect(allDays).toHaveAttribute("aria-pressed", "true");
  await monday.click();
  await expect(filterPopover).toBeVisible();
  await expect(allDays).toHaveAttribute("aria-pressed", "false");
  await expect(monday).toHaveAttribute("aria-pressed", "true");
  await expect(page).not.toHaveURL(/weekdays=/);
  await filterPopover.getByLabel("Desde").selectOption("6");
  await filterPopover.getByLabel("Hasta").selectOption("9");
  await delayNextExploreNavigation(page);
  await filterPopover.getByTestId("explore-filter-apply").click();
  await expectExploreNavigation(page, /weekdays=1/);
  await expect(page).toHaveURL(/hourFrom=6/);
  await expect(page).toHaveURL(/hourTo=9/);
  await expect(page).not.toHaveURL(/(?:\?|&)hour=/);
  await expect(page).not.toHaveURL(/direction=/);
  await expect(page.getByTestId("explore-secondary-filter")).toContainText("Lun");
  await expect(page.getByTestId("explore-secondary-filter")).toContainText("06h–09h59");

  const matrix = page.getByTestId("timetable-matrix");
  await expect(matrix).toBeVisible();
  await expect(matrix).toHaveAttribute("role", "grid");
  await expect(matrix.getByRole("gridcell").first()).toBeAttached();
  const cell = matrix.getByRole("button").first();
  await cell.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("matrix-detail")).toBeVisible();
});

test("date presets apply immediately with an immediate loading skeleton", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Preset navigation behavior only needs one Chromium acceptance path.");
  await page.goto("/es/explore?from=2026-08-18&to=2026-08-24");
  await page.getByTestId("explore-date-filter").click();
  const popover = page.getByTestId("explore-date-popover");
  await delayNextExploreNavigation(page);
  await popover.getByRole("button", { name: "Últimos 7 días", exact: true }).click();
  await expect(page.getByTestId("explore-navigation-skeleton")).toBeVisible();
  await expect.poll(() => {
    const url = new URL(page.url());
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    if (from === null || to === null) return Number.NaN;
    return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
  }).toBe(6);
  await expect(page.getByTestId("explore-navigation-skeleton")).toHaveCount(0);
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
