import { readFileSync } from "node:fs";
import sharp from "sharp";
import type { BrowserContext, Locator } from "@playwright/test";
import { expect, test as base, type Page } from "./test-support";
import type { EarthStore } from "../lib/earth-sites";
import type { SitePlanDraft } from "../lib/site-drafts";
import type { SiteComparisonStore } from "../lib/site-comparison-storage";
import type { SiteComparisonArtifact, SiteGoal } from "../lib/site-types";

const comparisonKey = "acreiq.site-comparisons.v2";
const locationKey = "acreiq.earth-locations.v1";
type SavedStore = SiteComparisonStore & { schema_version: number };
type NetworkAudit = { fixtureRequests: number; providerRequests: number; externalRequests: number; calculations: number };

// Coordinate-only tests: no Maps/Gemini traffic, fixture responses, or seeded working state.
async function offlineRouting(context: BrowserContext, origin: string): Promise<NetworkAudit> {
  const audit: NetworkAudit = { fixtureRequests: 0, providerRequests: 0, externalRequests: 0, calculations: 0 };
  const forbidden = (path: string) => path === "/api/sample" || path.endsWith("/fixture") || path === "/api/scan" || path.startsWith("/api/live/");
  context.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname === "/api/sample" || url.pathname.endsWith("/fixture")) audit.fixtureRequests++;
    if (url.pathname === "/api/scan" || url.pathname.startsWith("/api/live/")) audit.providerRequests++;
    // The existing CSS imports this font stylesheet; routing still blocks it locally.
    const blockedStaticFont = url.origin === "https://fonts.googleapis.com" && url.pathname === "/css2";
    if (url.origin !== origin && /^https?:$/.test(url.protocol) && !blockedStaticFont) audit.externalRequests++;
    if (url.pathname === "/api/site-comparisons" && request.method() === "POST") audit.calculations++;
  });
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || forbidden(url.pathname)) return route.abort("blockedbyclient");
    if (url.pathname === "/api/earth/maps-config") return route.fulfill({ json: { apiKey: null } });
    return route.continue();
  });
  return audit;
}

const test = base.extend<{ network: NetworkAudit }>({
  network: [async ({ context, baseURL }, use) => {
    if (!baseURL) throw new Error("A single local frontend origin is required for the handoff tests.");
    const origin = new URL(baseURL);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)) throw new Error("Handoff tests only run against a local frontend.");
    await use(await offlineRouting(context, origin.origin));
  }, { auto: true }],
});
test.use({ serviceWorkers: "block" });
test.describe.configure({ timeout: 120000 });
test.afterEach(async ({ network }) => {
  expect(network.fixtureRequests, "The fresh-site journey must never request a sample or fixture").toBe(0);
  expect(network.providerRequests, "No scan or Live provider calls are authorized").toBe(0);
  expect(network.externalRequests, "No unexpected external requests beyond the locally blocked static font stylesheet").toBe(0);
});

const earth = (page: Page) => page.getByRole("region", { name: "AcreIQ Earth", exact: true });
const site = (page: Page) => page.getByRole("region", { name: "Site scenario comparison", exact: true });
const results = (page: Page) => page.getByRole("region", { name: "Site comparison results", exact: true });
const summary = (page: Page) => page.getByRole("region", { name: "Earth selected comparison", exact: true });
const readStore = (page: Page): Promise<SavedStore | null> => page.evaluate(key => JSON.parse(localStorage.getItem(key) || "null"), comparisonKey);
const readLocations = (page: Page): Promise<EarthStore | null> => page.evaluate(key => JSON.parse(localStorage.getItem(key) || "null"), locationKey);
async function working(page: Page): Promise<SitePlanDraft> {
  const value = (await readStore(page))?.working;
  expect(value, "A named working site must be saved before a comparison exists").not.toBeNull();
  if (!value) throw new Error("No saved working planning site.");
  return value;
}
const drafts = (value: SavedStore | null) => [...(value?.working ? [value.working] : []), ...(value?.otherWorking ?? [])];

async function disclose(root: Locator, name: string) {
  const heading = root.locator("summary").filter({ hasText: name }).first();
  if ((await heading.locator("..").getAttribute("open")) === null) await heading.click();
}
async function textField(page: Page, label: string, value: string) {
  const input = site(page).getByRole("textbox", { name: label, exact: true });
  await input.fill(value); await input.blur();
}
async function numberField(page: Page, label: string, value: string) {
  const input = site(page).getByRole("spinbutton", { name: label, exact: true });
  await input.fill(value); await input.blur();
  await expect(input).not.toHaveAttribute("aria-invalid", "true");
}
async function enterEarth(page: Page) {
  await page.getByRole("button", { name: "AcreIQ Earth", exact: true }).click();
  await expect(earth(page)).toBeVisible();
}
async function selectCoordinates(page: Page, lat = "10", lng = "20") {
  await disclose(earth(page), "Precise coordinates");
  await earth(page).getByRole("textbox", { name: "Latitude", exact: true }).fill(lat);
  await earth(page).getByRole("textbox", { name: "Longitude", exact: true }).fill(lng);
  await earth(page).getByRole("button", { name: "Select coordinates", exact: true }).click();
  await expect(earth(page).locator(".earth-selected")).toContainText(`${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`);
}
async function createSite(page: Page, name: string, lat = "10", lng = "20") {
  await enterEarth(page); await selectCoordinates(page, lat, lng);
  const nameInput = earth(page).getByRole("textbox", { name: "Planning site name", exact: true });
  await nameInput.fill(name); await nameInput.blur();
  await earth(page).getByRole("button", { name: "Create planning site here", exact: true }).click();
  await expect.poll(async () => (await readStore(page))?.working?.site.name).toBe(name);
  const draft = await working(page);
  expect(draft.site.id).toBeTruthy();
  expect(draft.site.evidence).toMatchObject({ source: "user_assumption", entry_route: "manual", recorded_at: null, instrument: null });
  expect(draft.scenarios).toEqual([]); expect(draft.assets).toEqual([]);
  expect(draft.site.length_ft).toBeNull(); expect(draft.site.width_ft).toBeNull(); expect(draft.site.canopy_sqft).toBeNull();
  expect(draft.operation).toMatchObject({ site_id: draft.site.id, operation_type: "indoor_leafy_greens", horizon_days: null, crop: null });
  expect(draft.review).toBeNull();
  await expect.poll(async () => (await readLocations(page))?.associations.find(item => item.siteId === draft.site.id)?.point).toEqual({ lat: Number(lat), lng: Number(lng) });
  await expect(earth(page).locator(".earth-associated")).toContainText(`${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}`);
  return draft.site.id;
}
async function createCurrent(page: Page) {
  await earth(page).getByRole("button", { name: "Create current plan", exact: true }).click();
  await expect(site(page)).toBeVisible();
  await expect.poll(async () => (await readStore(page))?.working?.scenarios.length).toBe(1);
  const draft = await working(page); const plan = draft.scenarios[0];
  expect(plan).toMatchObject({ role: "current", benchmark: null, water_liters_day: null, lighting: { hours_per_day: null, dim_fraction: null, ppfd_full: null, min_dli: null, power_limit_watts: null } });
  expect(plan.costs.every(cost => cost.status === "unknown" && cost.rate === null && cost.amount === null)).toBe(true);
  expect(draft.review).toBeNull();
  await expect(site(page)).toContainText(/Indoor leafy greens/i);
  await expect(site(page)).toContainText(/farm location does not extend this model|not.*whole.farm|whole.farm.*not/i);
  return plan.id;
}

// Deliberately entered test assumptions, not the fixture endpoint and not farm measurements.
async function enterTestInputs(page: Page, includePPFD = true) {
  await disclose(site(page), "Site and existing assets");
  await textField(page, "Included growing space", "TEST ONLY - synthetic indoor growing bay");
  await textField(page, "Excluded spaces", "TEST ONLY - all outdoor acreage and other infrastructure");
  for (const [label, value] of [["Site length", "8"], ["Site width", "8"], ["Usable canopy", "32"]]) await numberField(page, label, value);
  await site(page).getByRole("button", { name: "Add asset", exact: true }).click();
  await disclose(site(page), "Asset 1");
  await numberField(page, "Asset 1 quantity", "1");
  await numberField(page, "Asset 1 power", "600");
  await site(page).getByRole("combobox", { name: "Asset 1 power basis", exact: true }).selectOption("aggregate");
  await site(page).getByRole("combobox", { name: "Asset 1 availability", exact: true }).selectOption("true");
  await site(page).getByRole("combobox", { name: "Asset 1 ownership", exact: true }).selectOption("owned");
  await disclose(site(page), "Operation and common conditions");
  for (const [label, value] of [
    ["Crop", "Lettuce"], ["Cultivar", "TEST-ONLY"], ["Production method", "TEST-ONLY synthetic indoor hydroponic inputs; not a farm measurement"],
    ["Starting stage", "transplant"], ["Harvest stage", "harvest"], ["Nutrient protocol", "TEST-ONLY synthetic nutrient assumption"],
    ["Marketable product definition", "TEST ONLY - net marketable fresh lettuce mass in kg, synthetic reference output"],
    ["Operation assumption/source note", "TEST-ONLY synthetic indoor reference operation. All numbers are explicit assumptions, not measurements of the selected location."],
  ]) await textField(page, label, value);
  for (const [label, value] of [
    ["Operating horizon", "28"], ["Cycle duration", "28"], ["Complete cycles", "1"], ["Turnover per cycle", "0"], ["Idle time", "0"],
    ["Starts per cycle", "160"], ["Temperature", "22"], ["Relative humidity", "60"], ["Carbon dioxide", "420"], ["Nutrient pH", "6"], ["Electrical conductivity", "1.5"],
  ]) await numberField(page, label, value);
  await site(page).getByRole("checkbox", { name: /identical/i }).check();
  for (const [label, value] of [
    ["Lighting schedule", "16"], ["Light output fraction", "1"], ["Minimum lighting schedule", "10"], ["Maximum lighting schedule", "18"],
    ["Modeled power limit", "1000"], ["Required daily light integral", "15"], ["Water use", "15"],
  ]) await numberField(page, label, value);
  if (includePPFD) await numberField(page, "Plan PPFD", "350");
  await textField(page, "PPFD basis", "TEST-ONLY explicit synthetic scalar; not recorded PPFD");
  await textField(page, "Plan assumption/source note", "TEST-ONLY synthetic lighting and water inputs for local arithmetic. Not a measured operating plan or agronomic forecast.");
  await site(page).getByRole("combobox", { name: "Asset 1 accounting", exact: true }).selectOption("lighting");
  await disclose(site(page), "Scoped cash costs");
  await numberField(page, "Electricity rate", "0.2");
  await expect.poll(async () => (await readStore(page))?.working?.scenarios[0].costs.find(cost => cost.category === "electricity")?.rate).toBe(0.2);
  await disclose(site(page), "Resource limits");
  for (const [label, value] of [["dli minimum", "15"], ["peak watts maximum", "1000"], ["lighting hours minimum", "10"], ["lighting hours maximum", "18"]]) await numberField(page, label, value);
}
async function addBenchmark(page: Page, kg: string) {
  await disclose(site(page), "Conditional output benchmark");
  await site(page).getByRole("button", { name: "Create revised benchmark assumption", exact: true }).click();
  await numberField(page, "Assumed marketable output per cycle", kg);
  await textField(page, "Assumption source and applicability note", `TEST-ONLY synthetic ${kg} kg per 28-day cycle for this exact indoor test plan. Explicit assumption, not measured or predicted yield.`);
  await site(page).getByRole("checkbox", { name: "This is my explicit conditional assumption, not a measured or predicted yield.", exact: true }).check();
  await site(page).getByRole("button", { name: "Save benchmark assumption", exact: true }).click();
  await expect(site(page).getByRole("button", { name: "Save benchmark assumption", exact: true })).toHaveCount(0);
}
async function addAlternative(page: Page, withBenchmark = true) {
  await site(page).getByRole("button", { name: "Duplicate selected plan", exact: true }).click();
  await expect.poll(async () => (await readStore(page))?.working?.scenarios.length).toBe(2);
  await textField(page, "Plan name", "Alternative 12");
  await numberField(page, "Lighting schedule", "12");
  await numberField(page, "Water use", "14");
  await expect(site(page).getByRole("checkbox", { name: "Site plan review", exact: true })).not.toBeChecked();
  const copied = (await working(page)).scenarios.find(plan => plan.role === "alternative")!;
  if (withBenchmark) {
    expect(copied.benchmark?.context.lighting).toMatchObject({ hours_per_day: 16 });
    await addBenchmark(page, "20");
  }
  return copied.id;
}
async function compare(page: Page) {
  await site(page).getByRole("checkbox", { name: "Site plan review", exact: true }).check();
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === "/api/site-comparisons" && response.request().method() === "POST");
  await site(page).getByRole("button", { name: "Compare reviewed plans", exact: true }).click();
  const response = await responsePromise;
  expect(response.status(), "The comparison must be produced by the actual local numerical API").toBe(200);
  const artifact = await response.json() as SiteComparisonArtifact;
  await expect(results(page)).toHaveAttribute("data-comparison-id", artifact.payload.id);
  await expect.poll(async () => (await readStore(page))?.history.some(entry => entry.artifact.payload.id === artifact.payload.id)).toBe(true);
  return artifact;
}
async function changeGoal(page: Page, metric: SiteGoal["metric"]) {
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === "/api/site-comparisons" && response.request().method() === "POST");
  await site(page).getByRole("combobox", { name: "Comparison goal", exact: true }).selectOption(metric);
  const response = await responsePromise; expect(response.status()).toBe(200);
  const artifact = await response.json() as SiteComparisonArtifact;
  await expect(results(page)).toHaveAttribute("data-comparison-id", artifact.payload.id);
  await expect.poll(async () => (await readStore(page))?.selectedComparisonId).toBe(artifact.payload.id);
  return artifact;
}
async function exportJson(page: Page) {
  const downloaded = page.waitForEvent("download");
  await site(page).getByRole("button", { name: "Comparison JSON", exact: true }).click();
  const download = await downloaded;
  expect(await download.failure()).toBeNull();
  const path = await download.path(); if (!path) throw new Error("Comparison download has no local path.");
  return { artifact: JSON.parse(readFileSync(path, "utf8")) as SiteComparisonArtifact, filename: download.suggestedFilename() };
}
async function evaluatedSite(page: Page, name: string) {
  const siteId = await createSite(page, name); const currentId = await createCurrent(page);
  await enterTestInputs(page); await addBenchmark(page, "24");
  const alternativeId = await addAlternative(page);
  await site(page).getByRole("combobox", { name: "Comparison goal", exact: true }).selectOption("output_kg");
  const artifact = await compare(page);
  return { siteId, currentId, alternativeId, artifact };
}
async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

test("fresh site to reviewed plans, goal change, Earth summary, reload and exact export without a fixture", async ({ page, network }, info) => {
  await page.goto("/");
  expect((await readStore(page))?.working ?? null).toBeNull();
  expect((await readStore(page))?.history ?? []).toEqual([]);
  const { siteId, currentId, alternativeId, artifact } = await evaluatedSite(page, "TEST ONLY - first planning site");
  expect(artifact.payload.input_snapshot.site.id).toBe(siteId);
  expect(artifact.payload.preferred_scenario_ids).toEqual([currentId]);
  const current = artifact.payload.evaluations.find(item => item.scenario_id === currentId)!;
  const alternative = artifact.payload.evaluations.find(item => item.scenario_id === alternativeId)!;
  for (const [evaluation, hours, kg, liters] of [[current, 16, 24, 15], [alternative, 12, 20, 14]] as const) {
    const energy = 600 * hours * 28 / 1000;
    expect(evaluation.requested_setting.hours).toBe(hours);
    expect(evaluation.metrics.energy_kwh.value).toBeCloseTo(energy, 8);
    expect(evaluation.metrics.output_kg.value).toBe(kg);
    expect(evaluation.metrics.water_liters.value).toBe(liters * 28);
    expect(evaluation.metrics.new_setup_cash_usd.value).toBeNull();
    expect(evaluation.metrics.recurring_cash_usd.value).toBeNull();
    expect(evaluation.metrics.horizon_cash_usd.value).toBeNull();
    expect(evaluation.metrics.horizon_cash_usd.known_subtotal).toBeCloseTo(energy * 0.2, 8);
    expect(evaluation.feasibility).toBe("pass"); expect(evaluation.applicability.status).toBe("pass");
    expect(evaluation.provenance).toBe("user_defined");
    expect(evaluation.snapshot.scenario.benchmark?.evidence.source).toBe("user_assumption");
    expect(evaluation.snapshot.scenario.benchmark?.evidence.note).toContain("TEST-ONLY synthetic");
    await expect(results(page).locator(`tr[data-scenario-id="${evaluation.scenario_id}"]`)).toContainText("known subtotal");
  }
  const schematic = site(page).getByRole("region", { name: "Site plan schematic", exact: true });
  const canvas = schematic.locator("canvas");
  await expect(canvas).toBeVisible();
  await canvas.scrollIntoViewIfNeeded();
  const beforeCamera = await canvas.screenshot({ path: info.outputPath("first-site-schematic.png") });
  const pixels = await sharp(beforeCamera).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let bright = 0, foliage = 0;
  for (let index = 0; index < pixels.data.length; index += pixels.info.channels) {
    const [r, g, b] = pixels.data.subarray(index, index + 3);
    if (r + g + b > 180) bright++;
    if (g > r * 1.12 && g > b * 1.12 && g > 50) foliage++;
  }
  const area = pixels.info.width * pixels.info.height;
  expect(bright / area, "The new site's schematic must contain visible geometry").toBeGreaterThan(0.02);
  expect(foliage / area, "The entered canopy must render rather than a blank canvas").toBeGreaterThan(0.002);
  await schematic.getByRole("button", { name: "Site top view", exact: true }).click();
  await expect.poll(async () => (await canvas.screenshot()).equals(beforeCamera)).toBe(false);
  await schematic.screenshot({ path: info.outputPath("first-site-top-view.png") });
  await schematic.getByRole("button", { name: "Reset site camera", exact: true }).click();
  await expectNoOverflow(page);
  const energy = await changeGoal(page, "energy_kwh");
  expect(energy.payload.preferred_scenario_ids).toEqual([alternativeId]);
  expect(energy.payload.reused_evaluations).toBe(true);
  expect(energy.payload.evaluations).toEqual(artifact.payload.evaluations);
  await site(page).getByRole("button", { name: "Inspect Alternative 12", exact: true }).click();
  const explanation = site(page).getByRole("region", { name: "Why this site result?", exact: true });
  await expect(explanation).toHaveAttribute("data-evaluation-id", alternative.id);
  await expect(explanation).toContainText("67.2 kWh less");
  await expect(explanation).toContainText("4 kg less");
  await disclose(explanation, "Formulas and exact-run evidence");
  await expect(explanation).toContainText(energy.payload.id);
  const saved = await readStore(page); const calculations = network.calculations;
  await enterEarth(page);
  await expect(earth(page).getByRole("combobox", { name: "Existing AcreIQ site", exact: true })).toHaveValue(siteId);
  await expect(summary(page)).toHaveAttribute("data-comparison-id", energy.payload.id);
  await expect(summary(page)).toContainText(/Minimize energy|energy kwh/i);
  await expect(summary(page)).toContainText("Alternative 12");
  await expect(summary(page)).toContainText("201.6"); await expect(summary(page)).toContainText("20");
  await expect(summary(page)).toContainText("392"); await expect(summary(page)).toContainText("40.32");
  await expect(summary(page)).toContainText(/known subtotal/i); await expect(summary(page)).toContainText(/constraint.pass/i);
  await summary(page).scrollIntoViewIfNeeded();
  await expect(summary(page)).toBeVisible();
  await expectNoOverflow(page); await page.screenshot({ path: info.outputPath("earth-first-time-comparison.png"), fullPage: true });
  await page.reload(); await expect(earth(page)).toBeVisible();
  await expect(summary(page)).toHaveAttribute("data-comparison-id", energy.payload.id);
  await expect(earth(page).locator(".earth-associated")).toContainText("10.000000, 20.000000");
  await earth(page).getByRole("button", { name: "Open site comparison", exact: true }).click();
  await expect(results(page)).toHaveAttribute("data-comparison-id", energy.payload.id);
  const exported = await exportJson(page);
  expect(exported.artifact).toEqual(energy); expect(exported.filename).toContain(energy.payload.id);
  expect((await readStore(page))?.working).toEqual(saved?.working);
  expect((await readStore(page))?.history).toEqual(saved?.history);
  expect(network.calculations).toBe(calculations);
  await expectNoOverflow(page);
});

test("zero-plan and one-plan sites reload with unknown inputs and explicit evaluation guidance", async ({ page, network }, info) => {
  await page.goto("/");
  const id = await createSite(page, "TEST ONLY - incomplete planning site", "0", "0");
  const zeroPlans = await working(page);
  expect((await readStore(page))?.schema_version).toBe(3);
  await page.reload(); await expect(earth(page)).toBeVisible();
  expect(await working(page)).toEqual(zeroPlans);
  await expect(earth(page).getByRole("combobox", { name: "Existing AcreIQ site", exact: true })).toHaveValue(id);
  await expect(summary(page)).toHaveCount(0);
  const currentId = await createCurrent(page);
  await expect(site(page).getByRole("spinbutton", { name: "Plan PPFD", exact: true })).toHaveValue("");
  await expect(site(page).getByRole("button", { name: "Compare reviewed plans", exact: true })).toBeDisabled();
  await expect(site(page)).toContainText(/Needed before comparison|required planning inputs|complete.*before.*evaluat|missing.*inputs/i);
  await expect(site(page)).toContainText(/operating horizon|horizon_days/i);
  await expect(site(page)).toContainText(/alternative/i);
  await textField(page, "Plan name", "TEST ONLY - unfinished current plan");
  await expect.poll(async () => (await readStore(page))?.working?.scenarios[0].name).toBe("TEST ONLY - unfinished current plan");
  const onePlan = await working(page);
  await page.reload(); await expect(site(page)).toBeVisible();
  expect(await working(page)).toEqual(onePlan);
  expect((await working(page)).scenarios[0].id).toBe(currentId);
  expect((await readStore(page))?.history).toEqual([]);
  await expect(results(page)).toHaveCount(0);
  await expect(site(page).getByRole("button", { name: "Compare reviewed plans", exact: true })).toBeDisabled();
  expect(network.calculations).toBe(0);
  await expectNoOverflow(page); await page.screenshot({ path: info.outputPath("earth-incomplete-plan-guidance.png"), fullPage: true });
});

test("missing PPFD permits saved plans but never output, DLI or fabricated savings", async ({ page }) => {
  await page.goto("/"); await createSite(page, "TEST ONLY - missing PPFD"); await createCurrent(page);
  await enterTestInputs(page, false); await addAlternative(page, false);
  const artifact = await compare(page);
  expect(artifact.payload.preferred_scenario_ids).toEqual([]);
  expect(artifact.payload.evaluations.map(item => item.metrics.energy_kwh.value)).toEqual([268.8, 201.6]);
  for (const evaluation of artifact.payload.evaluations) {
    expect(evaluation.snapshot.scenario.lighting.ppfd_full).toBeNull();
    expect(evaluation.snapshot.scenario.benchmark).toBeNull();
    expect(evaluation.metrics.dli.value).toBeNull(); expect(evaluation.metrics.output_kg.value).toBeNull();
    expect(evaluation.metrics.horizon_cash_usd.value).toBeNull();
    expect(evaluation.feasibility).toBe("unknown");
    expect(evaluation.missing_inputs.join(" ")).toContain("ppfd_full");
    expect(evaluation.module_result?.status).toBe("needs_measurement");
  }
  await expect(site(page).getByRole("region", { name: "Comparison explanation", exact: true })).toContainText("No eligible scenario");
  await enterEarth(page);
  await expect(summary(page)).toHaveAttribute("data-comparison-id", artifact.payload.id);
  await expect(summary(page)).toContainText(/unknown|not evaluated/i);
  await page.reload(); await expect(summary(page)).toHaveAttribute("data-comparison-id", artifact.payload.id);
  await earth(page).getByRole("button", { name: "Open site comparison", exact: true }).click();
  expect((await exportJson(page)).artifact).toEqual(artifact);
});

test("revised alternative invalidates review and applicability while Earth retains exact earlier evidence", async ({ page, network }) => {
  await page.goto("/"); const first = await evaluatedSite(page, "TEST ONLY - historical inputs");
  await site(page).getByRole("button", { name: "Edit operating plans", exact: true }).click();
  await site(page).getByRole("tab", { name: /Alternative 12/ }).click();
  await numberField(page, "Lighting schedule", "13");
  await expect(site(page).getByRole("checkbox", { name: "Site plan review", exact: true })).not.toBeChecked();
  await expect.poll(async () => (await readStore(page))?.working?.scenarios.find(plan => plan.id === first.alternativeId)?.lighting.hours_per_day).toBe(13);
  const changed = await working(page);
  expect(changed.scenarios.find(plan => plan.id === first.alternativeId)?.benchmark?.context.lighting).toMatchObject({ hours_per_day: 12 });
  await enterEarth(page);
  await earth(page).getByRole("combobox", { name: "Site comparison", exact: true }).selectOption(first.artifact.payload.id);
  await earth(page).getByRole("button", { name: "Open site comparison", exact: true }).click();
  expect((await exportJson(page)).artifact).toEqual(first.artifact);
  expect(await working(page)).toEqual(changed);
  await site(page).getByRole("button", { name: "Edit operating plans", exact: true }).click();
  const rerun = await compare(page);
  const alternative = rerun.payload.evaluations.find(item => item.scenario_id === first.alternativeId)!;
  expect(alternative.metrics.energy_kwh.value).toBe(218.4);
  expect(alternative.metrics.output_kg.value).toBeNull(); expect(alternative.applicability.status).toBe("fail");
  const beforeLocation = await readStore(page); const calculations = network.calculations;
  await enterEarth(page); await selectCoordinates(page, "11", "21");
  await earth(page).getByRole("button", { name: "Replace site location", exact: true }).click();
  await expect.poll(async () => (await readLocations(page))?.associations.find(item => item.siteId === first.siteId)?.point).toEqual({ lat: 11, lng: 21 });
  expect((await readStore(page))?.working).toEqual(beforeLocation?.working);
  expect((await readStore(page))?.history).toEqual(beforeLocation?.history);
  expect(network.calculations).toBe(calculations);
});

test("two sites retain independent working plans and history through Earth selection and reload", async ({ page, network }) => {
  await page.goto("/"); const first = await evaluatedSite(page, "TEST ONLY - site one");
  const firstDraft = await working(page); const history = (await readStore(page))!.history;
  const secondId = await createSite(page, "TEST ONLY - site two", "-10", "-20");
  expect(secondId).not.toBe(first.siteId);
  expect(drafts(await readStore(page)).find(draft => draft.site.id === first.siteId)).toEqual(firstDraft);
  await createCurrent(page); await textField(page, "Plan name", "TEST ONLY - second incomplete plan");
  await expect.poll(async () => (await readStore(page))?.working?.scenarios[0].name).toBe("TEST ONLY - second incomplete plan");
  const secondDraft = await working(page); const calculations = network.calculations;
  await enterEarth(page);
  await expect(summary(page)).toHaveCount(0);
  await earth(page).getByRole("combobox", { name: "Existing AcreIQ site", exact: true }).selectOption(first.siteId);
  await expect(earth(page).locator(".earth-associated")).toContainText("10.000000, 20.000000");
  await earth(page).getByRole("button", { name: "Open site comparison", exact: true }).click();
  await expect(results(page)).toHaveAttribute("data-comparison-id", first.artifact.payload.id);
  expect((await exportJson(page)).artifact).toEqual(first.artifact);
  await enterEarth(page);
  await earth(page).getByRole("combobox", { name: "Existing AcreIQ site", exact: true }).selectOption(secondId);
  await earth(page).getByRole("button", { name: "Compare plans", exact: true }).click();
  await expect(site(page).getByRole("textbox", { name: "Plan name", exact: true })).toHaveValue("TEST ONLY - second incomplete plan");
  await page.reload(); await expect(site(page)).toBeVisible();
  expect(await working(page)).toEqual(secondDraft);
  expect(drafts(await readStore(page)).find(draft => draft.site.id === first.siteId)).toEqual(firstDraft);
  expect((await readStore(page))?.history).toEqual(history);
  expect((await readLocations(page))?.associations).toHaveLength(2);
  expect(network.calculations).toBe(calculations);
});

test("explicit JSON recovery into isolated storage preserves the recipient working site and imported identity", async ({ page, browser, baseURL, isMobile, hasTouch }) => {
  await page.goto("/"); const source = await evaluatedSite(page, "TEST ONLY - exported planning site");
  const exported = await exportJson(page);
  // A second empty context represents the missing old-origin history without reading or changing port 3004.
  const isolated = await browser.newContext({ baseURL, viewport: page.viewportSize(), isMobile, hasTouch, serviceWorkers: "block", reducedMotion: "reduce", permissions: [] });
  const audit = await offlineRouting(isolated, new URL(page.url()).origin);
  const recipient = await isolated.newPage();
  try {
    await recipient.goto(page.url()); await enterEarth(recipient);
    expect((await readStore(recipient))?.history ?? []).toEqual([]);
    const recovery = earth(recipient).locator("details").filter({ hasText: /3004/ }).first();
    if ((await recovery.getAttribute("open")) === null) await recovery.locator(":scope > summary").click();
    await expect(recovery.locator("p").first()).toBeVisible();
    await expect(earth(recipient)).toContainText(/origin|port|3004/i);
    await expect(earth(recipient)).toContainText(/export.*JSON|JSON.*export/i);
    await expect(earth(recipient)).toContainText(/import/i);
    const recipientId = await createSite(recipient, "TEST ONLY - recipient working site", "30", "40");
    await createCurrent(recipient);
    const before = await readStore(recipient); const pins = await readLocations(recipient);
    await site(recipient).getByLabel("Import site comparison file", { exact: true }).setInputFiles({ name: exported.filename, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(exported.artifact)) });
    await expect(results(recipient)).toHaveAttribute("data-comparison-id", source.artifact.payload.id);
    await expect(site(recipient).getByRole("status")).toContainText("Imported as read-only");
    expect((await readStore(recipient))?.working).toEqual(before?.working);
    expect((await readStore(recipient))?.otherWorking ?? []).toEqual(before?.otherWorking ?? []);
    expect((await readStore(recipient))?.history.map(entry => entry.artifact)).toEqual([source.artifact]);
    expect(await readLocations(recipient)).toEqual(pins);
    await enterEarth(recipient);
    const choices = earth(recipient).getByRole("combobox", { name: "Existing AcreIQ site", exact: true });
    await expect(choices.locator("option")).toHaveCount(2);
    await choices.selectOption(source.siteId);
    await expect(earth(recipient).locator(".earth-associated")).toHaveCount(0);
    await earth(recipient).getByRole("button", { name: "Open site comparison", exact: true }).click();
    await recipient.reload(); await expect(results(recipient)).toHaveAttribute("data-comparison-id", source.artifact.payload.id);
    expect((await exportJson(recipient)).artifact).toEqual(source.artifact);
    expect(drafts(await readStore(recipient)).find(draft => draft.site.id === recipientId)).toEqual(before?.working);
    expect(audit).toEqual({ fixtureRequests: 0, providerRequests: 0, externalRequests: 0, calculations: 0 });
  } finally { await isolated.close(); }
});
