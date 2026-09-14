import { readFileSync } from "node:fs";
import { expect, test, type Page } from "./test-support";
import type { SiteComparisonArtifact } from "../lib/site-types";

const key = "acreiq.site-comparisons.v2";
const site = (page: Page) => page.getByRole("region", { name: "Site scenario comparison", exact: true });
const result = (page: Page) => page.getByRole("region", { name: "Site comparison results", exact: true });
const row = (page: Page, id: string) => result(page).locator(`tr[data-scenario-id="${id}"]`);
const store = (page: Page) => page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key);
async function load(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Compare site plans", exact: true }).click();
  await site(page).getByRole("button", { name: "Load A/B/C synthetic fixture", exact: true }).click();
  await expect(site(page).getByRole("checkbox", { name: "Site plan review", exact: true })).toBeVisible();
}
async function compare(page: Page) {
  await site(page).getByRole("checkbox", { name: "Site plan review", exact: true }).check();
  const pending = page.waitForResponse(response => response.url().endsWith("/api/site-comparisons") && response.request().method() === "POST");
  await site(page).getByRole("button", { name: "Compare reviewed plans", exact: true }).click();
  const response = await pending; expect(response.status()).toBe(200);
  const artifact = await response.json() as SiteComparisonArtifact;
  await expect(result(page)).toHaveAttribute("data-comparison-id", artifact.payload.id);
  await expect(site(page).getByRole("alert")).toHaveCount(0);
  return artifact;
}
async function edit(page: Page, id = "fixture-C") {
  await site(page).getByRole("button", { name: "Edit operating plans", exact: true }).click();
  const labels = { "fixture-A": "A - Current operation", "fixture-B": "B - Shorter schedule", "fixture-C": "C - Longer schedule" };
  await site(page).getByRole("tab", { name: new RegExp(labels[id as keyof typeof labels]) }).click();
}
async function field(page: Page, label: string, value: string) {
  const input = site(page).getByRole("spinbutton", { name: label, exact: true });
  await input.fill(value); await input.blur();
}
async function goal(page: Page, metric: string) {
  const pending = page.waitForResponse(response => response.url().endsWith("/api/site-comparisons"));
  await site(page).getByRole("combobox", { name: "Comparison goal", exact: true }).selectOption(metric);
  const response = await pending; expect(response.status()).toBe(200);
  const artifact = await response.json() as SiteComparisonArtifact;
  await expect(result(page)).toHaveAttribute("data-comparison-id", artifact.payload.id);
  return artifact;
}
async function exportJson(page: Page) {
  const pending = page.waitForEvent("download");
  await site(page).getByRole("button", { name: "Comparison JSON", exact: true }).click();
  return JSON.parse(readFileSync((await (await pending).path())!, "utf8")) as SiteComparisonArtifact;
}

test("A/B/C exact arithmetic, goal reuse, evidence exports and read-only history survive reload", async ({ page }, info) => {
  await load(page);
  const lightingBefore = await page.evaluate(() => JSON.parse(localStorage.getItem("acreiq.workspace.v1")!).scenario);
  await expect(site(page).getByRole("button", { name: "Compare reviewed plans", exact: true })).toBeDisabled();
  const first = await compare(page);
  expect(first.payload.preferred_scenario_ids).toEqual(["fixture-C"]);
  const values = first.payload.evaluations.map(e => [e.requested_setting.hours, e.metrics.energy_kwh.value, e.metrics.output_kg.value, e.metrics.recurring_cash_usd.value, e.metrics.horizon_cash_usd.value]);
  expect(values).toEqual([[16, 656.32, 48, 510.944, 510.944], [12, 521.92, 40, 483.952, 493.952], [18, 723.52, 60, 570.496, 600.496]]);
  await expect(row(page, "fixture-B")).toContainText("Constraint-fail");
  await expect(row(page, "fixture-C")).toContainText("Preferred");
  await expect(row(page, "fixture-C")).toContainText("600.5");
  expect(await exportJson(page)).toEqual(first);
  const zipPromise = page.waitForEvent("download");
  await site(page).getByRole("button", { name: "CSV evidence bundle", exact: true }).click();
  const zip = readFileSync((await (await zipPromise).path())!);
  expect(zip.readUInt32LE(0)).toBe(0x04034b50);
  expect(zip.toString()).toContain(first.sha256);
  expect(zip.toString()).toContain("candidates.csv");
  await site(page).getByRole("button", { name: "Mark important comparison", exact: true }).click();
  const energy = await goal(page, "energy_kwh");
  expect(energy.payload.preferred_scenario_ids).toEqual(["fixture-A"]);
  expect(energy.payload.reused_evaluations).toBe(true);
  expect(energy.payload.evaluations.map(e => e.id)).toEqual(first.payload.evaluations.map(e => e.id));
  const cashPerKg = await goal(page, "horizon_cash_per_kg");
  expect(cashPerKg.payload.preferred_scenario_ids).toEqual(["fixture-C"]);
  const working = (await store(page)).working;
  await site(page).locator(`[data-site-comparison-id="${first.payload.id}"] .history-row`).click();
  await site(page).getByRole("button", { name: "Inspect C - Longer schedule", exact: true }).click();
  await page.reload();
  await expect(result(page)).toHaveAttribute("data-comparison-id", first.payload.id);
  await expect(site(page).getByRole("region", { name: "Why this site result?" })).toHaveAttribute("data-evaluation-id", first.payload.evaluations[2].id);
  expect((await store(page)).working).toEqual(working);
  expect((await store(page)).history).toHaveLength(3);
  expect(await exportJson(page)).toEqual(first);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("acreiq.workspace.v1")!).scenario)).toEqual(lightingBefore);
  await site(page).getByRole("button", { name: "Check local server copy", exact: true }).click();
  await expect(site(page).locator(".site-verification")).toContainText("available");
  await expect(site(page).locator(".site-verification")).toContainText("content consistency");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await result(page).locator(".site-comparison-table td").evaluateAll(cells => cells.every(cell => cell.scrollHeight <= cell.clientHeight + 1))).toBe(true);
  await page.screenshot({ path: info.outputPath("site-historical-comparison.png"), fullPage: true });
});

test("changed schedule invalidates benchmark without inventing output; revised assumption is explicit", async ({ page }) => {
  await load(page); const original = await compare(page); await edit(page);
  await field(page, "Lighting schedule", "17");
  await expect(site(page).getByRole("checkbox", { name: "Site plan review" })).not.toBeChecked();
  await expect(site(page).locator(".site-warning").first()).toContainText("Inputs changed");
  const changed = await compare(page);
  const c = changed.payload.evaluations[2];
  expect(c.metrics.energy_kwh.value).toBe(689.92);
  expect(c.metrics.output_kg.value).toBeNull();
  expect(c.applicability.status).toBe("fail");
  expect(changed.payload.preferred_scenario_ids).toEqual(["fixture-A"]);
  expect(original.payload.evaluations[2].metrics.output_kg.value).toBe(60);
  await edit(page);
  await site(page).getByText("Conditional output benchmark", { exact: false }).first().click();
  await site(page).getByRole("button", { name: "Create revised benchmark assumption", exact: true }).click();
  await field(page, "Assumed marketable output per cycle", "25");
  const note = site(page).getByRole("textbox", { name: "Assumption source and applicability note", exact: true });
  await note.fill("Synthetic sensitivity only: explicitly assume 25 kg for this 17-hour recipe."); await note.blur();
  await site(page).getByRole("checkbox", { name: "This is my explicit conditional assumption, not a measured or predicted yield.", exact: true }).check();
  await site(page).getByRole("button", { name: "Save benchmark assumption", exact: true }).click();
  const revised = await compare(page);
  expect(revised.payload.evaluations[2].metrics.output_kg.value).toBe(50);
  expect(revised.payload.evaluations[2].snapshot.scenario.benchmark?.version).toBe(2);
  expect(revised.payload.evaluations[2].provenance).toBe("synthetic_fixture");
});

test("missing costs remain known subtotals and all-infeasible power has no preferred scenario", async ({ page }) => {
  await load(page); await compare(page); await edit(page);
  await site(page).getByText("Scoped cash costs", { exact: false }).first().click();
  await site(page).getByRole("combobox", { name: "Maintenance status", exact: true }).selectOption("unknown");
  const missing = await compare(page); const c = missing.payload.evaluations[2];
  expect(c.metrics.horizon_cash_usd.value).toBeNull();
  expect(c.metrics.horizon_cash_usd.known_subtotal).toBe(592.496);
  expect(c.metrics.output_kg.value).toBe(60);
  await expect(row(page, "fixture-C")).toContainText("known subtotal");
  expect(missing.payload.comparison_incomplete).toBe(true);
  await edit(page);
  await site(page).getByText("Resource limits", { exact: false }).first().click();
  await field(page, "peak watts maximum", "800");
  const infeasible = await compare(page);
  expect(infeasible.payload.preferred_scenario_ids).toEqual([]);
  expect(infeasible.payload.evaluations.every(e => e.feasibility === "fail")).toBe(true);
  expect(infeasible.payload.evaluations.every(e => e.metrics.peak_watts.value === 875)).toBe(true);
  await expect(site(page).getByRole("region", { name: "Comparison explanation", exact: true })).toContainText("No eligible scenario");
});

test("missing PPFD keeps available energy but withholds production and an old benchmark cannot cover 55 days", async ({ page }) => {
  await load(page); await compare(page); await edit(page);
  await field(page, "Plan PPFD", "");
  const missing = await compare(page);
  expect(missing.payload.evaluations[2].metrics.output_kg.value).toBeNull();
  expect(missing.payload.evaluations[2].metrics.energy_kwh.value).toBe(723.52);
  expect(missing.payload.evaluations[2].module_result?.status).toBe("needs_measurement");
  await edit(page);
  await site(page).getByText("Operation and common conditions", { exact: false }).first().click();
  await field(page, "Operating horizon", "55");
  const horizon = await compare(page);
  expect(horizon.payload.compatibility.status).toBe("not_comparable");
  expect(horizon.payload.preferred_scenario_ids).toEqual([]);
  expect(horizon.payload.evaluations.every(e => e.metrics.output_kg.value === null)).toBe(true);
});

test("JSON import is read-only; tampering and verification failure retain local evidence", async ({ page }) => {
  await load(page); const original = await compare(page);
  const before = (await store(page)).working;
  await site(page).getByLabel("Import site comparison file", { exact: true }).setInputFiles({ name: "comparison.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(original)) });
  await expect(site(page).getByRole("status")).toContainText("Imported as read-only");
  expect((await store(page)).working).toEqual(before);
  expect((await store(page)).history).toHaveLength(1);
  const tampered = structuredClone(original); tampered.payload.evaluations[0].metrics.output_kg.value = 9000;
  await site(page).getByLabel("Import site comparison file", { exact: true }).setInputFiles({ name: "tampered.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(tampered)) });
  await expect(site(page).getByRole("alert")).toContainText(/canonical|digest|content/i);
  await expect(result(page)).toHaveAttribute("data-comparison-id", original.payload.id);
  await page.route("**/api/site-comparisons/verify", route => route.fulfill({ status: 503, json: { detail: "Local review server is offline." } }));
  await site(page).getByRole("button", { name: "Check local server copy", exact: true }).click();
  await expect(site(page).locator(".site-verification")).toContainText("offline");
  expect(await exportJson(page)).toEqual(original);
});

test("cancelled comparison does not claim success or replace existing history", async ({ page }) => {
  await load(page); const first = await compare(page); await edit(page);
  await page.route("**/api/site-comparisons", async route => { await new Promise(resolve => setTimeout(resolve, 700)); await route.abort("failed"); });
  await site(page).getByRole("checkbox", { name: "Site plan review" }).check();
  await site(page).getByRole("button", { name: "Compare reviewed plans" }).click();
  await site(page).getByRole("button", { name: "Cancel comparison" }).click();
  await expect(site(page).getByRole("alert")).toContainText("cancelled");
  expect((await store(page)).history).toHaveLength(1);
  expect(await exportJson(page)).toEqual(first);
});

test("creating and removing an alternative is atomic and retains a reloadable selected draft", async ({ page }) => {
  await load(page);
  await site(page).getByRole("button", { name: "Duplicate selected plan", exact: true }).click();
  await expect(site(page).getByRole("tab", { name: /Alternative 3/ })).toHaveAttribute("aria-selected", "true");
  await expect.poll(async () => (await store(page)).working.scenarios.length).toBe(4);
  const copiedId = (await store(page)).selectedScenarioId;
  await page.reload();
  await expect(site(page).getByRole("tab", { name: /Alternative 3/ })).toHaveAttribute("aria-selected", "true");
  expect((await store(page)).working.site.canopy_sqft).toBe(32);
  const comparison = await compare(page);
  expect(comparison.payload.scenario_count).toBe(4);
  expect(comparison.payload.evaluations.find(e => e.scenario_id === copiedId)?.metrics.output_kg.value).toBe(48);
  await site(page).getByRole("button", { name: "Edit operating plans", exact: true }).click();
  await site(page).getByRole("tab", { name: /Alternative 3/ }).click();
  await site(page).getByRole("button", { name: "Remove this draft alternative", exact: true }).click();
  await expect.poll(async () => (await store(page)).working.scenarios.length).toBe(3);
  expect((await store(page)).history[0].artifact.payload.scenario_count).toBe(4);
  await expect(site(page).getByRole("alert")).toHaveCount(0);
});

test("storage quota failure preserves previous comparison and offers full session export", async ({ page }) => {
  await load(page); const original = await compare(page);
  await expect.poll(async () => (await store(page)).history.length).toBe(1);
  const saved = await page.evaluate(key => localStorage.getItem(key), key);
  await page.evaluate(key => {
    const originalSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) { if (name === key) throw new DOMException("Storage quota exceeded", "QuotaExceededError"); return originalSet.call(this, name, value); };
  }, key);
  const next = await goal(page, "energy_kwh");
  await expect(site(page).getByRole("alert")).toContainText("No comparisons were evicted");
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(saved);
  expect(await exportJson(page)).toEqual(next);
  const pending = page.waitForEvent("download");
  await site(page).getByRole("button", { name: "Export session", exact: true }).click();
  const backup = JSON.parse(readFileSync((await (await pending).path())!, "utf8"));
  expect(backup.history).toHaveLength(2);
  expect(backup.history.find((entry: { artifact: SiteComparisonArtifact }) => entry.artifact.payload.id === original.payload.id).artifact).toEqual(original);
});

test("unavailable prior comparison gives explicit recovery without replacing its evidence", async ({ page }) => {
  await load(page); const original = await compare(page);
  await page.route("**/api/site-comparisons", async route => {
    if (route.request().postDataJSON().prior_comparison_id) return route.fulfill({ status: 409, json: { detail: "The earlier comparison is unavailable on this local server. Explicitly compare again to create new evaluations." } });
    return route.continue();
  });
  await site(page).getByRole("combobox", { name: "Comparison goal", exact: true }).selectOption("energy_kwh");
  await expect(site(page).getByRole("alert")).toContainText("earlier comparison is unavailable");
  await expect(result(page)).toHaveAttribute("data-comparison-id", original.payload.id);
  expect(await exportJson(page)).toEqual(original);
  await edit(page, "fixture-A");
  const rerun = await compare(page);
  expect(rerun.payload.preferred_scenario_ids).toEqual(["fixture-A"]);
  expect(rerun.payload.evaluations[0].id).not.toBe(original.payload.evaluations[0].id);
});

test("invalid numeric entry blocks comparison and correction preserves working persistence", async ({ page }) => {
  await load(page);
  await field(page, "Plan PPFD", "0");
  await expect(site(page).getByRole("spinbutton", { name: "Plan PPFD", exact: true })).toHaveAttribute("aria-invalid", "true");
  await site(page).getByRole("checkbox", { name: "Site plan review", exact: true }).click();
  await expect(site(page).getByRole("checkbox", { name: "Site plan review", exact: true })).not.toBeChecked();
  await expect(site(page).getByRole("button", { name: "Compare reviewed plans", exact: true })).toBeDisabled();
  await field(page, "Plan PPFD", "351");
  await expect.poll(async () => (await store(page)).working.scenarios[0].lighting.ppfd_full).toBe(351);
  await field(page, "Plan PPFD", "350");
  await compare(page);
  await expect(site(page).getByRole("alert")).toHaveCount(0);
  await expect(site(page).getByRole("region", { name: "Saved site comparisons", exact: true })).toContainText("Saved in this browser");
});

test("import-only comparison can explicitly become a separate unreviewed draft", async ({ page, browser }) => {
  await load(page); const original = await compare(page);
  const isolated = await browser.newContext({ viewport: page.viewportSize() ?? { width: 1440, height: 1000 }, permissions: [] });
  await isolated.route("**/api/scan", route => route.abort("blockedbyclient"));
  await isolated.route("**/api/live/**", route => route.abort("blockedbyclient"));
  const imported = await isolated.newPage();
  try {
    await imported.goto(page.url());
    await imported.getByRole("button", { name: "Compare site plans", exact: true }).click();
    await expect(site(imported).getByRole("button", { name: "Import comparison JSON", exact: true })).toBeEnabled();
    await site(imported).getByLabel("Import site comparison file", { exact: true }).setInputFiles({ name: "comparison.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(original)) });
    await expect(result(imported)).toHaveAttribute("data-comparison-id", original.payload.id);
    expect((await store(imported)).working).toBeNull();
    await site(imported).getByRole("button", { name: "Create draft from comparison", exact: true }).click();
    await expect(site(imported).getByRole("checkbox", { name: "Site plan review", exact: true })).not.toBeChecked();
    await expect.poll(async () => (await store(imported)).working.site.id).toBe(original.payload.input_snapshot.site.id);
    expect((await store(imported)).history[0].artifact).toEqual(original);
  } finally { await isolated.close(); }
});
