import { expect, test } from "./test-support";
import path from "node:path";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Simulation online", exact: true })).toBeVisible();
});

test("invalid uploads, simulation outage and modal keyboard handling remain usable", async ({ page }) => {
  const scanRequests: string[] = [];
  page.on("request", request => {
    if (request.url().endsWith("/api/scan")) scanRequests.push(request.url());
  });
  await page.getByRole("button", { name: "Scan a space" }).click();
  await page.locator('input[type="file"]:not([capture])').setInputFiles({ name: "invalid.txt", mimeType: "text/plain", buffer: Buffer.from("not an image") });
  await expect(page.locator(".modal-error")).toContainText("Choose a JPG, PNG or WebP image");
  expect(scanRequests).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Scan a space" })).toBeFocused();
  await page.route("**/api/optimize", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "The AcreIQ engine is unavailable. Start the backend, then try again." }) }));
  await page.getByRole("button", { name: "Simulate this sample", exact: true }).first().click();
  await expect(page.locator(".error-banner")).toContainText("engine is unavailable");
  await expect(page.getByRole("button", { name: "Proposed state" })).toBeDisabled();
  await page.unroute("**/api/optimize");
  await page.getByRole("button", { name: "Simulate this sample", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Proposed state" })).toBeEnabled();
});

test("power ceiling rejects infeasible settings without inventing savings", async ({ page }) => {
  await page.getByRole("spinbutton", { name: "Power ceiling" }).fill("500");
  await page.getByRole("spinbutton", { name: "Power ceiling" }).blur();
  await expect(page.locator(".source-badge")).toHaveText("Sample space");
  await expect(page.getByRole("checkbox", { name: "I reviewed the inventory and entered inputs." })).toHaveCount(0);
  const response = page.waitForResponse(r => r.url().endsWith("/api/optimize"));
  await page.getByRole("button", { name: "Simulate this sample", exact: true }).first().click();
  const result = await (await response).json();
  expect(result.status).toBe("no_feasible_configuration");
  expect(result.savings).toBeNull();
  expect(result.candidates.every((c: { rejected_for: string[] }) => c.rejected_for.includes("modeled_power_limit"))).toBe(true);
  await expect(page.locator(".error-banner")).toContainText("No tested setting");
});

test("workspace stays framed from narrow phones to wide desktops", async ({ page }, info) => {
  test.skip(info.project.name === "mobile", "Responsive resize check runs once on the desktop browser.");
  for (const [width, height] of [[1920, 1080], [1200, 900], [768, 1024], [320, 740]]) {
    await page.setViewportSize({ width, height });
    await expect(page.locator("canvas")).toBeVisible();
    await page.waitForTimeout(250);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const box = await page.locator("canvas").boundingBox();
    expect(box!.width).toBeGreaterThan(220);
    expect(box!.height).toBeGreaterThan(250);
    await page.screenshot({ path: path.resolve(process.cwd(), `../.acreiq-local/screenshots/responsive-${width}.png`) });
  }
});
