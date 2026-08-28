import { expect, test } from "@playwright/test";

async function openMenu(page: import("@playwright/test").Page) {
  const toggle = page.getByTestId("menu-toggle");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  return toggle;
}

test("theme selection is accessible and persists across navigation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Theme persistence needs one Chromium acceptance path, not duplicate viewport coverage.");
  await page.goto("/en");
  await expect(page.getByLabel("Home").getByText("andén infinito", { exact: true })).toBeVisible();

  await openMenu(page);
  const primaryNav = page.getByRole("navigation", { name: "Primary navigation" });
  for (const label of ["Home", "Live", "Historical", "Methodology"]) {
    await expect(primaryNav.getByRole("link", { name: label })).toBeVisible();
  }

  const language = page.getByRole("group", { name: "Language" });
  await expect(language.getByRole("link", { name: "ENG" })).toHaveAttribute("aria-current", "true");

  const theme = page.getByRole("group", { name: "Theme" });
  await page.getByRole("button", { name: "Dark" }).click();
  await expect(theme.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");

  await page.getByTestId("menu-toggle").click();
  await page.reload();
  await openMenu(page);
  await expect(page.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
});

test("mobile navigation expands in place without becoming a modal", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile-chromium", "This is the mobile acceptance path.");
  await page.goto("/es");
  const menuToggle = page.getByTestId("menu-toggle");
  await menuToggle.click();
  await expect(menuToggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("navigation", { name: "Navegación principal" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("browser back does not restore a previously open navigation drawer", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "History-state behavior only needs one Chromium viewport.");
  await page.goto("/es/live/line/c1");
  const menuToggle = await openMenu(page);
  await page.getByRole("navigation", { name: "Navegación principal" }).getByRole("link", { name: "Inicio" }).click();
  await expect(page).toHaveURL(/\/es$/);
  await expect(menuToggle).toHaveAttribute("aria-expanded", "false");

  await page.goBack();
  await expect(page).toHaveURL(/\/es\/live\/line\/c1$/);
  await expect(menuToggle).toHaveAttribute("aria-expanded", "false");
});
