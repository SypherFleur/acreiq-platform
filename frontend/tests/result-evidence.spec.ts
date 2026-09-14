import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, persistedWorkspace } from "./test-support";
import type { OptimizationResult } from "../lib/types";

test("numerical evidence disclosures and export retain the exact run without changing workspace state", async ({ page }, info) => {
  await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.abort());
  await page.goto("/");
  const response = page.waitForResponse(value => value.url().endsWith("/api/optimize"));
  await page.getByRole("button", { name: "Simulate this sample", exact: true }).first().click();
  const result = await (await response).json() as OptimizationResult;
  expect(result.run?.input_snapshot.confirmed).toBe(true);
  const why = page.getByRole("region", { name: "Why this result?", exact: true });
  await expect(why).toHaveAttribute("data-run-id", result.run!.id);
  const before = await persistedWorkspace(page);
  await why.locator("summary").filter({ hasText: "Inputs and units" }).click();
  const inputs = why.getByRole("region", { name: "Recorded inputs and units", exact: true });
  await expect(inputs.getByRole("row").filter({ has: page.locator("th code", { hasText: /^ppfd_full$/ }) })).toContainText("350");
  await expect(inputs.getByRole("row").filter({ has: page.locator("th code", { hasText: /^operating_days$/ }) })).toContainText("365");
  await why.locator("summary").filter({ hasText: "Inputs and units" }).click();
  await why.locator("summary").filter({ hasText: "Calculations" }).click();
  for (const formula of result.run!.evidence.formulas) {
    await expect(why.locator(".why-result-calculation code").filter({ hasText: formula.substituted }).first()).toHaveText(formula.substituted);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await why.locator("summary").filter({ hasText: "Calculations" }).click();
  await why.locator("summary").filter({ hasText: "Selection and alternatives" }).click();
  await expect(why.locator(".why-result-counts")).toContainText("Evaluated33");
  await expect(why.locator(".why-result-counts")).toContainText("Feasible25");
  await expect(why.getByRole("region", { name: "Actual alternatives", exact: true })).toContainText("minimum_dli");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await why.locator("summary").filter({ hasText: "Selection and alternatives" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join("..", ".acreiq-local/screenshots", `explanation-alternatives-${info.project.name}.png`) });
  const download = page.waitForEvent("download");
  await why.getByRole("button", { name: "Export run evidence", exact: true }).click();
  const file = await download;
  const exported = JSON.parse(readFileSync((await file.path())!, "utf8"));
  const { workspace_version, candidate_identity, input_records, input_record_status, server_verification, ...artifact } = exported;
  expect(artifact).toEqual(result.run);
  expect(candidate_identity.run_id).toBe(result.run!.id);
  expect(input_records).toEqual({});
  expect(input_record_status).toBe("not_provided");
  expect(server_verification).toBe("not_checked");
  expect(workspace_version.id).toBe(result.run!.id);
  expect(await persistedWorkspace(page)).toEqual(before);
});
