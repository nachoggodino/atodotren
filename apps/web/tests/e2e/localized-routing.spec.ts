import { expect, test } from "@playwright/test";

async function switchToEnglish(page: import("@playwright/test").Page) {
  await page.getByTestId("menu-toggle").click();
  await page.getByRole("link", { name: "ENG", exact: true }).click();
}

test("localized station slugs and document language follow the selected locale", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Locale routing is application behavior, not browser-engine behavior.");
  await page.goto("/es/live/station/aeropuerto-t4");
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await switchToEnglish(page);
  await expect(page).toHaveURL(/\/en\/live\/station\/airport-t4$/);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");

  await page.goto("/es/history/station/aeropuerto-t4?from=2026-08-18&to=2026-08-24");
  await switchToEnglish(page);
  await expect(page).toHaveURL(/\/en\/history\/station\/airport-t4\?from=2026-08-18&to=2026-08-24$/);
});
