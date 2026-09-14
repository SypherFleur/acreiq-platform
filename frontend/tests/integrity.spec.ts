import {
  AI_SCAN,
  enterMeasurements,
  expect,
  expectFreshMeasurements,
  measurementConfirmation,
  mockHealth,
  mockScan,
  savedWorkspace,
  test,
  uploadPhoto,
  type Page,
} from "./test-support";
import type { OptimizationResult, Scenario } from "../lib/types";

async function openWorkspace(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Simulation online", exact: true })).toBeVisible();
}

async function startManual(page: Page, entry: "workspace" | "scan" = "scan") {
  await page.getByRole("button", {
    name: entry === "workspace" ? "Workspace settings" : "Scan a space",
    exact: true,
  }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Start manually", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".source-badge")).toHaveText("Manual inputs");
}

async function scanSuggestions(page: Page) {
  await mockScan(page, AI_SCAN);
  await page.getByRole("button", { name: "Scan a space", exact: true }).click();
  const response = await uploadPhoto(page);
  expect(response.status()).toBe(200);
  expect(response.request().method()).toBe("POST");
  expect(response.request().headers()["content-type"]).toContain("multipart/form-data");
  expect(response.request().postDataBuffer()?.toString("latin1")).toContain('name="image"');
  await expect(page.getByRole("dialog").getByRole("heading", {
    name: `${AI_SCAN.assets.length} AI-suggested resource groups`,
    exact: true,
  })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Review resource model", exact: true }).click();
  await expect(page.locator(".source-badge")).toHaveText("Photo assisted");
}

async function prepareRealWorkspace(page: Page, source: "manual" | "photo-assisted") {
  await mockHealth(page, "gemini");
  await openWorkspace(page);
  if (source === "photo-assisted") {
    await scanSuggestions(page);
  } else {
    await startManual(page);
    await page.getByRole("button", { name: /^Inventory/ }).first().click();
    await page.getByRole("button", { name: "Add equipment", exact: true }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "LED grow light", exact: true }).click();
  }
  await expectFreshMeasurements(page);
  await enterMeasurements(page);
  await expect(measurementConfirmation(page)).not.toBeChecked();
  await expect.poll(async () => (await savedWorkspace(page)).scenario.source).toBe(source);
}

async function expectSimulationLabels(page: Page, source: Scenario["source"], count = 2) {
  const label = source === "sample" ? "Simulate this sample" : "Run simulation";
  const other = source === "sample" ? "Run simulation" : "Simulate this sample";
  const controls = page.getByRole("button", { name: label, exact: true });
  await expect(controls).toHaveCount(count);
  await expect(page.getByRole("button", { name: other, exact: true })).toHaveCount(0);
  for (let i = 0; i < count; i++) await expect(controls.nth(i)).toBeEnabled();
}

async function holdSimulation(page: Page) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const submissions: Scenario[] = [];
  await page.route("**/api/optimize", async (route) => {
    submissions.push(route.request().postDataJSON());
    await gate;
    const response = await route.fetch();
    await route.fulfill({ response });
  });
  return { release, submissions };
}

async function expectBusyControls(page: Page) {
  const controls = page.getByRole("button", { name: "Simulating", exact: true });
  await expect(controls).toHaveCount(2);
  await expect(controls.first()).toBeDisabled();
  await expect(controls.nth(1)).toBeDisabled();
  await expect(page.getByRole("button", { name: /^(Simulate this sample|Run simulation)$/ })).toHaveCount(0);
}

test("sample edits retain sample provenance and simulation labels across views", async ({ page }) => {
  await openWorkspace(page);
  await expectSimulationLabels(page, "sample");
  await page.getByRole("spinbutton", { name: "Length", exact: true }).fill("12");
  await page.getByRole("spinbutton", { name: "Length", exact: true }).blur();
  await page.getByRole("button", { name: /^Inventory/ }).first().click();
  await page.getByRole("textbox", { name: "LED grow lights name", exact: true }).fill("Edited sample lights");
  await page.getByRole("spinbutton", { name: "Edited sample lights quantity", exact: true }).fill("3");
  await expect(page.getByRole("button", { name: "Edited sample lights Sample inventory", exact: true })).toBeVisible();
  await expect(page.locator(".source-badge")).toHaveText("Sample space");
  await expect(page.locator(".sample-notice")).toContainText("assumed measurements");
  await expect(measurementConfirmation(page)).toHaveCount(0);
  await expect.poll(async () => (await savedWorkspace(page)).scenario).toMatchObject({
    source: "sample", length_ft: 12, light_count: 3, confirmed: false,
  });
  for (const view of ["Scenarios", "Impact", "Workspace"]) {
    await page.getByRole("button", { name: view, exact: true }).click();
    await expectSimulationLabels(page, "sample", view === "Workspace" ? 2 : 1);
  }
});

test("sample simulation labels become busy on both controls and restore after completion", async ({ page }) => {
  await openWorkspace(page);
  const simulation = await holdSimulation(page);
  const response = page.waitForResponse((r) => r.url().endsWith("/api/optimize"));
  try {
    await page.getByRole("button", { name: "Simulate this sample", exact: true }).first().click();
    await expectBusyControls(page);
    await expect.poll(() => simulation.submissions).toHaveLength(1);
    expect(simulation.submissions[0]).toMatchObject({ source: "sample", confirmed: true });
  } finally {
    simulation.release();
  }
  expect((await response).status()).toBe(200);
  await expect(page.getByRole("button", { name: "Proposed state", exact: true })).toBeEnabled();
  await expectSimulationLabels(page, "sample");
});

test("DLI stays a daily total when the operating horizon changes and canopy coverage is explicit", async ({ page }) => {
  await openWorkspace(page);
  const dli = page.locator(".metric").filter({ hasText: "Daily light integral" });
  const originalDli = (await dli.locator(".metric-number").textContent())!;
  await expect(dli.locator(".metric-number span")).toHaveText("mol/m\u00b2/day");
  await expect(dli.locator(".metric-caption")).toHaveText("Daily total");
  const coverage = page.locator(".insight-fact").filter({ hasText: "Current canopy coverage" });
  await expect(coverage).toContainText("50%");
  await expect(coverage).toContainText("of floor footprint");
  await expect(page.getByText("Available canopy", { exact: true })).toHaveCount(0);
  await page.locator("details.advanced summary").click();
  await page.getByRole("spinbutton", { name: "Operating period", exact: true }).fill("47");
  await page.getByRole("spinbutton", { name: "Operating period", exact: true }).blur();
  await expect(dli.locator(".metric-number")).toHaveText(originalDli);
  await expect(dli.locator(".metric-caption")).toHaveText("Daily total");
  await expect(dli).not.toContainText("47-day");
  await expect(dli).not.toContainText("365-day");
  await expect(page.locator(".metric").filter({ hasText: "Electricity" }).locator(".metric-caption")).toContainText("47-day");
});

for (const provider of ["gemini", "vertex"] as const) {
  test(`${provider} configuration is separate from simulation availability and live verification`, async ({ page }) => {
    let scans = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/api/scan")) scans++;
    });
    await mockHealth(page, provider);
    await openWorkspace(page);
    await expect(page.locator(".provider-status")).toHaveText("Vision configured");
    await expect(page.locator(".provider-status")).toHaveAttribute("title", /no photo request has been verified/i);
    await page.getByRole("button", { name: "Scan a space", exact: true }).click();
    await expect(page.getByRole("dialog").locator(".vision-state")).toContainText("Vision configured");
    await expect(page.getByRole("dialog").locator(".vision-state")).toContainText("no photo request has been verified");
    await expect(page.getByRole("dialog").locator(".vision-state")).toContainText(provider === "vertex" ? "Vertex AI" : "Gemini");
    await page.getByRole("dialog").getByRole("button", { name: "Close dialog", exact: true }).click();
    await mockHealth(page, provider, false);
    await page.getByRole("button", { name: "Simulation online", exact: true }).click();
    await expect(page.locator(".provider-status")).toHaveText("Vision unavailable");
    await expect(page.getByRole("button", { name: "Simulation online", exact: true })).toBeVisible();
    await mockHealth(page, provider);
    await page.getByRole("button", { name: "Simulation online", exact: true }).click();
    await expect(page.locator(".provider-status")).toHaveText("Vision configured");
    expect(scans).toBe(0);
    await scanSuggestions(page);
    await expect(page.locator(".provider-status")).toHaveText("Vision verified this session");
    expect(scans).toBe(1);
    await page.reload();
    await expect(page.getByRole("button", { name: "Simulation online", exact: true })).toBeVisible();
    await expect(page.locator(".provider-status")).toHaveText("Vision configured");
    expect(scans).toBe(1);
  });
}

test("simulation offline makes provider state unknown and refresh restores an unconfigured engine", async ({ page }) => {
  await mockHealth(page);
  await openWorkspace(page);
  await expect(page.locator(".provider-status")).toHaveText("Vision not configured");
  await page.route("**/api/health", (route) => route.fulfill({ status: 503, json: { detail: "Test backend offline" } }));
  await page.getByRole("button", { name: "Simulation online", exact: true }).click();
  await expect(page.getByRole("button", { name: "Simulation offline", exact: true })).toBeVisible();
  await expect(page.locator(".provider-status")).toContainText(/unknown/i);
  await expect(page.locator(".provider-status")).not.toContainText(/configured|verified/i);
  await page.getByRole("button", { name: "Scan a space", exact: true }).click();
  await expect(page.getByRole("dialog").locator(".vision-state")).toContainText(/unknown/i);
  await page.getByRole("dialog").getByRole("button", { name: "Close dialog", exact: true }).click();
  await mockHealth(page);
  await page.getByRole("button", { name: "Simulation offline", exact: true }).click();
  await expect(page.getByRole("button", { name: "Simulation online", exact: true })).toBeVisible();
  await expect(page.locator(".provider-status")).toHaveText("Vision not configured");
  await expectSimulationLabels(page, "sample");
});

test("mock AI suggestions are editable, unconfirmed, and inherit no sample measurements", async ({ page }) => {
  await mockHealth(page, "gemini");
  await openWorkspace(page);
  await scanSuggestions(page);
  await expect(page.locator(".inventory-item")).toHaveCount(AI_SCAN.assets.length);
  await expect(measurementConfirmation(page)).not.toBeChecked();
  for (const asset of AI_SCAN.assets) {
    const row = page.locator(".inventory-item").filter({
      has: page.getByRole("spinbutton", { name: `${asset.name} quantity`, exact: true }),
    });
    await expect(row.getByRole("button", { name: `${asset.name} AI suggestion \u00b7 review required`, exact: true })).toBeVisible();
    if (asset.confidence === null) {
      await expect(row.locator(".inventory-confidence")).toHaveCount(0);
    } else {
      await expect(row.locator(".inventory-confidence")).toHaveText(`${Math.round(asset.confidence * 100)}% model confidence`);
    }
    await expect(row.getByRole("textbox", { name: `${asset.name} name`, exact: true })).toBeEditable();
  }
  await expect.poll(() => savedWorkspace(page)).toMatchObject({
    scenario: { source: "photo-assisted", confirmed: false, light_count: 3 },
    assets: AI_SCAN.assets,
  });
  await page.getByRole("textbox", { name: "LED grow light name", exact: true }).fill("Reviewed light bank");
  await page.getByRole("spinbutton", { name: "Reviewed light bank quantity", exact: true }).fill("4");
  await page.getByRole("button", { name: "Remove Circulation fan", exact: true }).click();
  await expect(page.locator(".inventory-item")).toHaveCount(1);
  await expect.poll(() => savedWorkspace(page)).toMatchObject({
    scenario: { source: "photo-assisted", light_count: 4, confirmed: false },
    assets: [{ ...AI_SCAN.assets[0], name: "Reviewed light bank", quantity: 4, confirmed: false }],
  });
  await expectFreshMeasurements(page);
  await expectSimulationLabels(page, "photo-assisted");
  await measurementConfirmation(page).check();
  await page.getByRole("button", { name: /^Inventory/ }).first().click();
  await expect(page.getByRole("button", { name: "Reviewed light bank AI suggestion \u00b7 user confirmed", exact: true })).toBeVisible();
  await page.getByRole("spinbutton", { name: "Reviewed light bank quantity", exact: true }).fill("5");
  await expect(measurementConfirmation(page)).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Reviewed light bank AI suggestion \u00b7 review required", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /View source image/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Start manually", exact: true }).click();
  await expectFreshMeasurements(page);
  await expect.poll(() => savedWorkspace(page)).toMatchObject({
    scenario: { source: "manual", light_count: 0, confirmed: false }, assets: [],
  });
  await page.getByRole("button", { name: /^Inventory/ }).first().click();
  await expect(page.getByRole("heading", { name: "No equipment yet", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /View source image/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Scan a space", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("img", { name: "Your growing environment", exact: true })).toHaveCount(0);
  await expect(page.getByRole("dialog").locator(".scan-results")).toHaveCount(0);
});

test("starting manually from workspace settings clears a completed sample and its measured values", async ({ page }) => {
  await openWorkspace(page);
  const response = page.waitForResponse((r) => r.url().endsWith("/api/optimize"));
  await page.getByRole("button", { name: "Simulate this sample", exact: true }).first().click();
  expect((await response).status()).toBe(200);
  await expect(page.getByRole("button", { name: "Proposed state", exact: true })).toBeEnabled();
  await startManual(page, "workspace");
  await expectFreshMeasurements(page);
  await expectSimulationLabels(page, "manual");
  await expect.poll(() => savedWorkspace(page)).toMatchObject({
    scenario: { source: "manual", light_count: 0, confirmed: false, operating_days: 0 }, assets: [],
  });
  await expect(page.getByRole("button", { name: "Current state", exact: true })).toHaveClass(/selected/);
  await page.getByRole("button", { name: "Scenarios", exact: true }).click();
  await expect(page.locator("tbody tr")).toHaveCount(0);
});

for (const source of ["manual", "photo-assisted"] as const) {
  test(`${source} measurements require confirmation, show busy labels, and stay cleared after a completed run`, async ({ page }) => {
    await prepareRealWorkspace(page, source);
    const simulation = await holdSimulation(page);
    try {
      const controls = page.getByRole("button", { name: "Run simulation", exact: true });
      await expectSimulationLabels(page, source);
      for (let i = 0; i < 2; i++) {
        await controls.nth(i).click();
        await expect(page.locator(".error-banner")).toContainText("Review the inventory and entered inputs before simulating. Review does not verify measurement accuracy.");
        expect(simulation.submissions).toHaveLength(0);
      }
      await measurementConfirmation(page).check();
      const response = page.waitForResponse((r) => r.url().endsWith("/api/optimize"));
      await controls.first().click();
      await expectBusyControls(page);
      await expect.poll(() => simulation.submissions).toHaveLength(1);
      expect(simulation.submissions[0]).toMatchObject({
        source, confirmed: true, length_ft: 12, lighting_watts: 420, ppfd_full: 400, operating_days: 47,
      });
      simulation.release();
      const api = await response;
      expect(api.status()).toBe(200);
      const result: OptimizationResult = await api.json();
      expect(result.source).toBe(source);
      expect(result.status).toBe("optimized");
      await expect(page.getByRole("button", { name: "Proposed state", exact: true })).toBeEnabled();
      await expectSimulationLabels(page, source);

      const length = page.getByRole("spinbutton", { name: "Length", exact: true });
      await length.fill("");
      await length.blur();
      await expect(length).toHaveValue("0");
      await expect(measurementConfirmation(page)).not.toBeChecked();
      await expect(page.getByRole("button", { name: "Proposed state", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Current state", exact: true })).toHaveClass(/selected/);
      await expect.poll(async () => (await savedWorkspace(page)).scenario).toMatchObject({ source, length_ft: 0, confirmed: false });
      await page.getByRole("button", { name: "Run simulation", exact: true }).first().click();
      await expect(page.locator(".error-banner")).toContainText("Review the inventory and entered inputs");
      expect(simulation.submissions).toHaveLength(1);
      await page.reload();
      await expect(page.getByRole("spinbutton", { name: "Length", exact: true })).toHaveValue("0");
      await expect(measurementConfirmation(page)).not.toBeChecked();
      await expect(page.getByRole("button", { name: "Proposed state", exact: true })).toBeDisabled();
      await expect.poll(async () => (await savedWorkspace(page)).scenario.source).toBe(source);
    } finally {
      simulation.release();
    }
  });
}

test("provider errors stay explicit and manual fallback clears the failed photo without loading a sample", async ({ page }) => {
  await mockHealth(page, "gemini");
  await openWorkspace(page);
  const failure = "Gemini is temporarily unavailable or its quota is exhausted. Retry later or enter inventory manually.";
  await page.route("**/api/scan", (route) => route.fulfill({ status: 503, json: { detail: failure } }));
  await page.getByRole("button", { name: "Scan a space", exact: true }).click();
  expect((await uploadPhoto(page)).status()).toBe(503);
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".modal-error")).toHaveText(failure);
  await expect(dialog.locator(".scan-results")).toHaveCount(0);
  await expect(dialog.locator(".vision-state")).toContainText("Vision scan failed");
  await expect(page.locator(".provider-status")).toHaveText("Vision scan failed");
  await expect(page.getByRole("button", { name: "Simulation online", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Choose another photo", exact: true })).toBeEnabled();
  await expect.poll(() => savedWorkspace(page)).toMatchObject({
    scenario: { source: "photo-assisted", length_ft: 0, lighting_watts: 0, ppfd_full: null, operating_days: 0, confirmed: false },
    assets: [],
  });
  await dialog.getByRole("button", { name: "Start manually", exact: true }).click();
  await expectFreshMeasurements(page);
  await expect(page.locator(".source-badge")).toHaveText("Manual inputs");
  await expectSimulationLabels(page, "manual");
  await expect(page.locator(".error-banner")).toHaveCount(0);
  await page.getByRole("button", { name: "Run simulation", exact: true }).first().click();
  await expect(page.locator(".error-banner")).toContainText("Review the inventory and entered inputs");
  await scanSuggestions(page);
  await expect(page.locator(".provider-status")).toHaveText("Vision verified this session");
});
