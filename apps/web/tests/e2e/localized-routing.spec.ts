import { expect, test } from "@playwright/test";

async function switchToEnglish(page: import("@playwright/test").Page) {
  await page.getByTestId("menu-toggle").click();
  await page.getByRole("link", { name: "EN", exact: true }).click();
}

test("@webkit localized station slugs canonicalize when changing language", async ({ page }) => {
  await page.goto("/es/live/station/aeropuerto-t4");
  await switchToEnglish(page);
  await expect(page).toHaveURL(/\/en\/live\/station\/airport-t4$/);

  await page.goto("/es/history/station/aeropuerto-t4?from=2026-08-18&to=2026-08-24");
  await switchToEnglish(page);
  await expect(page).toHaveURL(/\/en\/history\/station\/airport-t4\?from=2026-08-18&to=2026-08-24$/);
});
