import { expect, test } from "@playwright/test";

async function openMenu(page: import("@playwright/test").Page) {
  const button = page.getByTestId("menu-toggle");
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(button).toHaveAccessibleName(/Cerrar menú|Close menu/);
}

test("landing search exposes live and history actions and opens the selected live line", async ({ page }) => {
  await page.goto("/es");
  await expect(page.getByTestId("landing-live-metrics")).toBeVisible();
  await expect(page.getByTestId("landing-delay-trend")).toBeVisible();

  const search = page.getByRole("combobox", { name: "Busca una línea o estación", exact: true });
  await search.fill("C-1");
  const option = page.getByRole("option").filter({ hasText: "C1" }).first();
  await expect(option).toBeVisible();

  const liveAction = page.getByRole("link", { name: /^Ver hoy:/ }).first();
  const historyAction = page.getByRole("link", { name: /^Ver histórico:/ }).first();
  await expect(liveAction).toHaveAttribute("href", /\/es\/live\/line\/c1$/);
  await expect(historyAction).toHaveAttribute("href", /\/es\/history\/line\/c1$/);

  await liveAction.click();
  await expect(page).toHaveURL(/\/es\/live\/line\/c1/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.getByTestId("schematic-map")).toBeVisible();
});

test("live navigation opens destinations at the top", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Scroll restoration does not need duplicate Chromium viewport coverage.");
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

  test("search distinguishes API failure from empty results", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "Network failure semantics only need one Chromium viewport.");
    await page.route("**/api/v1/catalog/search?*", async (route) => {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "temporarily-unavailable" } }) });
    });
    await page.goto("/en");
    await page.getByRole("combobox", { name: "Search a line or station", exact: true }).fill("Atocha");
    await expect(page.getByText("Search is temporarily unavailable. Try again.")).toBeVisible();
    await expect(page.getByText("No matching line or station.")).toHaveCount(0);
  });
});

test("global refresh pause persists and live train detail is keyboard operable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Persistence and keyboard acceptance are covered once in Chromium.");
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

  const train = page.getByTestId("schematic-map").getByRole("button").first();
  await train.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("train-detail").filter({ visible: true })).toBeVisible();
});
