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

test("@webkit history filters and matrix basics", async ({ page }) => {
  await page.goto("/en/history/line/c1?from=2026-08-18&to=2026-08-24");
  await page.getByLabel("Hour").selectOption("9");
  await page.getByLabel("Direction").selectOption("0");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/hour=9/);
  await expect(page).toHaveURL(/direction=0/);
  const matrix = page.getByTestId("timetable-matrix");
  await expect(matrix).toBeVisible();
  const cell = matrix.getByRole("button").first();
  await cell.focus();
  await cell.press("Enter");
  await expect(page.getByTestId("matrix-detail")).toBeVisible();
});

test("current-day cancellation and missing-evidence fixtures remain distinct", async ({ page }) => {
  await page.goto("/en/history/line/c1?from=2026-08-24&to=2026-08-24&scenario=cancellations");
  await expect(page.getByText(/× canceled/)).toBeVisible();
  await expect(page.locator('[data-state="canceled"]').first()).toBeVisible();
  await page.goto("/en/history/line/c1?from=2026-08-24&to=2026-08-24&scenario=missing");
  await expect(page.getByText(/— missing evidence/)).toBeVisible();
  await expect(page.locator('[data-state="missing_evidence"]').first()).toBeVisible();
});

test("@webkit large matrix stays complete, responsive, scrollable and sticky", async ({ page }, testInfo) => {
  const started = Date.now();
  await page.goto("/es/history/line/c1?from=2026-08-24&to=2026-08-24&scenario=large-matrix");
  const matrix = page.getByTestId("timetable-matrix");
  await expect(matrix).toBeVisible();
  const renderedMs = Date.now() - started;
  await expect(matrix.getByRole("button")).toHaveCount(2880);
  expect(await matrix.locator("thead").evaluate((element) => getComputedStyle(element).position)).toBe("sticky");
  expect(await matrix.locator("tbody th").first().evaluate((element) => getComputedStyle(element).position)).toBe("sticky");
  const scroll = await matrix.evaluate((element) => {
    element.scrollTop = Math.min(600, element.scrollHeight);
    element.scrollLeft = Math.min(900, element.scrollWidth);
    return { top: element.scrollTop, left: element.scrollLeft, height: element.scrollHeight, width: element.scrollWidth };
  });
  expect(scroll.top).toBeGreaterThan(0);
  expect(scroll.left).toBeGreaterThan(0);

  const interactionStarted = Date.now();
  const visibleCell = matrix.getByRole("button").nth(1000);
  await visibleCell.evaluate((element) => element.scrollIntoView({ block: "center", inline: "center" }));
  await visibleCell.click();
  await expect(page.getByTestId("matrix-detail")).toBeVisible();
  const interactionMs = Date.now() - interactionStarted;

  expect(renderedMs).toBeLessThan(30_000);
  expect(interactionMs).toBeLessThan(5_000);
  await testInfo.attach("large-matrix-profile.json", {
    body: Buffer.from(JSON.stringify({ project: testInfo.project.name, renderedMs, interactionMs, ...scroll }, null, 2)),
    contentType: "application/json",
  });
});
