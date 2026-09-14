import {
  expect,
  test,
  type Page,
  expectFreshMeasurements,
  MANUAL_SCAN,
  mockHealth,
  mockScan,
  uploadPhoto,
} from "./test-support";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const screenshots = path.resolve(process.cwd(), "../.acreiq-local/screenshots");
test.beforeAll(() => mkdirSync(screenshots, { recursive: true }));
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Simulation online", exact: true }),
  ).toBeVisible();
  await expect(page.locator("canvas")).toBeVisible();
});

async function runSample(page: Page) {
  const response = page.waitForResponse((r) =>
    r.url().endsWith("/api/optimize"),
  );
  await page.getByRole("button", { name: "Simulate this sample", exact: true }).first().click();
  const api = await response;
  expect(api.status()).toBe(200);
  const result = await api.json();
  expect(result.status).toBe("optimized");
  expect(result.configurations_evaluated).toBe(result.candidates.length);
  expect(result.optimized.period_energy_kwh).toBeLessThan(
    result.baseline.period_energy_kwh,
  );
  await expect(
    page.getByRole("button", { name: "Proposed state" }),
  ).toBeEnabled();
  return result;
}

test("spatial workspace renders, moves, responds to camera and asset selection", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(
    page.getByRole("heading", { name: "Grow space 01" }),
  ).toBeVisible();
  await page.waitForTimeout(1200);
  const canvas = page.locator("canvas");
  const before = await canvas.screenshot();
  expect(before.length).toBeGreaterThan(8000);
  const pixels = await sharp(before).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let bright = 0;
  let foliage = 0;
  for (let i = 0; i < pixels.data.length; i += pixels.info.channels) {
    const [r, g, b] = pixels.data.subarray(i, i + 3);
    if (r + g + b > 180) bright++;
    if (g > r * 1.12 && g > b * 1.12 && g > 50) foliage++;
  }
  const area = pixels.info.width * pixels.info.height;
  expect(bright / area).toBeGreaterThan(0.035);
  expect(foliage / area).toBeGreaterThan(0.005);
  await page.waitForTimeout(500);
  expect((await canvas.screenshot()).equals(before)).toBe(false);
  await page.getByRole("button", { name: "Pause rotation" }).click();
  await page.getByRole("button", { name: "Top view", exact: true }).click();
  await page.waitForTimeout(150);
  expect((await canvas.screenshot()).equals(before)).toBe(false);
  await page.getByRole("button", { name: "Light coverage layer" }).click();
  await expect(
    page.getByRole("button", { name: "Light coverage layer" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Reset camera" }).click();
  await page
    .getByRole("button", { name: "Inventory", exact: false })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Growing racks Sample inventory", exact: true })
    .click();
  await expect(page.locator(".asset-callout")).toContainText("Growing racks");
  await page.getByRole("button", { name: "Clear asset selection" }).click();
  await page.getByRole("button", { name: "Inputs", exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth + 1,
  );
  expect(overflow).toBe(false);
  await page.screenshot({
    path: path.join(screenshots, `workspace-${info.project.name}.png`),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("real engine drives proposed state, ledger, export, impact and history", async ({
  page,
}, info) => {
  const result = await runSample(page);
  const dli = page.locator(".metric").filter({ hasText: "Daily light integral" });
  await expect(dli.locator(".metric-number span")).toHaveText("mol/m\u00b2/day");
  await expect(dli.locator(".metric-caption")).toHaveText("Daily total");
  await expect(dli.locator(".metric-number")).toContainText(
    result.optimized.dli_mol_m2_day.toLocaleString("en-US", { maximumFractionDigits: 1 }),
  );
  await expect(page.locator(".scene-schedule")).toContainText(
    `${result.optimized.photoperiod_hours} h`,
  );
  await page
    .getByRole("button", { name: "Current state", exact: true })
    .click();
  await expect(page.locator(".scene-schedule")).toContainText("16 h");
  await expect(dli.locator(".metric-caption")).toHaveText("Daily total");
  await expect(dli.locator(".metric-number")).toContainText(
    result.baseline.dli_mol_m2_day.toLocaleString("en-US", { maximumFractionDigits: 1 }),
  );
  await page
    .getByRole("button", { name: "Proposed state", exact: true })
    .click();
  await page.getByRole("button", { name: "Scenarios", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Scenario explorer" }),
  ).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(
    result.feasible_configurations,
  );
  await page.getByRole("button", { name: "All tested" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(
    result.configurations_evaluated,
  );
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "JSON", exact: true }).click();
  const json = await download;
  expect(json.suggestedFilename()).toBe("acreiq-scenario.json");
  const jsonPath = path.join(screenshots, `sample-scenario-${info.project.name}.json`);
  await json.saveAs(jsonPath);
  const report = JSON.parse(readFileSync(jsonPath, "utf8"));
  expect(report.scenario.source).toBe("sample");
  expect(report.scenario.confirmed).toBe(true);
  expect(report.result.source).toBe("sample");
  expect(report.result).toEqual(result);
  expect(typeof report.result.optimized.period_energy_kwh).toBe("number");
  expect(report.result.savings).toMatchObject({
    water_liters: null,
    yield_gain_lb: null,
    avoided_capex_usd: null,
  });
  const csvDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV", exact: true }).click();
  const csv = await csvDownload;
  expect(csv.suggestedFilename()).toBe("acreiq-scenario.csv");
  const contents = readFileSync((await csv.path())!, "utf8");
  expect(contents.split("\r\n")[0]).toBe("section,run_id,candidate_id,field,value,unit,note");
  expect(contents).toContain(result.run!.id);
  expect(contents).toContain(`"baseline","${result.run!.id}","h16-d1","period_energy_kwh",${result.baseline.period_energy_kwh},"kWh"`);
  expect(contents).toContain(`"selected","${result.run!.id}","h12-d1","period_energy_kwh",${result.optimized.period_energy_kwh},"kWh"`);
  await page.screenshot({
    path: path.join(screenshots, `scenarios-${info.project.name}.png`),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Impact", exact: true }).click();
  await expect(page.locator(".impact-lead h2")).toContainText(
    "less electricity",
  );
  const slider = page.getByRole("slider", { name: "Equivalent sites" });
  await slider.fill("10");
  await expect(page.locator(".scale-control strong")).toHaveText("10");
  await page.screenshot({
    path: path.join(screenshots, `impact-${info.project.name}.png`),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: "Scenarios", exact: true }).click();
  await expect(page.locator(".history-row")).toHaveCount(1);
  await page.locator(".history-row").click();
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Proposed state" }),
  ).toBeEnabled();
});

test("changed measurements invalidate results and infeasible constraints are explained", async ({
  page,
}) => {
  await runSample(page);
  await page
    .getByRole("spinbutton", { name: "Minimum DLI", exact: true })
    .fill("90");
  await page
    .getByRole("spinbutton", { name: "Minimum DLI", exact: true })
    .blur();
  await expect(
    page.getByRole("button", { name: "Proposed state" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("checkbox", { name: "I reviewed the inventory and entered inputs." }),
  ).toHaveCount(0);
  await expect(page.locator(".source-badge")).toHaveText("Sample space");
  const response = page.waitForResponse((r) =>
    r.url().endsWith("/api/optimize"),
  );
  await page
    .getByRole("button", { name: "Simulate this sample", exact: true })
    .first()
    .click();
  expect((await (await response).json()).status).toBe(
    "no_feasible_configuration",
  );
  await expect(page.locator(".error-banner")).toContainText("No tested setting");
  await expect(
    page.getByRole("button", { name: "Proposed state" }),
  ).toBeDisabled();
  await page
    .getByRole("spinbutton", { name: "Full-output PPFD" })
    .fill("");
  await page
    .getByRole("spinbutton", { name: "Full-output PPFD" })
    .blur();
  await page
    .getByRole("button", { name: "Simulate this sample", exact: true })
    .first()
    .click();
  await expect(page.locator(".error-banner")).toContainText("Enter canopy PPFD");
});

test("photo upload uses explicit manual fallback and clears sample measurements", async ({
  page,
}, info) => {
  await mockHealth(page);
  await mockScan(page, MANUAL_SCAN);
  await page.getByRole("button", { name: "Simulation online", exact: true }).click();
  await expect(page.locator(".provider-status")).toHaveText("Vision not configured");
  await page.getByRole("button", { name: "Scan a space" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({
    path: path.join(screenshots, `scan-${info.project.name}.png`),
  });
  const scan = await uploadPhoto(page);
  expect(scan.status()).toBe(200);
  expect((await scan.json()).assets).toEqual([]);
  await expect(
    page.getByRole("heading", { name: "Ready for manual inventory" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Review resource model" }).click();
  await expect(
    page.getByRole("heading", { name: "No equipment yet" }),
  ).toBeVisible();
  await expectFreshMeasurements(page);
  await page
    .getByRole("button", { name: "Inventory", exact: false })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Add equipment", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "LED grow light", exact: true })
    .click();
  await expect(
    page.getByRole("spinbutton", { name: "LED grow light quantity" }),
  ).toHaveValue("1");
  await page.getByRole("button", { name: "Remove LED grow light" }).click();
  await expect(
    page.getByRole("heading", { name: "No equipment yet" }),
  ).toBeVisible();
});
