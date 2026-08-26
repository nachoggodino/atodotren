import { expect, test } from "@playwright/test";

async function openMenu(page: import("@playwright/test").Page) {
  const button = page.getByTestId("menu-toggle");
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(button).toHaveAccessibleName(/Cerrar menú|Close menu/);
}

async function landingTrailingOverflow(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const footer = document.querySelector("footer");
    const footerBottom = footer === null ? 0 : footer.getBoundingClientRect().bottom + window.scrollY;
    return document.documentElement.scrollHeight - Math.max(footerBottom, window.innerHeight);
  });
}

test("landing search exposes direct live and history actions", async ({ page }, testInfo) => {
  await page.goto("/es");
  const metrics = page.getByTestId("landing-live-metrics");
  await expect(metrics).toBeVisible();
  await expect(metrics.locator(":scope > div > div").nth(1)).toContainText("Trenes activos");
  const activeTrainsValue = page.getByTestId("landing-active-trains-value");
  expect(await activeTrainsValue.evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(29);
  await expect(page.getByTestId("landing-live-link")).toHaveClass(/active:scale/);
  await expect(page.getByTestId("landing-history-link")).toHaveClass(/active:scale/);
  await expect(page.getByTestId("landing-delay-trend")).toBeVisible();
  const chartVisual = page.getByTestId("landing-delay-chart-visual");
  await expect(chartVisual).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator('[data-testid="landing-delay-trend"] .recharts-surface')).not.toHaveAttribute("tabindex");
  await chartVisual.click({ position: { x: 160, y: 80 } });
  expect(await chartVisual.evaluate((element) => element.contains(document.activeElement))).toBe(false);
  await expect(page.locator('[data-testid="landing-delay-trend"] .recharts-wrapper')).toHaveCSS("outline-style", "none");
  expect(await landingTrailingOverflow(page)).toBeLessThan(96);
  await expect(page.getByTestId("landing-title-highlight")).toHaveText("Ni pronto.");
  const search = page.getByRole("combobox", { name: "Busca una línea o estación", exact: true });
  await search.focus();
  await expect(search).toHaveCSS("outline-style", "none");
  await expect(search).toHaveCSS("border-top-width", "0px");
  await search.fill("C-1");
  const option = page.getByRole("option").filter({ hasText: "C1" }).first();
  await expect(option).toBeVisible();
  await expect(option).not.toContainText("Línea");
  const liveAction = page.getByRole("link", { name: /^Ver hoy:/ }).first();
  const historyAction = page.getByRole("link", { name: /^Ver histórico:/ }).first();
  await expect(liveAction).toHaveAttribute("href", /\/es\/live\/line\/c1$/);
  await expect(historyAction).toHaveAttribute("href", /\/es\/history\/line\/c1$/);
  await liveAction.click();
  await expect(page).toHaveURL(/\/es\/live\/line\/c1/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.getByTestId("schematic-map")).toBeVisible();
  const filename = testInfo.project.name.startsWith("desktop")
    ? "test-results/screenshots/live-line-desktop-light.png"
    : "test-results/screenshots/live-line-mobile-light.png";
  await page.screenshot({ path: filename, fullPage: true });
});

test("live navigation always opens the destination at the top", async ({ page }) => {
  await page.goto("/es");
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.getByTestId("landing-live-link").click();
  await expect(page).toHaveURL(/\/es\/live$/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.getByTestId("live-line-grid").locator(":scope > a").first().click();
  await expect(page).toHaveURL(/\/es\/live\/line\/c1$/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test("@webkit search keyboard selection opens the live result and header menu restores focus", async ({ page }) => {
  await page.goto("/es");
  const search = page.getByRole("combobox", { name: "Busca una línea o estación", exact: true });
  await search.fill("C-1");
  const option = page.getByRole("option").filter({ hasText: "C1" }).first();
  await expect(option).toBeVisible();
  await expect(search).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('[role="option"][data-active-item]').filter({ hasText: "C1" }).first()).toBeVisible();
  await search.press("Enter");
  await expect(page).toHaveURL(/\/es\/live\/line\/c1/);

  await openMenu(page);
  const toggle = page.getByTestId("menu-toggle");
  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();
});

test.describe("search network failure", () => {
  test.use({ serviceWorkers: "block" });

  test("search distinguishes API failure from empty results", async ({ page }) => {
    await page.route("**/api/v1/catalog/search?*", async (route) => {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "temporarily-unavailable" } }) });
    });
    await page.goto("/en");
    await page.getByRole("combobox", { name: "Search a line or station", exact: true }).fill("Atocha");
    await expect(page.getByText("Search is temporarily unavailable. Try again.")).toBeVisible();
    await expect(page.getByText("No matching line or station.")).toHaveCount(0);
  });
});

test("global refresh pause persists and live train detail is keyboard operable", async ({ page }) => {
  await page.goto("/es/live/line/c1");
  await openMenu(page);
  const refresh = page.getByRole("switch", { name: "Actualización automática" });
  await expect(refresh).toHaveAttribute("aria-checked", "true");
  await refresh.click();
  await expect(refresh).toHaveAttribute("aria-checked", "false");
  await page.reload();
  await openMenu(page);
  await expect(page.getByRole("switch", { name: "Actualización automática" })).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  const train = page.locator('[data-testid="schematic-map"] [role="button"]').first();
  await train.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("train-detail")).toBeVisible();
  await expect(page.getByText(/no es GPS/i)).toBeVisible();
});

test("@webkit theme and schematic keyboard interaction", async ({ page }) => {
  await page.goto("/en/live/line/c1");
  await openMenu(page);
  await page.getByRole("button", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.keyboard.press("Escape");
  const train = page.locator('[data-testid="schematic-map"] [role="button"]').first();
  await train.focus();
  await train.press("Enter");
  await expect(page.getByTestId("train-detail")).toBeVisible();
});

test("English routes, theme persistence, mobile drawer and reduced motion remain usable", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/en");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Renfe is never late");
  await expect(page.getByTestId("landing-title-highlight")).toHaveText("Nor is it early.");
  await openMenu(page);
  await page.getByRole("button", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  const filename = testInfo.project.name.startsWith("desktop")
    ? "test-results/screenshots/landing-desktop-dark.png"
    : "test-results/screenshots/landing-mobile-dark.png";
  await page.screenshot({ path: filename, fullPage: true });
});
