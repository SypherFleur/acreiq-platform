// Explicit, billable Google Maps probe. Optional public-address lookup; no cloud setup.
const { chromium, expect } = require("../frontend/node_modules/@playwright/test");
const { mkdirSync, writeFileSync, readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const path = require("node:path");

const origin = process.env.ACREIQ_TEST_URL || "http://127.0.0.1:3007";
if (!["127.0.0.1", "localhost"].includes(new URL(origin).hostname)) throw new Error("Local preview required");
const addressLookup = process.env.ACREIQ_TEST_ADDRESS_LOOKUP === "1";
const buildDirectory = process.env.ACREIQ_TEST_BUILD_DIR || ".next-earth-maps";
if (!/^\.next-[a-z-]+$/.test(buildDirectory)) throw new Error("Isolated build directory required");
const output = path.join(__dirname, addressLookup ? "../.acreiq-local/earth-address-google" : "../.acreiq-local/earth-google");
mkdirSync(output, { recursive: true });
const evidence = { checked_at: new Date().toISOString(), origin, provider: "actual Google Maps JavaScript API", success: false, errors: [], network_errors: [], tile_responses: 0, phases: [] };
let browser;
const phase = name => { evidence.phase = name; evidence.phases.push(name); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

async function context(options) {
  const ctx = await browser.newContext(options);
  await ctx.routeWebSocket(/.*/, ws => ws.close());
  await ctx.route("**/*", route => {
    const host = new URL(route.request().url()).hostname;
    if (host === new URL(origin).hostname || host.endsWith(".googleapis.com") || host.endsWith(".gstatic.com") || host.endsWith(".google.com") || host === "google.com") return route.continue();
    return route.abort();
  });
  return ctx;
}
function observe(page) {
  page.setDefaultTimeout(20000);
  page.on("console", message => {
    const code = message.text().match(/Google Maps JavaScript API (?:error|warning): ([A-Za-z0-9]+)/)?.[1];
    if (code && !evidence.errors.includes(code)) evidence.errors.push(code);
  });
  page.on("requestfailed", request => {
    const host = new URL(request.url()).hostname;
    if (host.includes("google")) evidence.network_errors.push({ host, code: request.failure()?.errorText });
  });
  page.on("response", response => {
    const url = new URL(response.url());
    if (url.hostname.includes("google") && /\/(kh|vt|maps\/vt)(?:\/|$)/.test(url.pathname) && response.ok()) evidence.tile_responses++;
  });
}
async function enter(page) {
  await page.getByRole("button", { name: "AcreIQ Earth", exact: true }).click();
  await page.getByRole("region", { name: "AcreIQ Earth", exact: true }).waitFor();
}
async function load(page, label) {
  const loadButton = page.getByRole("button", { name: "Load Google imagery", exact: true });
  if (await loadButton.isVisible()) await loadButton.click();
  await expect.poll(() => page.locator(".earth-status").innerText(), { timeout: 25000 }).toMatch(/^(Google imagery loaded|Maps authorization failed|Google imagery unavailable)$/);
  await page.screenshot({ path: path.join(output, `${label}-initial.png`), fullPage: true });
  evidence[`${label}_status`] = await page.locator(".earth-status").innerText();
  if (evidence[`${label}_status`] !== "Google imagery loaded" || evidence.errors.length) throw new Error("Maps load did not succeed");
  await expect.poll(() => page.locator(".earth-google-map img").evaluateAll(images => images.filter(image => image.complete && image.naturalWidth >= 128).length), { timeout: 20000 }).toBeGreaterThan(0);
}
async function screenshot(page, label) {
  await page.locator(".earth-google-map").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, `${label}.png`), fullPage: true });
  return hash(await page.locator(".earth-google-map").screenshot());
}

(async () => {
  try {
    phase("launch");
    evidence.build_id = readFileSync(path.join(__dirname, "../frontend", buildDirectory, "BUILD_ID"), "utf8").trim();
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--use-angle=d3d11", "--mute-audio"] });
    const desktop = await context({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    const page = await desktop.newPage(); observe(page);
    phase("existing synthetic comparison");
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Compare site plans", exact: true }).click();
    await page.getByRole("button", { name: "Load A/B/C synthetic fixture", exact: true }).click();
    await page.getByRole("checkbox", { name: "Site plan review", exact: true }).check();
    const calculation = page.waitForResponse(r => r.url().endsWith("/api/site-comparisons") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Compare reviewed plans", exact: true }).click();
    const run = await (await calculation).json();
    evidence.run_id = run.payload.id; evidence.site_id = run.payload.input_snapshot.site.id;
    await page.locator(`[data-comparison-id="${evidence.run_id}"]`).waitFor();
    const before = await page.evaluate(() => JSON.parse(localStorage.getItem("acreiq.site-comparisons.v2")));
    let recalculations = 0;
    page.on("request", r => { if (r.method() === "POST" && /\/(optimize|site-comparisons)$/.test(r.url())) recalculations++; });
    await enter(page);
    if (addressLookup) {
      phase("desktop public address lookup");
      await expect(page.getByRole("textbox", { name: "Latitude", exact: true })).toBeHidden();
      await page.getByRole("textbox", { name: "Address", exact: true }).fill("1600 Amphitheatre Parkway, Mountain View, CA");
      await page.getByRole("button", { name: "Find address", exact: true }).click();
      await expect(page.getByRole("button", { name: "Find address", exact: true })).toBeEnabled({ timeout: 25000 });
      const error = page.locator(".earth-address-search .earth-error");
      if (await error.isVisible()) {
        evidence.address_lookup = { success: false, sanitized_error: await error.innerText() };
      } else {
        const choices = page.locator(".earth-address-result");
        if (await choices.count()) await choices.first().click();
        await expect(page.locator(".earth-address-feedback").filter({ hasText: "1600 Amphitheatre" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Associate selected location", exact: true })).toBeDisabled();
        await expect(page.getByRole("textbox", { name: "Latitude", exact: true })).toHaveValue("");
        evidence.address_lookup = { success: true, public_address: "1600 Amphitheatre Parkway, Mountain View, CA", area_only_before_user_pin: true };
      }
      await page.screenshot({ path: path.join(output, "desktop-address-result.png"), fullPage: true });
      expect(await page.evaluate(() => localStorage.getItem("acreiq.site-comparisons.v2"))).not.toContain("Amphitheatre");
    }
    if (!evidence.address_lookup?.success) {
      await page.locator(".earth-precise > summary").click();
      await page.getByRole("textbox", { name: "Latitude", exact: true }).fill("37.42");
      await page.getByRole("textbox", { name: "Longitude", exact: true }).fill("-122.09");
      await page.getByRole("button", { name: "Select coordinates", exact: true }).click();
    }
    phase("desktop actual satellite");
    await load(page, "desktop");
    const satellite = await screenshot(page, "desktop-satellite");
    phase("desktop hybrid");
    await page.getByRole("button", { name: "Hybrid", exact: true }).click();
    await expect(page.getByRole("button", { name: "Hybrid", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => hash(await page.locator(".earth-google-map").screenshot())).not.toBe(satellite);
    evidence.hybrid_changed_pixels = true;
    await screenshot(page, "desktop-hybrid");
    phase("desktop native pan and zoom");
    const map = page.locator(".earth-google-map");
    const beforePan = hash(await map.screenshot());
    const box = await map.boundingBox();
    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.4);
    await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.35 + 100, box.y + box.height * 0.4 + 50, { steps: 15 }); await page.mouse.up();
    await expect.poll(async () => hash(await map.screenshot())).not.toBe(beforePan);
    evidence.pan_changed_pixels = true;
    await map.getByRole("button", { name: "Zoom in", exact: true }).click();
    evidence.native_zoom_clicked = true;
    phase("desktop pin and association");
    await map.click({ position: { x: 100, y: 120 } });
    await expect(page.getByRole("textbox", { name: "Latitude", exact: true })).not.toHaveValue("");
    await expect(page.getByRole("textbox", { name: "Latitude", exact: true })).not.toHaveValue("37.42");
    await page.getByRole("button", { name: "Associate selected location", exact: true }).click();
    await page.getByRole("button", { name: "Clear selected location", exact: true }).click();
    await page.getByRole("button", { name: "Location for Synthetic growing bay", exact: true }).click();
    await expect(page.locator(".earth-selected")).toContainText("Matches this site's associated location");
    await screenshot(page, "desktop-associated");
    evidence.google_attribution_links = await map.locator('a[href*="google"]').count();
    evidence.desktop_no_horizontal_overflow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
    await page.getByRole("button", { name: "Open site comparison", exact: true }).click();
    await page.locator(`[data-comparison-id="${evidence.run_id}"]`).waitFor();
    const after = await page.evaluate(() => JSON.parse(localStorage.getItem("acreiq.site-comparisons.v2")));
    expect(after.working).toEqual(before.working); expect(after.history).toEqual(before.history); expect(recalculations).toBe(0);
    evidence.exact_history_preserved = true; evidence.map_triggered_calculations = recalculations;
    await enter(page);
    phase("mobile actual satellite and saved pin");
    const phone = await context({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, storageState: await desktop.storageState() });
    const mobile = await phone.newPage(); observe(mobile);
    await mobile.goto(origin, { waitUntil: "domcontentloaded" });
    await expect(mobile.getByRole("textbox", { name: "Address", exact: true })).toBeVisible();
    await expect(mobile.getByRole("textbox", { name: "Latitude", exact: true })).toBeHidden();
    await mobile.getByRole("button", { name: "Go to saved pin", exact: true }).click();
    await load(mobile, "mobile");
    const mobileSatellite = await screenshot(mobile, "mobile-satellite");
    await mobile.getByRole("button", { name: "Hybrid", exact: true }).click();
    await expect(mobile.getByRole("button", { name: "Hybrid", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => hash(await mobile.locator(".earth-google-map").screenshot())).not.toBe(mobileSatellite);
    evidence.mobile_hybrid_changed_pixels = true;
    await screenshot(mobile, "mobile-hybrid");
    evidence.mobile_no_horizontal_overflow = await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
    await mobile.getByRole("button", { name: "Clear selected location", exact: true }).click();
    await mobile.getByRole("button", { name: "Location for Synthetic growing bay", exact: true }).tap();
    await expect(mobile.locator(".earth-selected")).toContainText("Matches this site's associated location");
    await mobile.getByRole("button", { name: "Open site comparison", exact: true }).click();
    await mobile.locator(`[data-comparison-id="${evidence.run_id}"]`).waitFor();
    const mobileStore = await mobile.evaluate(() => JSON.parse(localStorage.getItem("acreiq.site-comparisons.v2")));
    expect(mobileStore.working).toEqual(before.working); expect(mobileStore.history).toEqual(before.history);
    evidence.mobile_exact_comparison = true;
    expect(evidence.tile_responses).toBeGreaterThan(0);
    expect(evidence.errors).toEqual([]);
    phase("complete"); evidence.maps_success = true;
    evidence.success = !addressLookup || evidence.address_lookup?.success === true;
  } catch (error) {
    evidence.exception_type = error.name;
    // Raw Playwright/SDK errors can include the key-bearing script URL.
  } finally {
    await browser?.close();
    writeFileSync(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
    console.log(JSON.stringify(evidence, null, 2));
    if (!evidence.success) process.exitCode = 1;
  }
})();
