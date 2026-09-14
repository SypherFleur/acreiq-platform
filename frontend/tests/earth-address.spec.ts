import { expect, test } from "@playwright/test";
import {
  AddressSearchError, MAX_ADDRESS_LENGTH, createAddressLookup, geocodeAddress, normalizeAddressQuery,
  type AddressSearchErrorCode,
} from "../lib/earth-address";
import type { GeocodingLibrary, GoogleGeocoder, GoogleGeocoderResult, GoogleMapsApi, MapBounds, MapPosition } from "../lib/google-maps";

const KEY = "fixture-only-not-a-provider-key";
const PRIVATE_ERROR = "private provider diagnostic and address must not be exposed";
type Callback = Parameters<GoogleGeocoder["geocode"]>[1];

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const drain = () => new Promise<void>(resolve => setImmediate(resolve));
const position = (lat: number, lng: number): MapPosition => ({ lat: () => lat, lng: () => lng });
const bounds = (north: number, south: number, east: number, west: number): MapBounds => ({
  getNorthEast: () => position(north, east), getSouthWest: () => position(south, west),
});
function result(overrides: Partial<GoogleGeocoderResult> = {}): GoogleGeocoderResult {
  return { place_id: "fixture-place", formatted_address: "Fixture address, Test Region",
    geometry: { location: position(12, -34), location_type: "ROOFTOP", viewport: bounds(13, 11, -33, -35) }, ...overrides };
}

function harness(options: {
  deferLoad?: boolean;
  deferImport?: boolean;
  timeoutMs?: number;
  onConstruct?: () => void;
  onGeocode?: GoogleGeocoder["geocode"];
} = {}) {
  const loadGate = deferred<Pick<GoogleMapsApi, "importLibrary">>(), importGate = deferred<GeocodingLibrary>();
  const importStarted = deferred<void>(), requestStarted = deferred<void>();
  const loads: string[] = [], imports: string[] = [], requests: { address: string }[] = [], callbacks: Callback[] = [];
  let constructions = 0;
  const library: GeocodingLibrary = { Geocoder: class implements GoogleGeocoder {
    constructor() { constructions++; options.onConstruct?.(); }
    geocode(request: { address: string }, callback: Callback) {
      requests.push(request);
      callbacks.push(callback);
      requestStarted.resolve();
      return options.onGeocode?.(request, callback);
    }
  } };
  const maps: Pick<GoogleMapsApi, "importLibrary"> = { importLibrary(name) {
    imports.push(name);
    importStarted.resolve();
    return importGate.promise;
  } };
  const lookup = createAddressLookup(key => { loads.push(key); return loadGate.promise; }, options.timeoutMs);
  if (!options.deferLoad) loadGate.resolve(maps);
  if (!options.deferImport) importGate.resolve(library);
  return { lookup, loads, imports, requests, callbacks, loadGate, importGate, maps, library,
    importStarted, requestStarted, constructions: () => constructions };
}

async function expectError(promise: Promise<unknown>, code: AddressSearchErrorCode) {
  await expect(promise).rejects.toBeInstanceOf(AddressSearchError);
  await expect(promise).rejects.toMatchObject({ name: "AddressSearchError", code, message: new AddressSearchError(code).message });
  await promise.catch(error => {
    expect(error.message).not.toContain(PRIVATE_ERROR);
    expect(error.message).not.toContain(KEY);
    expect(error.cause).toBeUndefined();
  });
}

test("query normalization is synchronous, preserves international addresses and collapses spaces", () => {
  expect(normalizeAddressQuery("  12   Fixture Road,\u00a0Test Region  ")).toBe("12 Fixture Road, Test Region");
  expect(normalizeAddressQuery("  Cafe\u0301, \u6771\u4eac  ")).toBe("Caf\u00e9, \u6771\u4eac");
  expect(normalizeAddressQuery("A".repeat(MAX_ADDRESS_LENGTH))).toHaveLength(MAX_ADDRESS_LENGTH);
});

test("blank, overlong and control-character queries fail before SDK loading", async () => {
  const fake = harness();
  const queries = ["", "   ", "\u00a0", "A".repeat(MAX_ADDRESS_LENGTH + 1), "A\nB", "A\rB", "A\tB", "A\0B",
    "A\u007fB", "A\u0085B", "A\u2028B", "A\u202eB", "A\u2066B"];
  for (const query of queries) {
    expect(() => normalizeAddressQuery(query)).toThrow(new AddressSearchError("INVALID_QUERY"));
    await expectError(fake.lookup(KEY, query, new AbortController().signal), "INVALID_QUERY");
  }
  expect(fake.loads).toEqual([]);
  await expectError(geocodeAddress(KEY, "", new AbortController().signal), "INVALID_QUERY");
});

test("missing browser key fails without loading Maps", async () => {
  const fake = harness();
  await expectError(fake.lookup("  ", "Fixture address", new AbortController().signal), "NOT_CONFIGURED");
  expect(fake.loads).toEqual([]);
});

test("each explicit lookup uses the geocoding library and sends exactly one forward request without caching", async () => {
  const fake = harness();
  for (let i = 0; i < 2; i++) {
    const pending = fake.lookup(KEY, "  Fixture   address  ", new AbortController().signal);
    await drain();
    expect(fake.requests).toHaveLength(i + 1);
    fake.callbacks[i]([result()], "OK");
    await expect(pending).resolves.toHaveLength(1);
  }
  expect(fake.imports).toEqual(["geocoding", "geocoding"]);
  expect(fake.requests).toEqual([{ address: "Fixture address" }, { address: "Fixture address" }]);
  expect(fake.loads).toEqual([KEY, KEY]);
});

test("matches contain detached geometry and normalized display labels with no provider metadata", async () => {
  const fake = harness();
  const pending = fake.lookup(KEY, "Fixture address", new AbortController().signal);
  await fake.requestStarted.promise;
  fake.callbacks[0]([result({ place_id: " fixture-place ", formatted_address: "  Cafe\u0301  Fixture,\u00a0Test Region ", partial_match: true })], "OK");
  await expect(pending).resolves.toEqual([{ id: "fixture-place", label: "Caf\u00e9 Fixture, Test Region", point: { lat: 12, lng: -34 },
    viewport: { north: 13, south: 11, east: -33, west: -35 }, partial: true, approximate: false }]);
});

test("all non-rooftop or unknown location types remain approximate independently of partial matches", async () => {
  const fake = harness();
  const pending = fake.lookup(KEY, "Fixture address", new AbortController().signal);
  await fake.requestStarted.promise;
  const types = ["ROOFTOP", "RANGE_INTERPOLATED", "GEOMETRIC_CENTER", "APPROXIMATE", "future-type"];
  fake.callbacks[0](types.map((type, i) => result({ place_id: `fixture-${i}`, partial_match: i === 1,
    geometry: { location: position(0, 0), location_type: type } })), "OK");
  const matches = await pending;
  expect(matches.map(match => match.approximate)).toEqual([false, true, true, true, true]);
  expect(matches.map(match => match.partial)).toEqual([false, true, false, false, false]);
});

test("normalization skips invalid and duplicate results while preserving order and a six-match cap", async () => {
  const fake = harness();
  const pending = fake.lookup(KEY, "Fixture address", new AbortController().signal);
  await fake.requestStarted.promise;
  fake.callbacks[0]([result({ place_id: "" }), result(), result(), ...Array.from({ length: 8 }, (_, i) => result({ place_id: `fixture-${i}` }))], "OK");
  expect((await pending).map(match => match.id)).toEqual(["fixture-place", "fixture-0", "fixture-1", "fixture-2", "fixture-3", "fixture-4"]);
});

test("structured coordinates retain zero and inclusive WGS84 limits without parsing the address label", async () => {
  const fake = harness();
  const pending = fake.lookup(KEY, "Fixture address", new AbortController().signal);
  await fake.requestStarted.promise;
  const points = [position(0, 0), position(90, 180), position(-90, -180), position(12.345, -34.567)];
  fake.callbacks[0](points.map((point, i) => result({ place_id: `fixture-${i}`, formatted_address: "89.999, 179.999",
    geometry: { location: point, location_type: "APPROXIMATE" } })), "OK");
  expect((await pending).map(match => match.point)).toEqual([{ lat: 0, lng: 0 }, { lat: 90, lng: 180 }, { lat: -90, lng: -180 }, { lat: 12.345, lng: -34.567 }]);
});

test("nonfinite, nonnumeric, out-of-range and malformed SDK positions are discarded", async () => {
  const fake = harness();
  const pending = fake.lookup(KEY, "Fixture address", new AbortController().signal);
  await fake.requestStarted.promise;
  const invalid: unknown[] = [position(NaN, 0), position(0, Infinity), position(-Infinity, 0), position(90.1, 0), position(-90.1, 0),
    position(0, 180.1), position(0, -180.1), { lat: () => "12", lng: () => 34 }, { lat: 12, lng: 34 }, null,
    { lat() { throw new Error(PRIVATE_ERROR); }, lng: () => 34 }];
  fake.callbacks[0]([...invalid.map((point, i) => result({ place_id: `invalid-${i}`, formatted_address: "12, 34",
    geometry: { location: point as MapPosition, location_type: "ROOFTOP" } })), result()], "OK");
  expect((await pending).map(match => match.id)).toEqual(["fixture-place"]);
});

test("recommended viewport retains antimeridian crossings and drops invalid bounds", async () => {
  const fake = harness();
  const pending = fake.lookup(KEY, "Fixture address", new AbortController().signal);
  await fake.requestStarted.promise;
  const viewports = [bounds(20, -20, -170, 170), bounds(90, -90, 180, -180), bounds(-20, 20, 30, -30),
    bounds(91, 0, 30, -30), bounds(20, -20, Infinity, -30), { getNorthEast() { throw new Error(PRIVATE_ERROR); }, getSouthWest: () => position(0, 0) }];
  fake.callbacks[0](viewports.map((viewport, i) => result({ place_id: `fixture-${i}`,
    geometry: { location: position(0, 180), location_type: "APPROXIMATE", viewport } })), "OK");
  expect((await pending).map(match => match.viewport)).toEqual([
    { north: 20, south: -20, east: -170, west: 170 }, { north: 90, south: -90, east: 180, west: -180 }, undefined, undefined, undefined, undefined,
  ]);
});

test("malformed successful responses produce controlled errors", async () => {
  const invalid: unknown[] = [null, undefined, {}, [], [null], [result({ place_id: "" })], [result({ formatted_address: " " })],
    [result({ formatted_address: "A\0B" })], [result({ formatted_address: "A".repeat(501) })], [result({ place_id: "A\0B" })]];
  for (const payload of invalid) {
    const fake = harness();
    const pending = fake.lookup(KEY, "Fixture address", new AbortController().signal);
    await fake.requestStarted.promise;
    fake.callbacks[0](payload as GoogleGeocoderResult[], "OK");
    await expectError(pending, "INVALID_RESPONSE");
  }
});

test("ZERO_RESULTS returns an empty list", async () => {
  const fake = harness();
  const pending = fake.lookup(KEY, "Fixture address", new AbortController().signal);
  await fake.requestStarted.promise;
  fake.callbacks[0](null, "ZERO_RESULTS");
  await expect(pending).resolves.toEqual([]);
});

for (const [status, code] of [
  ["REQUEST_DENIED", "REQUEST_DENIED"], ["OVER_QUERY_LIMIT", "OVER_QUERY_LIMIT"], ["INVALID_REQUEST", "INVALID_QUERY"],
  ["ERROR", "UNAVAILABLE"], ["UNKNOWN_ERROR", "UNAVAILABLE"], [PRIVATE_ERROR, "UNAVAILABLE"],
] as const) test(`provider status ${status === PRIVATE_ERROR ? "unrecognized" : status} is sanitized without retries`, async () => {
  const fake = harness();
  const pending = fake.lookup(KEY, "Fixture address", new AbortController().signal);
  await fake.requestStarted.promise;
  fake.callbacks[0](null, status);
  await expectError(pending, code);
  if (status === "REQUEST_DENIED") await expect(pending).rejects.toThrow(/Geocoding API.*key.*permissions/);
  await drain();
  expect(fake.requests).toHaveLength(1);
});

for (const stage of ["load", "import", "constructor", "geocode", "promise"] as const) {
  test(`SDK ${stage} failure never exposes raw errors`, async () => {
    const fake = harness({ deferLoad: stage === "load", deferImport: stage === "import",
      onConstruct: () => { if (stage === "constructor") throw new Error(PRIVATE_ERROR); },
      onGeocode: () => { if (stage === "geocode") throw new Error(PRIVATE_ERROR); return Promise.reject(new Error(PRIVATE_ERROR)); } });
    const pending = fake.lookup(KEY, "Fixture address", new AbortController().signal);
    if (stage === "load") fake.loadGate.reject(new Error(PRIVATE_ERROR));
    if (stage === "import") { await fake.importStarted.promise; fake.importGate.reject(new Error(PRIVATE_ERROR)); }
    await expectError(pending, "UNAVAILABLE");
  });
}

test("callback statuses remain authoritative when the SDK also returns a rejected promise", async () => {
  for (const status of ["ZERO_RESULTS", "REQUEST_DENIED", "OVER_QUERY_LIMIT"] as const) {
    const fake = harness({ onGeocode: (_request, callback) => { callback(null, status); return Promise.reject(new Error(PRIVATE_ERROR)); } });
    const pending = fake.lookup(KEY, "Fixture address", new AbortController().signal);
    if (status === "ZERO_RESULTS") await expect(pending).resolves.toEqual([]);
    else await expectError(pending, status);
    await drain();
  }
});

test("already-aborted lookups never load Maps", async () => {
  const fake = harness(), controller = new AbortController();
  controller.abort(PRIVATE_ERROR);
  await expectError(fake.lookup(KEY, "Fixture address", controller.signal), "ABORTED");
  expect(fake.loads).toEqual([]);
});

for (const stage of ["load", "import"] as const) test(`abort during SDK ${stage} prevents later requests`, async () => {
  const fake = harness({ deferLoad: stage === "load", deferImport: stage === "import" });
  const controller = new AbortController();
  const pending = fake.lookup(KEY, "Fixture address", controller.signal);
  if (stage === "import") await fake.importStarted.promise;
  controller.abort(PRIVATE_ERROR);
  await expectError(pending, "ABORTED");
  fake.loadGate.resolve(fake.maps);
  fake.importGate.resolve(fake.library);
  await drain();
  expect(fake.requests).toEqual([]);
  expect(fake.constructions()).toBe(0);
  expect(fake.imports).toHaveLength(stage === "load" ? 0 : 1);
});

test("cancellation during geocoder construction still prevents dispatch", async () => {
  const controller = new AbortController();
  const fake = harness({ onConstruct: () => controller.abort() });
  await expectError(fake.lookup(KEY, "Fixture address", controller.signal), "ABORTED");
  expect(fake.requests).toEqual([]);
});

test("canceled requests ignore stale callbacks while a newer explicit search completes", async () => {
  const fake = harness(), firstController = new AbortController();
  const first = fake.lookup(KEY, "Old fixture address", firstController.signal);
  await fake.requestStarted.promise;
  firstController.abort();
  await expectError(first, "ABORTED");
  const second = fake.lookup(KEY, "New fixture address", new AbortController().signal);
  await drain();
  let staleReads = 0;
  fake.callbacks[0]([result({ geometry: { location: { lat: () => { staleReads++; return 0; }, lng: () => 0 }, location_type: "ROOFTOP" } })], "OK");
  fake.callbacks[0](null, "REQUEST_DENIED");
  fake.callbacks[1]([result({ place_id: "new-fixture" })], "OK");
  expect((await second)[0].id).toBe("new-fixture");
  expect(staleReads).toBe(0);
  expect(fake.requests).toHaveLength(2);
  await expectError(first, "ABORTED");
});

for (const stage of ["load", "import", "geocode"] as const) test(`timeout covers ${stage} and ignores late completion`, async () => {
  const fake = harness({ deferLoad: stage === "load", deferImport: stage === "import", timeoutMs: 20 });
  const pending = fake.lookup(KEY, "Fixture address", new AbortController().signal);
  await expectError(pending, "TIMEOUT");
  fake.loadGate.resolve(fake.maps);
  fake.importGate.resolve(fake.library);
  await drain();
  if (stage === "geocode") fake.callbacks[0]([result()], "OK");
  expect(fake.requests).toHaveLength(stage === "geocode" ? 1 : 0);
  expect(fake.imports).toHaveLength(stage === "load" ? 0 : 1);
  await expectError(pending, "TIMEOUT");
});

test("an elapsed deadline prevents library loading even before the timer can execute", async () => {
  const fake = harness();
  const lookup = createAddressLookup(async () => {
    const until = performance.now() + 25;
    while (performance.now() < until) { /* Model a busy event loop during SDK loading. */ }
    return fake.maps;
  }, 10);
  await expectError(lookup(KEY, "Fixture address", new AbortController().signal), "TIMEOUT");
  expect(fake.imports).toEqual([]);
  expect(fake.requests).toEqual([]);
});

test("successful completion ignores duplicate callbacks and later cancellation", async () => {
  const fake = harness({ timeoutMs: 20 }), controller = new AbortController();
  const pending = fake.lookup(KEY, "Fixture address", controller.signal);
  await fake.requestStarted.promise;
  fake.callbacks[0]([result()], "OK");
  const matches = await pending;
  controller.abort();
  fake.callbacks[0](null, "REQUEST_DENIED");
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(await pending).toBe(matches);
});
