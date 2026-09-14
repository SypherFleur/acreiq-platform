import { readFileSync } from "node:fs";
import { expect, test, enterMeasurements, measurementConfirmation, type Page } from "./test-support";
import type { OptimizationResult } from "../lib/types";
import { appendRun, restoreDesign, type SavedRun } from "../lib/run-history";
import { SAMPLE_SCENARIO, SAMPLE_ASSETS } from "../lib/sample";

const why = (page: Page) => page.getByRole("region", { name: "Why this result?", exact: true });
const working = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("acreiq.workspace.v1")!));
const field = async (page: Page, name: string, value: string) => {
  const input = page.getByRole("spinbutton", { name, exact: true });
  await input.fill(value); await input.blur();
};
async function simulate(page: Page, name = "Simulate this sample") {
  const response = page.waitForResponse(r => r.url().endsWith("/api/optimize"));
  await page.getByRole("button", { name, exact: true }).first().click();
  const reply = await response;
  expect(reply.status()).toBe(200);
  const result = await reply.json() as OptimizationResult;
  await expect(why(page)).toHaveAttribute("data-run-id", result.run!.id);
  return result;
}
async function jsonDownload(page: Page, name: string) {
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name, exact: true }).click();
  return JSON.parse(readFileSync((await (await download).path())!, "utf8"));
}

test("history never evicts old or important records and duplicate identity preserves importance", () => {
  const entries = Array.from({ length: 30 }, (_, i) => ({ id: String(i), important: i === 29 } as SavedRun));
  expect(appendRun(entries, { id: "new" } as SavedRun)).toHaveLength(31);
  expect(appendRun(entries, { id: "29" } as SavedRun)).toHaveLength(30);
  expect(appendRun(entries, { id: "29" } as SavedRun)[0].important).toBe(true);
});

test("13 real runs retain important history; inspection and reload never overwrite working inputs", async ({ page }, info) => {
  test.setTimeout(180000);
  await page.goto("/");
  const first = await simulate(page);
  await page.getByRole("button", { name: "Scenarios", exact: true }).click();
  await page.getByRole("button", { name: "Mark important run", exact: true }).click();
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  let last = first;
  for (let i = 0; i < 12; i++) {
    await field(page, "Current schedule", String(12 + i / 4));
    last = await simulate(page);
  }
  const accepted = (await working(page)).scenario;
  await page.getByRole("button", { name: "Scenarios", exact: true }).click();
  await expect(page.locator(".history-row")).toHaveCount(13);
  const original = page.locator(`.history-entry[data-run-id="${first.run!.id}"]`);
  await expect(original.getByRole("button", { name: "Unmark important run" })).toBeVisible();
  const backup = await jsonDownload(page, "Export local history");
  expect(backup.history).toHaveLength(13);
  expect(backup.history.find((run: SavedRun) => run.id === first.run!.id).important).toBe(true);
  await original.locator(".history-row").click();
  expect((await working(page)).scenario).toEqual(accepted);
  const exported = await jsonDownload(page, "JSON");
  expect(exported.result).toEqual(first);
  expect(exported.scenario.baseline_hours).toBe(16);
  await page.reload();
  await expect(page.locator(".history-row")).toHaveCount(13);
  expect((await working(page)).accepted_result_id).toBe(last.run!.id);
  expect((await working(page)).scenario).toEqual(accepted);
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(why(page)).toHaveAttribute("data-run-id", first.run!.id);
  await expect(page.getByRole("spinbutton", { name: "Current schedule", exact: true })).toHaveValue("16");
  await expect(page.getByRole("spinbutton", { name: "Current schedule", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Proposed state", exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath("historical-inspection.png"), fullPage: true });
  await page.getByRole("button", { name: "Return to working space", exact: true }).click();
  await expect(why(page)).toHaveAttribute("data-run-id", last.run!.id);
  await expect(page.getByRole("spinbutton", { name: "Current schedule", exact: true })).toHaveValue(String(accepted.baseline_hours));
  await expect(page.getByRole("spinbutton", { name: "Current schedule", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test("reload restores active comparison and legacy evidence but never resurrects invalidated calculations", async ({ page }) => {
  await page.goto("/");
  const result = await simulate(page);
  await page.reload();
  await expect(why(page)).toHaveAttribute("data-run-id", result.run!.id);
  await expect(why(page)).toContainText("Current result");
  await expect(page.getByRole("button", { name: "Proposed state", exact: true })).toBeEnabled();
  // Migrate a real previous-format local record, not a mocked numerical response.
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("acreiq.workspace.v1")!);
    for (const key of ["accepted_result_id", "working_revision", "accepted_revision", "view", "mode", "inspected_run_id"]) delete saved[key];
    localStorage.setItem("acreiq.workspace.v1", JSON.stringify(saved));
  });
  await page.reload();
  await expect(page.getByRole("button", { name: "Proposed state", exact: true })).toBeEnabled();
  await field(page, "Current schedule", "15");
  await page.reload();
  await expect(page.getByRole("spinbutton", { name: "Current schedule", exact: true })).toHaveValue("15");
  await expect(page.getByRole("button", { name: "Proposed state", exact: true })).toBeDisabled();
  await expect(why(page)).toContainText("Earlier result: original inputs");
  const evidence = await jsonDownload(page, "Export run evidence");
  expect(evidence.input_snapshot.baseline_hours).toBe(16);
});

test("candidate IDs and original-input CSV survive filters, reload and export", async ({ page }, info) => {
  await page.goto("/");
  const result = await simulate(page);
  await page.getByRole("button", { name: "Scenarios", exact: true }).click();
  const selected = page.locator("tr.best-row");
  const candidate = await selected.getAttribute("data-candidate-id");
  expect(candidate).toBe("h12-d1");
  await page.getByRole("button", { name: "All tested", exact: true }).click();
  await expect(selected).toHaveAttribute("data-candidate-id", candidate!);
  await page.reload();
  await expect(selected).toHaveAttribute("data-candidate-id", candidate!);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV", exact: true }).click();
  const csvFile = await download; await csvFile.saveAs(info.outputPath("traceable-run.csv"));
  const csv = readFileSync((await csvFile.path())!, "utf8");
  for (const text of [result.run!.id, result.run!.created_at, result.model_version, "ppfd_full", "lighting_watts", "electricity_usd_kwh", "operating_days", "h12-d1", "Baseline minus selected", "complete JSON remains canonical"]) expect(csv).toContain(text);
  const exported = await jsonDownload(page, "JSON");
  expect(exported.result).toEqual(result);
  expect(exported.candidate_identity.selected_candidate_id).toBe(candidate);
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await why(page).getByText("Selection and alternatives", { exact: true }).click();
  await expect(why(page)).toContainText(candidate!);
  await page.screenshot({ path: info.outputPath("traceable-evidence.png"), fullPage: true });
});

test("zero change and additional consumption are literal in workspace, impact and saved evidence", async ({ page }, info) => {
  await page.goto("/");
  await field(page, "Current schedule", "12");
  const equal = await simulate(page);
  expect(equal.run!.evidence.summary).toContain("no operating change is proposed");
  await expect(page.getByRole("heading", { name: "Current setting retained.", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Impact", exact: true }).click();
  await expect(page.locator(".impact-lead")).toContainText("No modeled electricity change.");
  await expect(page.locator(".impact-lead")).not.toContainText("An operating change");
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await field(page, "Current schedule", "10");
  const more = await simulate(page);
  expect(more.savings?.period_energy_kwh).toBe(-438);
  await expect(page.locator(".metrics-row")).toContainText("additional cost");
  await page.getByRole("button", { name: "Impact", exact: true }).click();
  await expect(page.locator(".impact-stats")).toContainText("438");
  await expect(page.locator(".impact-stats")).not.toContainText("-438");
  await expect(page.locator(".impact-stats")).toContainText("additional electricity required");
  await expect(page.locator(".impact-stats")).toContainText("additional electricity cost");
  await page.screenshot({ path: info.outputPath("additional-consumption.png"), fullPage: true });
});

test("PPFD units and optional user-recorded provenance never promote review into verification", async ({ page }, info) => {
  await page.goto("/");
  await expect(page.getByTestId("ppfd-origin")).toContainText("synthetic sample assumption");
  await page.getByRole("button", { name: "Workspace settings", exact: true }).click();
  await page.getByRole("button", { name: "Start manually", exact: true }).click();
  await page.getByRole("button", { name: "Inventory 0", exact: true }).click();
  await page.getByRole("button", { name: "Add equipment", exact: true }).first().click();
  await page.getByRole("button", { name: "LED grow light", exact: true }).click();
  await enterMeasurements(page);
  await expect(page.getByRole("spinbutton", { name: "Full-output PPFD", exact: true }).locator("..")).toContainText("umol/m2/s");
  await expect(page.getByTestId("ppfd-origin")).toContainText("user-entered");
  await measurementConfirmation(page).check();
  await expect(page.getByTestId("ppfd-origin")).toContainText("no measurement record");
  await page.getByText("PPFD record (optional)", { exact: true }).click();
  await page.getByLabel("Measurement date", { exact: true }).fill("2026-09-13");
  await page.getByLabel("Method / instrument", { exact: true }).fill("TEST ONLY - synthetic meter record");
  await page.getByLabel("Note (optional)", { exact: true }).fill("Synthetic browser acceptance fixture; not real site data.");
  await page.getByRole("button", { name: "Save record", exact: true }).click();
  await expect(measurementConfirmation(page)).not.toBeChecked();
  await expect(page.getByTestId("ppfd-origin")).toContainText("user-recorded measurement; not independently verified");
  await measurementConfirmation(page).check();
  const result = await simulate(page, "Run simulation");
  const evidence = await jsonDownload(page, "Export run evidence");
  expect(evidence.input_records.ppfd_full.value).toBe(400);
  await field(page, "Length", "13");
  await expect(page.getByTestId("ppfd-origin")).toContainText("user-entered");
  await expect(measurementConfirmation(page)).not.toBeChecked();
  await expect(why(page)).toHaveAttribute("data-run-id", result.run!.id);
  const earlier = await jsonDownload(page, "Export run evidence");
  expect(earlier.input_records).toEqual(evidence.input_records);
  expect(earlier.input_snapshot.length_ft).toBe(12);
  await page.screenshot({ path: info.outputPath("record-provenance.png"), fullPage: true });
  await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("acreiq.workspace.v1")!);
    saved.history[0].inputRecords.ppfd_full.value = 350;
    localStorage.setItem("acreiq.workspace.v1", JSON.stringify(saved));
  });
  await page.reload();
  const stale = await jsonDownload(page, "Export run evidence");
  expect(stale.input_records).toEqual({});
  expect(stale.input_record_status).toBe("invalid_or_stale_excluded");
  expect(stale.unvalidated_input_records.ppfd_full.value).toBe(350);
  expect(stale.input_snapshot.ppfd_full).toBe(400);
});

test("storage write failure preserves the prior copy and exposes a complete session export", async ({ page }) => {
  await page.goto("/"); await simulate(page);
  const original = await working(page);
  await page.evaluate(() => {
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === "acreiq.workspace.v1") throw new DOMException("Audit injected quota failure", "QuotaExceededError");
      return write.call(this, key, value);
    };
  });
  await field(page, "Current schedule", "15"); await simulate(page);
  await expect(page.getByRole("alert").filter({ hasText: "Browser storage is full or unavailable" })).toBeVisible();
  await expect(why(page)).toContainText("Local run evidence");
  await expect(why(page)).not.toContainText("Browser-saved");
  expect(await working(page)).toEqual(original);
  const backup = await jsonDownload(page, "Export local history");
  expect(backup.history).toHaveLength(2);
  expect(backup.workspace.scenario.baseline_hours).toBe(15);
});

test("restoring mismatched run evidence never overwrites accepted inputs", () => {
  const workspace = { scenario: { ...SAMPLE_SCENARIO }, assets: structuredClone(SAMPLE_ASSETS), crop: null, result: null };
  const state = restoreDesign(workspace, null, [], null, 4, 3);
  expect(state.accepted.scenario).toEqual(workspace.scenario);
  expect(state.accepted.result).toBeNull();
  expect(state.revision).toBe(4);
});

test("unreadable existing storage is preserved instead of overwritten by a fresh sample", async ({ page }) => {
  await page.goto("/"); await simulate(page);
  const prior = await working(page);
  const partiallyUnreadable = { ...prior, history: [...prior.history, { id: "legacy-unreadable", private_note: "synthetic preservation fixture" }] };
  const original = JSON.stringify(partiallyUnreadable);
  await page.evaluate(value => localStorage.setItem("acreiq.workspace.v1", value), original);
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "Some saved records could not be read" })).toBeVisible();
  await field(page, "Current schedule", "15");
  expect(await page.evaluate(() => localStorage.getItem("acreiq.workspace.v1"))).toBe(original);
  await page.evaluate(() => localStorage.setItem("acreiq.workspace.v1", "{unreadable-test"));
  await page.reload();
  await expect(page.getByRole("alert").filter({ hasText: "Saved browser data could not be read" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("acreiq.workspace.v1"))).toBe("{unreadable-test");
});

test("reload binds accepted comparison, evidence and exports when a newer unadopted run exists", async ({ page }) => {
  await page.goto("/");
  const accepted = await simulate(page);
  const acceptedWorkspace = await working(page);
  await field(page, "Current schedule", "15");
  const proposed = await simulate(page);
  // Seed the previous persisted shape after an unadopted calculation using two actual engine runs.
  await page.evaluate(({ acceptedWorkspace, acceptedId, proposedId }) => {
    const saved = JSON.parse(localStorage.getItem("acreiq.workspace.v1")!);
    saved.scenario = acceptedWorkspace.scenario;
    saved.assets = acceptedWorkspace.assets;
    saved.accepted_revision = acceptedWorkspace.accepted_revision;
    saved.accepted_result_id = acceptedId;
    saved.saved_run.reference.proposal_id = "synthetic-unadopted-proposal";
    saved.saved_run.reference.proposal_version = 1;
    saved.history.find((run: { id: string }) => run.id === proposedId).reference = saved.saved_run.reference;
    localStorage.setItem("acreiq.workspace.v1", JSON.stringify(saved));
  }, { acceptedWorkspace, acceptedId: accepted.run!.id, proposedId: proposed.run!.id });
  await page.reload();
  await expect(why(page)).toHaveAttribute("data-run-id", accepted.run!.id);
  await expect(page.getByRole("spinbutton", { name: "Current schedule", exact: true })).toHaveValue("16");
  const evidence = await jsonDownload(page, "Export run evidence");
  expect(evidence.id).toBe(accepted.run!.id);
  expect(evidence.workspace_version.id).toBe(accepted.run!.id);
  await page.getByRole("button", { name: "Scenarios", exact: true }).click();
  const report = await jsonDownload(page, "JSON");
  expect(report.result).toEqual(accepted);
  expect(report.run_reference.id).toBe(accepted.run!.id);
  expect((await working(page)).history).toHaveLength(2);
  await page.locator(`.history-entry[data-run-id="${proposed.run!.id}"] .history-row`).click();
  const proposalReport = await jsonDownload(page, "JSON");
  expect(proposalReport.result).toEqual(proposed);
  expect((await working(page)).scenario.baseline_hours).toBe(16);
});
