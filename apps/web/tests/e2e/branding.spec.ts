import { expect, test } from "@playwright/test";

const LIGHT = {
  background: "#F6E4E2",
  surface: "#FFFFFF",
  foreground: "#3A1B22",
  primary: "#7A3B4A",
};

const DARK = {
  background: "#221016",
  surface: "#2E161C",
  foreground: "#F6E4E2",
  primary: "#C98A98",
};

async function palette(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      background: style.getPropertyValue("--background").trim(),
      surface: style.getPropertyValue("--surface").trim(),
      foreground: style.getPropertyValue("--foreground").trim(),
      primary: style.getPropertyValue("--primary").trim(),
      accent: style.getPropertyValue("--accent").trim(),
      success: style.getPropertyValue("--success").trim(),
      warning: style.getPropertyValue("--warning").trim(),
      focus: style.getPropertyValue("--focus").trim(),
    };
  });
}

function normalizeColor(value: string): string {
  const normalized = value.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(normalized);
  return short === null ? normalized : `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
}

function expectPalette(actual: Awaited<ReturnType<typeof palette>>, expected: typeof LIGHT) {
  for (const key of ["background", "surface", "foreground", "primary"] as const) {
    expect(normalizeColor(actual[key])).toBe(normalizeColor(expected[key]));
  }
  for (const key of ["accent", "success", "warning", "focus"] as const) {
    expect(normalizeColor(actual[key])).toBe(normalizeColor(expected.primary));
  }
}

test("andén infinito brand and palette follow the selected theme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/en");
  const headerBrand = page.getByLabel("Home").getByTestId("brand-symbol");
  await expect(page.getByText("andén infinito", { exact: true })).toBeVisible();
  await expect(headerBrand).toHaveCSS("color", "rgb(122, 59, 74)");
  expectPalette(await palette(page), LIGHT);

  const manifestResponse = await page.request.get("/manifest.webmanifest");
  expect(manifestResponse.ok()).toBe(true);
  const manifest = await manifestResponse.json();
  expect(manifest.name).toBe("andén infinito");
  expect(manifest.short_name).toBe("andén infinito");
  expect(manifest.background_color).toBe(LIGHT.background);
  expect(manifest.theme_color).toBe(LIGHT.background);
  expect(manifest.icons).toEqual(expect.arrayContaining([
    expect.objectContaining({ src: "/icon.svg", purpose: "any" }),
    expect.objectContaining({ src: "/maskable.svg", purpose: "maskable" }),
  ]));
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", /favicon\.svg/);

  await page.getByTestId("menu-toggle").click();
  await page.getByRole("button", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  expectPalette(await palette(page), DARK);
  await expect(headerBrand).toHaveCSS("color", "rgb(201, 138, 152)");
});

test("document language follows the locale route", async ({ page }) => {
  await page.goto("/es");
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
  await page.goto("/en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});
