// One explicit public-address lookup through the real preview and Google SDK.
// The SDK callback is observed, not mocked. No cloud writes or Gemini calls.
const { chromium, expect } = require("../frontend/node_modules/@playwright/test");
const { readFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const origin = "http://127.0.0.1:3007";
const address = "1600 Amphitheatre Parkway, Mountain View, CA";
const resumePath = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (resumePath && !resumePath.startsWith(path.join(root, ".acreiq-local/earth-address-authorized") + path.sep)) throw new Error("Existing local address evidence required");
const resumed = resumePath ? JSON.parse(readFileSync(resumePath, "utf8")) : null;
if (resumed && (resumed.google_geocoding_status !== "OK" || resumed.address !== address || !Number.isFinite(resumed.returned_location?.lat) || !Number.isFinite(resumed.returned_location?.lng))) throw new Error("Verified address result required");
const output = path.join(root, ".acreiq-local/earth-address-authorized", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(output, { recursive: true });
const hash = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const protectedFiles = ["frontend/.env.local", "backend/.env"];
const originalHashes = protectedFiles.map(file => hash(path.join(root, file)));
const evidence = { checked_at: new Date().toISOString(), origin, address, success: false, google_errors: [], geocoding_calls: 0, tile_responses: 0 };
let browser, key;
function sanitize(value) {
  return String(value).replaceAll(key || "\u0000", "[REDACTED]").replace(/AIza[\w-]+/g, "[REDACTED]")
    .replace(/https?:\/\/[^\s]+/g, "[URL omitted]").slice(0, 1000);
}
(async () => {
  try {
    evidence.phase = "configuration";
    evidence.build_id = readFileSync(path.join(root, "frontend/.next-earth-address/BUILD_ID"), "utf8").trim();
    const configuration = await (await fetch(`${origin}/api/earth/maps-config`)).json();
    key = configuration.apiKey;
    if (typeof key !== "string" || !key) throw new Error("Maps browser key missing");
    const env = readFileSync(path.join(root, "frontend/.env.local"), "utf8");
    const value = env.match(/^NEXT_PUBLIC_GOOGLE_MAPS_API_KEY\s*=\s*(.*?)\s*$/m)?.[1]?.replace(/^(["'])(.*)\1$/, "$2");
    evidence.preview_uses_existing_private_maps_key = key === value;
    expect(evidence.preview_uses_existing_private_maps_key).toBe(true);
    browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--use-angle=d3d11", "--mute-audio"] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    await context.routeWebSocket(/.*/, ws => ws.close());
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.origin === origin || ["googleapis.com", "gstatic.com", "google.com"].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return route.continue();
      return route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on("console", message => {
      if (/Google Maps JavaScript API (?:error|warning)|Geocoding (?:Service|API)|GeocodingService/i.test(message.text())) evidence.google_errors.push(sanitize(message.text()));
    });
    page.on("response", response => {
      const url = new URL(response.url());
      if (url.hostname.includes("google") && /\/(kh|vt|maps\/vt)(?:\/|$)/.test(url.pathname) && response.ok()) evidence.tile_responses++;
    });
    let networkGeocodingCalls = 0;
    page.on("request", request => { if (/GeocodeService/i.test(new URL(request.url()).pathname)) networkGeocodingCalls++; });
    evidence.phase = "isolated synthetic site";
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Compare site plans", exact: true }).click();
    await page.getByRole("button", { name: "Load A/B/C synthetic fixture", exact: true }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("acreiq.site-comparisons.v2"))).not.toBeNull();
    const before = await page.evaluate(() => localStorage.getItem("acreiq.site-comparisons.v2"));
    await page.getByRole("button", { name: "AcreIQ Earth", exact: true }).click();
    await page.getByRole("button", { name: "Load Google imagery", exact: true }).click();
    await expect(page.locator(".earth-status")).toHaveText("Google imagery loaded", { timeout: 25000 });
    evidence.maps_javascript_accepted_origin = true;
    await page.evaluate(() => {
      for (const method of ["panTo", "fitBounds"]) {
        const original = window.google.maps.Map.prototype[method];
        window.google.maps.Map.prototype[method] = function(...args) {
          window.__addressMap = this;
          window.__addressMapIdle = false;
          window.google.maps.event.addListenerOnce(this, "idle", () => { window.__addressMapIdle = true; });
          return original.apply(this, args);
        };
      }
    });
    let result;
    if (resumed) {
      evidence.phase = "reuse already returned coordinates; no new geocoding";
      evidence.reuses_evidence = resumePath;
      result = resumed.returned_location;
      evidence.returned_location = result;
      await page.locator(".earth-precise > summary").click();
      await page.getByRole("textbox", { name: "Latitude", exact: true }).fill(String(result.lat));
      await page.getByRole("textbox", { name: "Longitude", exact: true }).fill(String(result.lng));
      await page.getByRole("button", { name: "Select coordinates", exact: true }).click();
    } else {
    await page.evaluate(async () => {
      const { Geocoder } = await window.google.maps.importLibrary("geocoding");
      const original = Geocoder.prototype.geocode;
      window.__addressProbe = { calls: 0 };
      Geocoder.prototype.geocode = function(request, callback) {
        window.__addressProbe.calls++;
        return original.call(this, request, (results, status) => {
          window.__addressProbe.status = status;
          window.__addressProbe.results = (results || []).map(result => ({
            address: result.formatted_address,
            lat: result.geometry.location.lat(), lng: result.geometry.location.lng(),
            partial: result.partial_match === true, location_type: result.geometry.location_type,
            north: result.geometry.viewport?.getNorthEast().lat(), south: result.geometry.viewport?.getSouthWest().lat(),
            east: result.geometry.viewport?.getNorthEast().lng(), west: result.geometry.viewport?.getSouthWest().lng(),
          }));
          callback(results, status);
        });
      };
    });
    evidence.phase = "one address search";
    await page.getByRole("textbox", { name: "Address", exact: true }).fill(address);
    await page.getByRole("button", { name: "Find address", exact: true }).click();
    await expect(page.getByRole("button", { name: "Find address", exact: true })).toBeEnabled({ timeout: 25000 });
    const provider = await page.evaluate(() => window.__addressProbe);
    evidence.geocoding_calls = provider.calls;
    evidence.google_geocoding_status = provider.status || "NO_CALLBACK";
    expect(provider.calls).toBe(1);
    const error = page.locator(".earth-address-search .earth-error");
    if (await error.isVisible()) {
      evidence.sanitized_ui_error = await error.innerText();
      await page.screenshot({ path: path.join(output, "address-error.png"), fullPage: true });
      return;
    }
    expect(provider.status).toBe("OK");
    if (await page.locator(".earth-address-result").count()) await page.locator(".earth-address-result").first().click();
    result = provider.results[0];
    evidence.returned_location = result;
    await expect(page.locator(".earth-address-feedback").filter({ hasText: result.address })).toBeVisible();
    await expect(page.getByRole("button", { name: "Associate selected location", exact: true })).toBeDisabled();
    await expect(page.getByRole("textbox", { name: "Latitude", exact: true })).toBeHidden();
    }
    const map = page.locator(".earth-google-map");
    await expect.poll(() => page.evaluate(() => window.__addressMapIdle === true)).toBe(true);
    const center = await page.evaluate(() => ({ lat: window.__addressMap.getCenter().lat(), lng: window.__addressMap.getCenter().lng() }));
    expect(center.lat).toBeGreaterThanOrEqual(result.south);
    expect(center.lat).toBeLessThanOrEqual(result.north);
    expect(center.lng).toBeGreaterThanOrEqual(result.west);
    expect(center.lng).toBeLessThanOrEqual(result.east);
    evidence.map_center_within_returned_viewport = true;
    await expect.poll(() => map.locator("img").evaluateAll(images => images.filter(image => image.complete && image.naturalWidth >= 128).length)).toBeGreaterThan(0);
    await page.screenshot({ path: path.join(output, "address-satellite.png"), fullPage: true });
    evidence.phase = "returned area and explicit site pin";
    if (!resumed) {
      const bounds = await map.boundingBox();
      await map.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
    }
    await expect(page.getByRole("button", { name: "Associate selected location", exact: true })).toBeEnabled();
    const point = { lat: Number(await page.getByRole("textbox", { name: "Latitude", exact: true }).inputValue()), lng: Number(await page.getByRole("textbox", { name: "Longitude", exact: true }).inputValue()) };
    expect(point.lat).toBeGreaterThanOrEqual(result.south);
    expect(point.lat).toBeLessThanOrEqual(result.north);
    expect(point.lng).toBeGreaterThanOrEqual(result.west);
    expect(point.lng).toBeLessThanOrEqual(result.east);
    evidence.map_center_within_returned_viewport = true;
    await page.getByRole("button", { name: "Associate selected location", exact: true }).click();
    await expect(page.locator(".earth-selected")).toContainText("Matches this site's associated location");
    const locationStore = await page.evaluate(() => JSON.parse(localStorage.getItem("acreiq.earth-locations.v1")));
    const association = locationStore.associations[0];
    expect(association.siteId).toBe("fixture-site-1");
    expect(association.point).toEqual(point);
    evidence.associated_site_id = association.siteId;
    evidence.selected_pin = point;
    expect(await page.evaluate(() => localStorage.getItem("acreiq.site-comparisons.v2"))).toBe(before);
    evidence.site_inputs_and_comparisons_unchanged = true;
    await page.screenshot({ path: path.join(output, "address-associated.png"), fullPage: true });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator(".earth-associated")).toContainText(point.lat.toFixed(6));
    await expect(page.locator(".earth-associated")).toContainText(point.lng.toFixed(6));
    evidence.association_survived_reload = true;
    evidence.network_geocoding_requests = networkGeocodingCalls;
    if (resumed) expect(networkGeocodingCalls).toBe(0);
    evidence.phase = "complete";
    evidence.success = true;
  } catch (error) {
    evidence.exception_type = error.name;
    evidence.sanitized_exception = sanitize(error.message);
  } finally {
    await browser?.close();
    evidence.credential_files_unchanged = protectedFiles.every((file, index) => hash(path.join(root, file)) === originalHashes[index]);
    writeFileSync(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
    console.log(JSON.stringify({ ...evidence, evidence_directory: output }, null, 2));
    if (!evidence.success) process.exitCode = 1;
  }
})();
