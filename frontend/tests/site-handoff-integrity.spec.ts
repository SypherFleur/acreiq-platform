import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Locator } from "@playwright/test";
import { expect, test as base, type Page } from "./test-support";
import { validateSiteComparisonArtifact, type SiteComparisonStore } from "../lib/site-comparison-storage";
import type { SiteComparisonArtifact, SiteComparisonRequest } from "../lib/site-types";

const comparisonKey = "acreiq.site-comparisons.v2";
const earthKey = "acreiq.earth-locations.v1";
type Audit = { comparisons: number; forbidden: string[] };
type StorageAuditWindow = Window & { siteIntegrityWrites: string[] };

const test = base.extend<{ network: Audit }>({
  network: [async ({ context, baseURL }, use) => {
    if (!baseURL) throw new Error("Use the authorized local preview origin for integrity tests.");
    const origin = new URL(baseURL);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)) throw new Error("Integrity tests require a local frontend.");
    const audit: Audit = { comparisons: 0, forbidden: [] };
    const providerPath = (path: string) => path === "/api/scan" || path.startsWith("/api/live/");
    context.on("request", request => {
      const url = new URL(request.url());
      if (url.origin === origin.origin && url.pathname === "/api/site-comparisons" && request.method() === "POST") audit.comparisons++;
      if (providerPath(url.pathname) || (url.origin !== origin.origin && /^https?:$/.test(url.protocol) && url.hostname !== "fonts.googleapis.com")) audit.forbidden.push(`${url.origin}${url.pathname}`);
    });
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.hostname === "fonts.googleapis.com") return route.fulfill({ contentType: "text/css", body: "" });
      if (url.origin !== origin.origin || providerPath(url.pathname)) return route.abort("blockedbyclient");
      if (url.pathname === "/api/earth/maps-config") return route.fulfill({ json: { apiKey: null } });
      return route.continue();
    });
    await use(audit);
    expect(audit.forbidden, "All provider/external traffic is blocked; no provider flow should be attempted").toEqual([]);
  }, { auto: true }],
});
test.use({ serviceWorkers: "block" });
test.describe.configure({ timeout: 120000 });

const site = (page: Page) => page.getByRole("region", { name: "Site scenario comparison", exact: true });
const results = (page: Page) => site(page).getByRole("region", { name: "Site comparison results", exact: true });
const pendingBenchmark = (page: Page) => site(page).getByRole("region", { name: "Revised benchmark assumption", exact: true });
const rawStore = (page: Page) => page.evaluate(key => localStorage.getItem(key), comparisonKey);
const store = (page: Page): Promise<SiteComparisonStore> => page.evaluate(key => JSON.parse(localStorage.getItem(key)!), comparisonKey);
const plan = async (page: Page, id: string) => (await store(page)).working!.scenarios.find(item => item.id === id)!;

async function disclose(root: Locator, name: string) {
  const heading = root.locator("summary").filter({ hasText: name }).first();
  if ((await heading.locator("..").getAttribute("open")) === null) await heading.click();
}
async function field(page: Page, label: string, value: string) {
  const input = site(page).getByRole("spinbutton", { name: label, exact: true });
  await input.fill(value); await input.blur();
  await expect(input).not.toHaveAttribute("aria-invalid", "true");
}
async function textField(page: Page, label: string, value: string) {
  const input = site(page).getByRole("textbox", { name: label, exact: true });
  await input.fill(value); await input.blur();
}
async function saved(page: Page) {
  await expect(site(page).getByRole("region", { name: "Saved site comparisons", exact: true })).toContainText("Saved in this browser");
}
async function baseline(page: Page): Promise<SiteComparisonArtifact> {
  await page.goto("/");
  await page.getByRole("button", { name: "Compare site plans", exact: true }).click();
  await site(page).getByRole("button", { name: "Load A/B/C synthetic fixture", exact: true }).click();
  await expect(site(page).getByRole("checkbox", { name: "Site plan review", exact: true })).toBeEnabled();
  await site(page).getByRole("checkbox", { name: "Site plan review", exact: true }).check();
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === "/api/site-comparisons" && response.request().method() === "POST");
  await site(page).getByRole("button", { name: "Compare reviewed plans", exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const artifact = await response.json() as SiteComparisonArtifact;
  expect(await validateSiteComparisonArtifact(artifact)).toMatchObject({ ok: true });
  await expect(results(page)).toHaveAttribute("data-comparison-id", artifact.payload.id);
  await expect.poll(async () => (await store(page)).selectedComparisonId).toBe(artifact.payload.id);
  await saved(page);
  return artifact;
}
async function editCurrent(page: Page) {
  await site(page).getByRole("button", { name: "Edit operating plans", exact: true }).click();
  await site(page).getByRole("tab", { name: /A - Current operation/ }).click();
  await expect.poll(async () => (await store(page)).selectedComparisonId).toBeNull();
  await expect.poll(async () => (await store(page)).selectedScenarioId).toBe("fixture-A");
  await saved(page);
}
async function acknowledgePending(page: Page, kg = "99") {
  await disclose(site(page), "Conditional output benchmark");
  await site(page).getByRole("button", { name: "Create revised benchmark assumption", exact: true }).click();
  await expect(pendingBenchmark(page)).toBeVisible();
  await field(page, "Assumed marketable output per cycle", kg);
  await textField(page, "Assumption source and applicability note", "TEST ONLY: synthetic pending assumption for plan A's exact conditions, not measured yield.");
  await pendingBenchmark(page).getByRole("checkbox").check();
  await expect(pendingBenchmark(page).getByRole("button", { name: "Save benchmark assumption", exact: true })).toBeEnabled();
}
async function expectPriorEvidence(page: Page, artifact: SiteComparisonArtifact) {
  const state = await store(page);
  expect(state.history).toEqual([{ artifact, important: false }]);
  expect(state.history[0].artifact.canonical_json).toBe(artifact.canonical_json);
  expect(state.history[0].artifact.payload.input_canonical_json).toBe(artifact.payload.input_canonical_json);
  expect(state.history[0].artifact.sha256).toBe(artifact.sha256);
}
async function auditWrites(page: Page) {
  await page.evaluate(keys => {
    const target = window as unknown as StorageAuditWindow;
    target.siteIntegrityWrites = [];
    const set = Storage.prototype.setItem, remove = Storage.prototype.removeItem, clear = Storage.prototype.clear;
    Storage.prototype.setItem = function(key, value) { if (this === localStorage && keys.includes(key)) target.siteIntegrityWrites.push(`set:${key}`); return set.call(this, key, value); };
    Storage.prototype.removeItem = function(key) { if (this === localStorage && keys.includes(key)) target.siteIntegrityWrites.push(`remove:${key}`); return remove.call(this, key); };
    Storage.prototype.clear = function() { if (this === localStorage) target.siteIntegrityWrites.push("clear"); return clear.call(this); };
  }, [comparisonKey, earthKey]);
}
const writes = (page: Page) => page.evaluate(() => (window as unknown as StorageAuditWindow).siteIntegrityWrites);
async function exportJson(page: Page) {
  const pending = page.waitForEvent("download");
  await site(page).getByRole("button", { name: "Comparison JSON", exact: true }).click();
  const download = await pending;
  expect(await download.failure()).toBeNull();
  const path = await download.path(); if (!path) throw new Error("Comparison export has no file.");
  return JSON.parse(readFileSync(path, "utf8")) as SiteComparisonArtifact;
}

test("switching plans closes a pending benchmark without transferring its acknowledgement or values", async ({ page, network }) => {
  const original = await baseline(page);
  await editCurrent(page);
  const before = (await store(page)).working!;
  await acknowledgePending(page);
  expect((await store(page)).working).toEqual(before);
  await site(page).getByRole("tab", { name: /B - Shorter schedule/ }).click();
  await expect(pendingBenchmark(page)).toHaveCount(0);
  await expect.poll(async () => (await store(page)).selectedScenarioId).toBe("fixture-B");
  expect((await store(page)).working).toEqual(before);
  await expectPriorEvidence(page, original);
  await disclose(site(page), "Conditional output benchmark");
  await site(page).getByRole("button", { name: "Create revised benchmark assumption", exact: true }).click();
  await expect(pendingBenchmark(page).getByRole("checkbox")).not.toBeChecked();
  await expect(pendingBenchmark(page).getByRole("spinbutton", { name: "Assumed marketable output per cycle", exact: true })).toHaveValue("");
  await expect(pendingBenchmark(page).getByRole("button", { name: "Save benchmark assumption", exact: true })).toBeDisabled();
  expect(network.comparisons).toBe(1);
});

for (const changed of ["lighting schedule", "crop condition"] as const) {
  test(`${changed} changes invalidate the pending benchmark, leaving saved applicability evidence untouched`, async ({ page, network }) => {
    const original = await baseline(page);
    await editCurrent(page);
    const before = (await store(page)).working!;
    await acknowledgePending(page);
    if (changed === "lighting schedule") {
      await field(page, "Lighting schedule", "17");
      await expect.poll(async () => (await plan(page, "fixture-A")).lighting.hours_per_day).toBe(17);
    } else {
      await disclose(site(page), "Operation and common conditions");
      await textField(page, "Crop", "TEST ONLY basil condition");
      await expect.poll(async () => (await store(page)).working?.operation.crop).toBe("TEST ONLY basil condition");
    }
    await expect(pendingBenchmark(page)).toHaveCount(0);
    await expect(site(page).getByRole("checkbox", { name: "Site plan review", exact: true })).not.toBeChecked();
    const after = (await store(page)).working!;
    expect(after.review).toBeNull();
    expect(after.scenarios.map(item => item.benchmark)).toEqual(before.scenarios.map(item => item.benchmark));
    expect(after.scenarios.some(item => item.benchmark?.kg_per_cycle === 99)).toBe(false);
    await expectPriorEvidence(page, original);
    await disclose(site(page), "Conditional output benchmark");
    await site(page).getByRole("button", { name: "Create revised benchmark assumption", exact: true }).click();
    await expect(pendingBenchmark(page).getByRole("checkbox")).not.toBeChecked();
    await expect(pendingBenchmark(page).getByRole("button", { name: "Save benchmark assumption", exact: true })).toBeDisabled();
    expect(network.comparisons).toBe(1);
  });
}

// Re-sealing makes the injected response structurally valid: rejection must be request correlation,
// not a deliberately broken digest. This is test-only fault injection, never numerical evidence.
function seal(artifact: SiteComparisonArtifact): SiteComparisonArtifact {
  artifact.canonical_json = JSON.stringify(artifact.payload);
  artifact.sha256 = createHash("sha256").update(artifact.canonical_json, "utf8").digest("hex");
  return artifact;
}
for (const mismatch of ["inputs", "parent", "comparison review", "evaluation review"] as const) {
  test(`a valid artifact with mismatched ${mismatch} is rejected without writes or replacement of prior evidence`, async ({ page, network }) => {
    const original = await baseline(page);
    await editCurrent(page);
    if (mismatch === "inputs") await field(page, "Lighting schedule", "17");
    await site(page).getByRole("checkbox", { name: "Site plan review", exact: true }).check();
    await expect.poll(async () => !!(await store(page)).working?.review).toBe(true);
    await saved(page);
    const before = await store(page), raw = await rawStore(page);
    const wrong = structuredClone(original);
    if (mismatch === "parent") wrong.payload.parent_id = "test-only-wrong-parent";
    if (mismatch === "comparison review") wrong.payload.review_status = "unreviewed";
    if (mismatch === "evaluation review") wrong.payload.evaluations[0].review_status = "unreviewed";
    seal(wrong);
    expect(await validateSiteComparisonArtifact(wrong)).toMatchObject({ ok: true });
    let intercepted: SiteComparisonRequest | null = null;
    await page.route("**/api/site-comparisons", route => {
      intercepted = route.request().postDataJSON() as SiteComparisonRequest;
      return route.fulfill({ status: 200, json: wrong });
    });
    await auditWrites(page);
    await site(page).getByRole("button", { name: "Compare reviewed plans", exact: true }).click();
    await expect(site(page).getByRole("alert")).toContainText("Returned comparison does not match the submitted inputs, review or parent run.");
    await expect(site(page).getByRole("alert")).toContainText("No new evidence was saved");
    await expect(site(page).getByRole("button", { name: "Compare reviewed plans", exact: true })).toBeEnabled();
    expect(intercepted).not.toBeNull();
    expect(intercepted).toMatchObject({ prior_comparison_id: null, review: { snapshot_json: expect.any(String) } });
    if (mismatch === "inputs") {
      expect(intercepted!.scenarios[0].lighting.hours_per_day).toBe(17);
      expect(wrong.payload.input_snapshot.scenarios[0].lighting.hours_per_day).toBe(16);
    }
    expect(await rawStore(page)).toBe(raw);
    expect(await store(page)).toEqual(before);
    expect(await writes(page)).toEqual([]);
    await expectPriorEvidence(page, original);
    await expect(results(page)).toHaveAttribute("data-comparison-id", original.payload.id);
    await expect(site(page).locator(".site-notice")).toHaveCount(0);
    expect(await exportJson(page)).toEqual(original);
    expect(await writes(page)).toEqual([]);
    expect(network.comparisons).toBe(2);
  });
}

test("reading exact-run details, local verification and exports never writes working inputs or saved artifacts", async ({ page, network }) => {
  const original = await baseline(page);
  const before = await store(page), raw = await rawStore(page);
  const earthBefore = await page.evaluate(key => localStorage.getItem(key), earthKey);
  let verificationCalls = 0;
  await page.route("**/api/site-comparisons/verify", route => {
    verificationCalls++;
    expect(route.request().postDataJSON()).toEqual({ comparison_id: original.payload.id, sha256: original.sha256 });
    return route.fulfill({ status: 503, json: { detail: "TEST ONLY: local verification unavailable; saved evidence remains readable." } });
  });
  await auditWrites(page);
  const explanation = site(page).getByRole("region", { name: "Why this site result?", exact: true });
  await expect(explanation).toHaveAttribute("data-evaluation-id", original.payload.evaluations[0].id);
  for (const name of ["Constraint outcomes", "Energy and cash ledgers", "Benchmark applicability", "Formulas and exact-run evidence", "Missing inputs and limitations"]) await disclose(explanation, name);
  await expect(explanation).toContainText(original.payload.evaluations[0].explanation);
  await expect(explanation.locator(".site-identities")).toContainText(original.sha256);
  expect(await exportJson(page)).toEqual(original);
  await site(page).getByRole("button", { name: "Check local server copy", exact: true }).click();
  await expect(site(page).locator(".site-verification")).toContainText("offline");
  await expect(site(page).locator(".site-verification")).toContainText("TEST ONLY: local verification unavailable");
  expect(await exportJson(page)).toEqual(original);
  expect(verificationCalls).toBe(1);
  expect(network.comparisons).toBe(1);
  expect(await writes(page)).toEqual([]);
  expect(await rawStore(page)).toBe(raw);
  expect(await store(page)).toEqual(before);
  expect(await page.evaluate(key => localStorage.getItem(key), earthKey)).toBe(earthBefore);
  await expectPriorEvidence(page, original);
});
