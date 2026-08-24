import { expect, test } from "@playwright/test";

async function openMenu(page: import("@playwright/test").Page) {
  const button = page.getByRole("button", { name: /Abrir menú|Open menu/ });
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
}

test("landing search accepts C-1 and routes to the selected line", async ({ page }, testInfo) => {
  await page.goto("/es");
  await page.getByLabel("Busca una línea o estación").fill("C-1");
  const option = page.getByRole("option").filter({ hasText: "C1" }).first();
  await expect(option).toBeVisible();
  await option.click();
  await page.getByRole("link", { name: "Ver hoy" }).click();
  await expect(page).toHaveURL(/\/es\/live\/line\/c1/);
  await expect(page.getByTestId("schematic-map")).toBeVisible();
  if (testInfo.project.name.startsWith("desktop")) await page.screenshot({ path: "test-results/screenshots/live-line-desktop-light.png", fullPage: true });
});

test("global refresh pause persists and live train detail is keyboard operable", async ({ page }) => {
  await page.goto("/es/live/line/c1");
  await openMenu(page);
  const refresh = page.getByRole("button", { name: /Activa|Pausada/ });
  await expect(refresh).toHaveAttribute("aria-pressed", "true");
  await refresh.click();
  await expect(refresh).toHaveAttribute("aria-pressed", "false");
  await page.reload();
  await openMenu(page);
  await expect(page.getByRole("button", { name: /Activa|Pausada/ })).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Escape");
  const train = page.locator('[data-testid="schematic-map"] [role="button"]').first();
  await train.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("train-detail")).toBeVisible();
  await expect(page.getByText(/no es GPS/i)).toBeVisible();
});

test("English routes, theme persistence, mobile drawer and reduced motion remain usable", async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/en");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Delays should not disappear");
  await openMenu(page);
  await page.getByRole("button", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  if (testInfo.project.name.startsWith("mobile")) await page.screenshot({ path: "test-results/screenshots/landing-mobile-dark.png", fullPage: true });
});
