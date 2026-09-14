import { expect, test as base, type Page } from "@playwright/test";
import type { ScanResult, Scenario, TwinAsset } from "../lib/types";

export { expect };
export type { Page };

// Every photo test must opt into a mock; no browser upload can reach a provider.
export const test = base.extend({
  reducedMotion: "reduce",
  page: async ({ page }, use) => {
    await page.route("**/api/scan", (route) => route.abort("blockedbyclient"));
    await page.route("**/api/live/**", (route) => route.abort("blockedbyclient"));
    await use(page);
  },
});

export const TEST_IMAGE = {
  name: "test-grow-space.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
};

export const MANUAL_SCAN: ScanResult = {
  source: "manual",
  assets: [],
  observations: [],
  warnings: [
    "Photo analysis is unavailable: no vision provider is configured. This photo was not scanned. Enter assets manually.",
  ],
};

export const AI_SCAN: ScanResult = {
  source: "gemini",
  assets: [
    {
      id: "test-light",
      name: "LED grow light",
      type: "light_fixture",
      quantity: 3,
      confidence: null,
      confirmed: false,
    },
    {
      id: "test-fan",
      name: "Circulation fan",
      type: "circulation_fan",
      quantity: 2,
      confidence: 0.63,
      confirmed: false,
    },
  ],
  observations: ["Lighting equipment may be visible above the growing area."],
  warnings: [
    "AI inventory suggestions may be wrong or incomplete. Confirm every item and quantity manually.",
    "No dimensions, wattage, PPFD, DLI, water use, yield, or electrical capacity were measured from the photo.",
  ],
};

export async function mockHealth(
  page: Page,
  provider: "manual" | "gemini" | "vertex" = "manual",
  available = provider !== "manual",
) {
  await page.route("**/api/health", (route) =>
    route.fulfill({
      json: {
        status: "ok",
        service: "acreiq-api",
        vision_available: available,
        vision_provider: provider,
        model_version: "test-health-contract",
      },
    }),
  );
}

export async function mockScan(page: Page, result: ScanResult) {
  await page.route("**/api/scan", (route) => route.fulfill({ json: result }));
}

export async function uploadPhoto(page: Page) {
  const response = page.waitForResponse((r) => r.url().endsWith("/api/scan"));
  await page.locator('input[type="file"]:not([capture])').setInputFiles(TEST_IMAGE);
  return response;
}

export function measurementConfirmation(page: Page) {
  return page.getByRole("checkbox", {
    name: "I reviewed the inventory and entered inputs.",
    exact: true,
  });
}

export async function persistedWorkspace(page: Page): Promise<{
  scenario: Scenario;
  assets: TwinAsset[];
  [key: string]: unknown;
}> {
  return page.evaluate(() =>
    JSON.parse(localStorage.getItem("acreiq.workspace.v1") || "null"),
  );
}

// Proposal previews advance version/navigation metadata, not accepted content.
// Read-only actions use persistedWorkspace to assert the entire record is unchanged.
export async function savedWorkspace(page: Page) {
  const { working_revision, accepted_revision, accepted_result_id, inspected_run_id, view, mode, ...accepted } = await persistedWorkspace(page);
  return accepted;
}

const measurementFields = [
  ["Length", "0", "12"],
  ["Width", "0", "10"],
  ["Canopy area", "0", "48"],
  ["Power ceiling", "0", "1500"],
  ["Total light load", "0", "420"],
  ["Current schedule", "0", "14"],
  ["Full-output PPFD", "", "400"],
  ["Minimum DLI", "", "14"],
  ["Minimum schedule", "0", "9"],
  ["Maximum schedule", "0", "17"],
  ["Other loads", "0", "30"],
  ["Other load schedule", "0", "12"],
  ["Electricity rate", "0", "0.22"],
  ["Operating period", "0", "47"],
  ["Measured water use", "", "7"],
] as const;

async function openMeasurements(page: Page) {
  await page.getByRole("button", { name: "Inputs", exact: true }).click();
  const assumptions = page.locator("details.advanced");
  if ((await assumptions.getAttribute("open")) === null) {
    await assumptions.locator("summary").click();
  }
}

export async function expectFreshMeasurements(page: Page) {
  await openMeasurements(page);
  for (const [label, empty] of measurementFields) {
    await expect(page.getByRole("spinbutton", { name: label, exact: true })).toHaveValue(empty);
  }
  await expect(measurementConfirmation(page)).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Proposed state", exact: true })).toBeDisabled();
  await expect(page.locator(".sample-notice")).toHaveCount(0);
}

export async function enterMeasurements(page: Page) {
  await openMeasurements(page);
  for (const [label, , value] of measurementFields) {
    const field = page.getByRole("spinbutton", { name: label, exact: true });
    await field.fill(value);
    await field.blur();
  }
}
