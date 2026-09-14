import { expect, test, type Page } from "./test-support";
import type { SiteComparisonArtifact } from "../lib/site-types";

const earth = (page: Page) => page.getByRole("region", { name: "AcreIQ Earth", exact: true });
const phase2Key = "acreiq.site-comparisons.v2";
const locationKey = "acreiq.earth-locations.v1";
const readStore = (page: Page, key = phase2Key) => page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key);
async function enterEarth(page: Page) {
  await page.getByRole("button", { name: "AcreIQ Earth", exact: true }).click();
  await expect(earth(page)).toBeVisible();
}
async function point(page: Page, lat = "37.42", lng = "-122.09") {
  const details = earth(page).locator(".earth-precise");
  if (!await details.evaluate(element => (element as HTMLDetailsElement).open)) await details.locator("summary").click();
  await earth(page).getByRole("textbox", { name: "Latitude", exact: true }).fill(lat);
  await earth(page).getByRole("textbox", { name: "Longitude", exact: true }).fill(lng);
  await earth(page).getByRole("button", { name: "Select coordinates", exact: true }).click();
}
async function savedSite(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Compare site plans", exact: true }).click();
  await page.getByRole("button", { name: "Load A/B/C synthetic fixture", exact: true }).click();
  await page.getByRole("checkbox", { name: "Site plan review", exact: true }).check();
  const response = page.waitForResponse(r => r.url().endsWith("/api/site-comparisons") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Compare reviewed plans", exact: true }).click();
  const artifact = await (await response).json() as SiteComparisonArtifact;
  await expect(page.locator(`[data-comparison-id="${artifact.payload.id}"]`)).toBeVisible();
  return artifact;
}

// Test double exercises the SDK boundary and DOM lifecycle; it is never satellite evidence.
function googleDouble() {
  const host = window as unknown as { google: unknown; acreiqMapsReady: () => void; earthAudit: { creations: number; options: Record<string, unknown>; zoom: number; pans: unknown[]; viewports: unknown[]; types: string[]; removals: number }; earthGeocode: { queries: string[]; mode: string; pending: (() => void)[] } };
  host.earthAudit = { creations: 0, options: {}, zoom: 2, pans: [], viewports: [], types: [], removals: 0 };
  host.earthGeocode = { queries: [], mode: "single", pending: [] };
  class LatLng { constructor(private latitude: number, private longitude: number) {} lat() { return this.latitude; } lng() { return this.longitude; } }
  class MapDouble {
    listeners = new Map<string, ((event: unknown) => void)[]>();
    constructor(public element: HTMLElement, options: Record<string, unknown>) {
      host.earthAudit.creations++; host.earthAudit.options = options; host.earthAudit.zoom = options.zoom as number;
      window.addEventListener("earth-test-late-tiles", () => this.emit("tilesloaded", {}));
      const label = document.createElement("p"); label.textContent = "Google Maps SDK test double - not satellite imagery"; element.append(label);
      const attribution = document.createElement("a"); attribution.textContent = "Google attribution (test double)"; attribution.href = "https://maps.google.com";
      attribution.dataset.testAttribution = "true"; attribution.style.cssText = "position:absolute;bottom:0;left:0;color:#202124;background:white;font-size:10px;z-index:3"; element.append(attribution);
      const zoom = document.createElement("button"); zoom.textContent = "+"; zoom.setAttribute("aria-label", "Google zoom in (test double)"); zoom.style.cssText = "position:absolute;right:10px;bottom:40px;background:white;width:40px;height:40px";
      zoom.onclick = e => { e.stopPropagation(); host.earthAudit.zoom++; }; element.append(zoom);
      element.addEventListener("click", e => { if (!(e.target as HTMLElement).closest("button,a")) this.emit("click", { latLng: new LatLng(37.42, -122.09) }); });
      setTimeout(() => this.emit("tilesloaded", {}), 0);
    }
    emit(name: string, event: unknown) { for (const callback of this.listeners.get(name) ?? []) callback(event); }
    addListener(name: string, callback: (event: unknown) => void) { this.listeners.set(name, [...this.listeners.get(name) ?? [], callback]); return { remove: () => {} }; }
    panTo(value: unknown) { host.earthAudit.pans.push(value); }
    fitBounds(value: unknown) { host.earthAudit.viewports.push(value); }
    getZoom() { return host.earthAudit.zoom; }
    setZoom(value: number) { host.earthAudit.zoom = value; }
    setMapTypeId(value: string) { host.earthAudit.types.push(value); }
  }
  class OverlayView {
    map: MapDouble | null = null;
    onAdd() {} draw() {} onRemove() {}
    setMap(map: MapDouble | null) { if (this.map) { this.onRemove(); host.earthAudit.removals++; } this.map = map; if (map) { this.onAdd(); this.draw(); } }
    getPanes() { return { overlayMouseTarget: this.map!.element }; }
    getProjection() { return { fromLatLngToDivPixel: () => ({ x: this.map!.element.clientWidth / 2, y: this.map!.element.clientHeight / 2 }) }; }
    static preventMapHitsAndGesturesFrom(element: HTMLElement) { element.addEventListener("click", e => e.stopPropagation()); }
  }
  class Geocoder {
    geocode(request: { address: string }, callback: (results: unknown[], status: string) => void) {
      host.earthGeocode.queries.push(request.address);
      const mode = host.earthGeocode.mode;
      const result = (id: string, label: string, lat: number, partial = false) => ({ place_id: id, formatted_address: label, partial_match: partial,
        geometry: { location: new LatLng(lat, 20), location_type: partial ? "APPROXIMATE" : "ROOFTOP", viewport: { getNorthEast: () => new LatLng(lat + 0.1, 20.1), getSouthWest: () => new LatLng(lat - 0.1, 19.9) } } });
      const results = mode === "multiple" ? [result("first-address", "Main Street, Example City", 10, true), result("second-address", "Main Street, Second City", 12, true)] : mode === "zero" ? [] : mode === "delay" ? [result("delayed-address", "Delayed Road, Example City", 30)] : [result("single-address", "100 Test Road, Example City", 10)];
      const status = mode === "denied" ? "REQUEST_DENIED" : mode === "quota" ? "OVER_QUERY_LIMIT" : mode === "zero" ? "ZERO_RESULTS" : "OK";
      return new Promise(resolve => {
        const deliver = () => { callback(results, status); resolve({ results }); };
        if (mode === "delay") host.earthGeocode.pending.push(deliver); else queueMicrotask(deliver);
      });
    }
  }
  host.google = { maps: { Map: MapDouble, LatLng, OverlayView, importLibrary: async () => ({ Geocoder }), event: { clearInstanceListeners: (map: MapDouble) => map.listeners.clear(), trigger: () => {} } } };
  host.acreiqMapsReady();
}
async function mockMaps(page: Page, mode: "configured" | "missing" | "script-error" = "missing") {
  const scripts: URL[] = [];
  const unexpected: string[] = [];
  await page.route("**/*", route => {
    const u = new URL(route.request().url());
    if (!["127.0.0.1", "localhost"].includes(u.hostname)) { unexpected.push(u.hostname); return route.abort(); }
    return route.fallback();
  });
  await page.routeWebSocket(/.*/, ws => ws.close());
  await page.route("**/api/earth/maps-config", route => route.fulfill({ json: { apiKey: mode === "missing" ? null : "maps-test-only-not-a-real-key" } }));
  await page.route("https://maps.googleapis.com/maps/api/js?*", route => {
    scripts.push(new URL(route.request().url()));
    return mode === "script-error" ? route.abort() : route.fulfill({ contentType: "application/javascript", body: `(${googleDouble.toString()})();` });
  });
  return { scripts, unexpected };
}

test("Earth missing configuration stays usable, validates coordinates and does not create sites", async ({ page }, info) => {
  const maps = await mockMaps(page);
  await page.goto("/"); await enterEarth(page);
  await expect(earth(page).getByRole("heading", { name: "Satellite imagery not configured" })).toBeVisible();
  await expect(earth(page)).toContainText("No existing site records");
  await expect(earth(page).getByRole("textbox", { name: "Address", exact: true })).toBeVisible();
  await expect(earth(page).getByRole("button", { name: "Find address", exact: true })).toBeDisabled();
  await expect(earth(page).getByRole("textbox", { name: "Latitude", exact: true })).toBeHidden();
  await point(page, "", "-122"); await expect(earth(page).getByRole("alert")).toContainText("Latitude is required");
  await point(page, "91", "0"); await expect(earth(page).getByRole("alert")).toContainText("between -90 and 90");
  await point(page, "0", "0"); await expect(earth(page).locator(".earth-selected")).toContainText("0.000000, 0.000000");
  expect(await readStore(page, locationKey)).toBeNull();
  expect(maps.scripts).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath("earth-unconfigured.png"), fullPage: true });
  await earth(page).locator(".earth-origin-recovery > summary").click();
  await earth(page).getByRole("button", { name: "Import existing comparison", exact: true }).click();
  await expect(page.getByRole("button", { name: "Import comparison JSON", exact: true })).toBeVisible();
});

test("Earth associates exact existing site IDs and opens historical comparisons without changing inputs or evidence", async ({ page }) => {
  const maps = await mockMaps(page);
  const first = await savedSite(page);
  const reranked = page.waitForResponse(r => r.url().endsWith("/api/site-comparisons"));
  await page.getByRole("combobox", { name: "Comparison goal", exact: true }).selectOption("energy_kwh");
  const second = await (await reranked).json() as SiteComparisonArtifact;
  await expect(page.locator(`[data-comparison-id="${second.payload.id}"]`)).toBeVisible();
  const before = await readStore(page);
  let calculations = 0;
  page.on("request", request => { if (request.method() === "POST" && /\/(optimize|site-comparisons)$/.test(request.url())) calculations++; });
  await enterEarth(page);
  await point(page);
  await earth(page).getByRole("button", { name: "Associate selected location", exact: true }).click();
  await expect(earth(page).locator(".earth-associated")).toContainText("37.420000, -122.090000");
  expect((await readStore(page, locationKey)).associations[0]).toMatchObject({ siteId: first.payload.input_snapshot.site.id, source: "user_selected", point: { lat: 37.42, lng: -122.09 }, version: 1 });
  await expect(earth(page)).toContainText("Synthetic site");
  await page.reload(); await expect(earth(page)).toBeVisible();
  await expect(earth(page).locator(".earth-associated")).toContainText("37.420000");
  await earth(page).getByRole("combobox", { name: "Site comparison", exact: true }).selectOption(first.payload.id);
  await earth(page).getByRole("button", { name: "Open site comparison", exact: true }).click();
  await expect(page.locator(`[data-comparison-id="${first.payload.id}"]`)).toBeVisible();
  const after = await readStore(page);
  expect(after.working).toEqual(before.working); expect(after.history).toEqual(before.history);
  expect(after.selectedComparisonId).toBe(first.payload.id); expect(calculations).toBe(0); expect(maps.scripts).toHaveLength(0);
  await enterEarth(page); await point(page, "38", "-121");
  await earth(page).getByRole("button", { name: "Replace site location", exact: true }).click();
  expect((await readStore(page, locationKey)).associations[0].version).toBe(2);
  await earth(page).getByRole("button", { name: "Remove site location", exact: true }).click();
  expect((await readStore(page, locationKey)).associations).toEqual([]);
  expect((await readStore(page)).history).toEqual(before.history);
});

test("Google SDK loads only on request; map layer, coordinates, pins, zoom and attribution integrate without remounting", async ({ page }, info) => {
  const maps = await mockMaps(page, "configured"); await savedSite(page); await enterEarth(page);
  await expect(earth(page).getByRole("button", { name: "Load Google imagery", exact: true })).toBeVisible();
  expect(maps.scripts).toHaveLength(0);
  await earth(page).getByRole("button", { name: "Load Google imagery", exact: true }).click();
  await expect(earth(page).getByRole("status").first()).toContainText("Google imagery loaded");
  expect(maps.scripts).toHaveLength(1);
  expect(maps.scripts[0].searchParams.get("loading")).toBe("async");
  expect(maps.scripts[0].searchParams.get("libraries")).toBeNull();
  await earth(page).getByRole("button", { name: "Hybrid", exact: true }).click();
  await point(page, "10.5", "-20.25");
  const audit = () => page.evaluate(() => (window as unknown as { earthAudit: { creations: number; options: Record<string, unknown>; zoom: number; pans: { lat: number; lng: number }[]; types: string[] } }).earthAudit);
  expect((await audit()).pans.at(-1)).toEqual({ lat: 10.5, lng: -20.25 });
  expect((await audit()).types.at(-1)).toBe("hybrid");
  expect((await audit()).options).toMatchObject({ mapTypeId: "satellite", mapTypeControl: false, streetViewControl: false, gestureHandling: "cooperative", tilt: 0 });
  await earth(page).getByRole("button", { name: "Google zoom in (test double)", exact: true }).click();
  expect((await audit()).zoom).toBe(18);
  await earth(page).locator(".earth-google-map").click({ position: { x: 80, y: 100 } });
  await expect(earth(page).getByRole("textbox", { name: "Latitude", exact: true })).toHaveValue("37.42");
  await earth(page).getByRole("button", { name: "Associate selected location", exact: true }).click();
  await earth(page).getByRole("button", { name: "Clear selected location", exact: true }).click();
  await earth(page).getByRole("button", { name: /^Location for / }).click();
  await expect(earth(page).locator(".earth-selected")).toContainText("37.420000");
  await page.getByRole("button", { name: "Workspace", exact: true }).click(); await enterEarth(page);
  expect((await audit()).creations).toBe(1); expect(maps.scripts).toHaveLength(1);
  const attribution = earth(page).locator("[data-test-attribution]"); await attribution.scrollIntoViewIfNeeded(); await expect(attribution).toBeVisible();
  expect(await attribution.evaluate(element => { const b = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)); })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath("earth-sdk-double-not-imagery.png"), fullPage: true });
});

test("Maps authorization and script failures do not erase site data or substitute imagery", async ({ page }) => {
  await mockMaps(page, "configured"); const first = await savedSite(page); await enterEarth(page);
  await earth(page).getByRole("button", { name: "Load Google imagery", exact: true }).click();
  await expect(earth(page).getByRole("status").first()).toContainText("Google imagery loaded");
  await page.evaluate(() => (window as unknown as { gm_authFailure(): void }).gm_authFailure());
  await page.evaluate(() => window.dispatchEvent(new Event("earth-test-late-tiles")));
  await expect(earth(page).getByRole("alert")).toContainText("authorization failed");
  await expect(earth(page).getByRole("status").first()).toHaveText("Maps authorization failed");
  await point(page); await earth(page).getByRole("button", { name: "Associate selected location", exact: true }).click();
  await earth(page).getByRole("button", { name: "Open site comparison", exact: true }).click();
  await expect(page.locator(`[data-comparison-id="${first.payload.id}"]`)).toBeVisible();
});

test("Maps script network failure and unavailable configuration have specific recoverable states", async ({ page }) => {
  await mockMaps(page, "script-error"); await page.goto("/"); await enterEarth(page);
  await earth(page).getByRole("button", { name: "Load Google imagery", exact: true }).click();
  await expect(earth(page).getByRole("alert")).toContainText("could not load");
  await point(page, "0", "0"); await expect(earth(page).locator(".earth-selected")).toContainText("0.000000");
  await page.route("**/api/earth/maps-config", route => route.fulfill({ status: 503, json: {} }));
  await page.reload(); await expect(earth(page).getByRole("heading", { name: "Maps configuration unavailable" })).toBeVisible();
  await page.route("**/api/earth/maps-config", route => route.fulfill({ json: { apiKey: null } }));
  await earth(page).getByRole("button", { name: "Retry configuration", exact: true }).click();
  await expect(earth(page).getByRole("heading", { name: "Satellite imagery not configured" })).toBeVisible();
});

test("location storage quota failure preserves pins and Phase 2 while navigation still works", async ({ page }) => {
  await mockMaps(page); await savedSite(page); await enterEarth(page); await point(page);
  await earth(page).getByRole("button", { name: "Associate selected location", exact: true }).click();
  const before = await readStore(page, locationKey); const phase2 = await readStore(page);
  await page.evaluate(key => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function(name, value) { if (name === key) throw new DOMException("full", "QuotaExceededError"); return original.call(this, name, value); }; }, locationKey);
  await point(page, "38", "-121"); await earth(page).getByRole("button", { name: "Replace site location", exact: true }).click();
  await expect(earth(page).getByRole("alert")).toContainText("full");
  expect(await readStore(page, locationKey)).toEqual(before); expect((await readStore(page)).history).toEqual(phase2.history);
  await earth(page).getByRole("button", { name: "Open site comparison", exact: true }).click();
  await expect(page.getByRole("region", { name: "Site comparison results", exact: true })).toBeVisible();
});

test("Maps configuration timeout offers retry without blocking Earth navigation", async ({ page }) => {
  await mockMaps(page);
  await page.clock.install();
  await page.route("**/api/earth/maps-config", () => {});
  await page.goto("/");
  const configRequest = page.waitForRequest(request => request.url().endsWith("/api/earth/maps-config"));
  await enterEarth(page); await configRequest;
  await page.clock.fastForward(11000);
  await expect(earth(page).getByRole("heading", { name: "Maps configuration unavailable" })).toBeVisible();
  await point(page, "1", "2");
  await expect(earth(page).locator(".earth-selected")).toContainText("1.000000, 2.000000");
});

test("Google SDK constructor errors never expose raw credential or provider details", async ({ page }) => {
  await mockMaps(page, "configured");
  await page.route("https://maps.googleapis.com/maps/api/js?*", route => route.fulfill({ contentType: "application/javascript", body: 'window.google={maps:{Map:function(){throw new Error("private-provider-detail");},OverlayView:function(){}}};window.acreiqMapsReady();' }));
  await page.goto("/"); await enterEarth(page);
  await earth(page).getByRole("button", { name: "Load Google imagery", exact: true }).click();
  await expect(earth(page).getByRole("alert")).toContainText("could not initialize");
  await expect(earth(page)).not.toContainText("private-provider-detail");
});

type AddressDouble = { earthGeocode: { mode: string; queries: string[]; pending: (() => void)[] }; earthAudit: { viewports: unknown[]; pans: unknown[] } };
const geoState = (page: Page) => page.evaluate(() => (window as unknown as AddressDouble).earthGeocode.queries);
const viewports = (page: Page) => page.evaluate(() => (window as unknown as AddressDouble).earthAudit.viewports);
const geoMode = (page: Page, mode: string) => page.evaluate(mode => { (window as unknown as AddressDouble).earthGeocode.mode = mode; }, mode);
const finishOldSearches = (page: Page) => page.evaluate(() => { for (const finish of (window as unknown as AddressDouble).earthGeocode.pending.splice(0)) finish(); });
async function mockMapReady(page: Page) {
  await earth(page).getByRole("button", { name: "Load Google imagery", exact: true }).click();
  await expect(earth(page).locator(".earth-status")).toHaveText("Google imagery loaded");
}
async function address(page: Page, query: string) {
  await earth(page).getByRole("textbox", { name: "Address", exact: true }).fill(query);
  await earth(page).getByRole("button", { name: "Find address", exact: true }).click();
}

test("address is primary, coordinates are optional, and search only locates an area until a site pin is chosen", async ({ page }, info) => {
  const maps = await mockMaps(page, "configured"); const run = await savedSite(page); const before = await readStore(page);
  await enterEarth(page);
  await expect(earth(page).getByRole("textbox", { name: "Address", exact: true })).toBeVisible();
  await expect(earth(page).getByRole("textbox", { name: "Latitude", exact: true })).toBeHidden();
  await earth(page).getByRole("button", { name: "Find address", exact: true }).click();
  await expect(earth(page).getByRole("alert")).toContainText("Enter an address");
  expect(maps.scripts).toHaveLength(0);
  await earth(page).getByRole("textbox", { name: "Address", exact: true }).fill("  100   Test Road  ");
  expect(maps.scripts).toHaveLength(0);
  await earth(page).getByRole("textbox", { name: "Address", exact: true }).press("Enter");
  await expect(earth(page).locator(".earth-address-feedback").first()).toContainText("100 Test Road, Example City");
  expect(await geoState(page)).toEqual(["100 Test Road"]);
  await expect.poll(() => viewports(page)).toEqual([{ north: 10.1, south: 9.9, east: 20.1, west: 19.9 }]);
  await expect(earth(page).getByRole("button", { name: "Associate selected location", exact: true })).toBeDisabled();
  expect(await readStore(page, locationKey)).toBeNull();
  await expect(earth(page).locator(".earth-address-attribution")).toHaveText("Google Maps");
  await expect(earth(page).getByRole("textbox", { name: "Latitude", exact: true })).toBeHidden();
  await page.screenshot({ path: info.outputPath("earth-address-first-sdk-double.png"), fullPage: true });
  await earth(page).locator(".earth-google-map").click({ position: { x: 80, y: 100 } });
  await earth(page).getByRole("button", { name: "Associate selected location", exact: true }).click();
  expect((await readStore(page, locationKey)).associations[0]).toMatchObject({ siteId: run.payload.input_snapshot.site.id, point: { lat: 37.42, lng: -122.09 }, source: "user_selected" });
  expect(await page.evaluate(() => Object.values(localStorage).join(""))).not.toContain("Test Road");
  await earth(page).getByRole("button", { name: "Open site comparison", exact: true }).click();
  await expect(page.locator(`[data-comparison-id="${run.payload.id}"]`)).toBeVisible();
  expect((await readStore(page)).history).toEqual(before.history); expect((await readStore(page)).working).toEqual(before.working);
});

test("ambiguous and partial address matches require a choice and zero results never substitute a site location", async ({ page }) => {
  await mockMaps(page, "configured"); await page.goto("/"); await enterEarth(page); await mockMapReady(page);
  await geoMode(page, "multiple"); await address(page, "Main Street");
  await expect(earth(page).locator(".earth-address-result")).toHaveCount(2);
  expect(await viewports(page)).toEqual([]);
  await expect(earth(page).locator(".earth-address-result").first()).toContainText("Partial match");
  await earth(page).getByRole("button", { name: /Main Street, Second City/ }).click();
  await expect.poll(() => viewports(page)).toEqual([{ north: 12.1, south: 11.9, east: 20.1, west: 19.9 }]);
  await expect(earth(page).locator(".earth-address-search")).toContainText("Partial address match");
  await geoMode(page, "zero"); await address(page, "No known address");
  await expect(earth(page).locator(".earth-address-search")).toContainText("No address matches");
  await expect(earth(page).locator(".earth-address-result")).toHaveCount(0);
  expect(await readStore(page, locationKey)).toBeNull();
});

test("address edits, manual pins, cancellation and navigation invalidate delayed search responses", async ({ page }) => {
  await mockMaps(page, "configured"); await page.goto("/"); await enterEarth(page); await mockMapReady(page);
  await geoMode(page, "delay"); await address(page, "Older address");
  await expect.poll(() => geoState(page)).toHaveLength(1);
  await geoMode(page, "single"); await address(page, "Newer address");
  await expect(earth(page).locator(".earth-address-search")).toContainText("100 Test Road, Example City");
  await finishOldSearches(page);
  await expect(earth(page).locator(".earth-address-search")).not.toContainText("Delayed Road");
  expect(await viewports(page)).toEqual([{ north: 10.1, south: 9.9, east: 20.1, west: 19.9 }]);
  await geoMode(page, "delay"); await address(page, "Ignore after manual choice");
  await expect.poll(() => geoState(page)).toHaveLength(3);
  await point(page, "4", "5"); await finishOldSearches(page);
  await expect(earth(page).locator(".earth-selected")).toContainText("4.000000, 5.000000");
  expect(await viewports(page)).toHaveLength(1);
  await address(page, "Cancel this search"); await expect.poll(() => geoState(page)).toHaveLength(4);
  await earth(page).getByRole("button", { name: "Cancel address search", exact: true }).click(); await finishOldSearches(page);
  await expect(earth(page).locator(".earth-address-search")).not.toContainText("Delayed Road");
  await address(page, "Ignore after navigation"); await expect.poll(() => geoState(page)).toHaveLength(5);
  await page.getByRole("button", { name: "Workspace", exact: true }).click(); await finishOldSearches(page); await enterEarth(page);
  await expect(earth(page).getByRole("button", { name: "Find address", exact: true })).toBeEnabled();
  expect(await viewports(page)).toHaveLength(1);
});

for (const [mode, message] of [["denied", "Geocoding API"], ["quota", "request limit"]]) {
  test(`address ${mode} error leaves saved pins, Maps and comparison evidence usable`, async ({ page }) => {
    await mockMaps(page, "configured"); const run = await savedSite(page); await enterEarth(page); await point(page, "1", "2");
    await earth(page).getByRole("button", { name: "Associate selected location", exact: true }).click();
    const saved = await readStore(page, locationKey); const before = await readStore(page);
    await mockMapReady(page); await geoMode(page, mode); await address(page, "100 Test Road");
    await expect(earth(page).getByRole("alert")).toContainText(message);
    expect(await readStore(page, locationKey)).toEqual(saved); expect((await readStore(page)).history).toEqual(before.history);
    await expect(earth(page).locator(".earth-status")).toHaveText("Google imagery loaded");
    await earth(page).getByRole("button", { name: "Open site comparison", exact: true }).click();
    await expect(page.locator(`[data-comparison-id="${run.payload.id}"]`)).toBeVisible();
  });
}

test("a timed-out address lookup stays canceled when its provider callback arrives late", async ({ page }) => {
  await mockMaps(page, "configured"); await page.goto("/"); await enterEarth(page); await mockMapReady(page);
  await page.clock.install(); await geoMode(page, "delay"); await address(page, "Slow address");
  await expect.poll(() => geoState(page)).toHaveLength(1); await page.clock.fastForward(16000);
  await expect(earth(page).getByRole("alert")).toContainText("timed out");
  await finishOldSearches(page);
  expect(await viewports(page)).toEqual([]); expect(await geoState(page)).toHaveLength(1);
  await expect(earth(page).getByRole("button", { name: "Find address", exact: true })).toBeEnabled();
});
