import { test, expect } from "@playwright/test";
import {
  EARTH_STORAGE_KEY, earthSiteCatalog, emptyEarthStore, parseEarthCoordinates,
  readEarthStore, writeEarthStore, setSiteLocation, removeSiteLocation,
  type EarthAssociation, type EarthPoint, type EarthStore,
} from "../lib/earth-sites";
import { emptySiteComparisonStore, type SiteComparisonStore } from "../lib/site-comparison-storage";
import type { Site, SiteComparisonArtifact, SiteComparisonRequest } from "../lib/site-types";

const NOW = "2026-09-13T12:00:00.000Z";
const MAX_BYTES = 256 * 1024;
const SITE = { id: "site-A", revision: 1 };

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function association(overrides: Partial<EarthAssociation> = {}): EarthAssociation {
  return { siteId: SITE.id, siteRevision: SITE.revision, point: { lat: 0, lng: 0 }, updatedAt: NOW, source: "user_selected", version: 1, ...overrides };
}

function memoryStorage(raw: string | null = null) {
  const values = new Map<string, string>([
    ["acreiq.site-comparisons.v2", '{"immutableEvidence":"preserve exact bytes"}'],
    ["acreiq.workspace.v1", '{"lightingHistory":"preserve exact bytes"}'],
  ]);
  if (raw !== null) values.set(EARTH_STORAGE_KEY, raw);
  const reads: string[] = [], writes: string[] = [];
  return {
    values, reads, writes,
    getItem(key: string) { reads.push(key); return values.get(key) ?? null; },
    setItem(key: string, value: string) { writes.push(key); values.set(key, value); },
  };
}

function populatedStore(): EarthStore {
  return setSiteLocation(emptyEarthStore(), SITE, { lat: 0, lng: 0 }, NOW);
}

// These are metadata fixtures, not simulated results or verified comparison artifacts.
function request(id = "site-A", name = "Original site", revision = 1, source: Site["evidence"]["source"] = "synthetic_fixture"): SiteComparisonRequest {
  const evidence: Site["evidence"] = { id: "test-evidence", version: 1, source, entry_route: "sample", note: "Synthetic metadata fixture", recorded_at: null, instrument: null, conditions: null, uncertainty: null };
  return {
    site: { id, name, revision, boundary_id: "test-boundary", boundary_revision: 1, length_ft: null, width_ft: null, canopy_sqft: null, included_spaces: [], excluded_spaces: [], excluded_costs: [], evidence },
    assets: [], scenarios: [], limits: [], review: null, prior_comparison_id: null,
    goal: { id: "test-goal", version: 1, metric: "energy_kwh", direction: "minimize", secondary: [] },
    operation: { id: "test-operation", revision: 1, site_id: id, operation_type: "indoor_leafy_greens", operation_schema_version: 1,
      name: "Synthetic operation", crop: null, cultivar: null, method: null, start_stage: null, end_stage: null,
      product_definition: "Metadata fixture", output_unit: "kg_net_marketable_fresh", horizon_days: 1, cycle_days: 1,
      completed_cycles: 1, turnover_days: 0, idle_days: 0, identical_cycles: false, starts_per_cycle: null,
      temperature_c: null, humidity_pct: null, co2_ppm: null, ph: null, ec_ms_cm: null, nutrient_protocol: null, protocol_version: 1, evidence },
  };
}

function historical(input: SiteComparisonRequest, id: string, createdAt: string): SiteComparisonStore["history"][number] {
  const { review: _review, prior_comparison_id: _prior, ...inputs } = input;
  const payload: SiteComparisonArtifact["payload"] = {
    id, created_at: createdAt, parent_id: null, accounting_version: "site-scenario-accounting/1.0.0",
    benchmark_version: "user-output-benchmark/1.0.0", lighting_model_version: "test-only", input_snapshot: structuredClone(inputs),
    input_canonical_json: JSON.stringify(inputs), input_sha256: "0".repeat(64), review_status: "unreviewed",
    baseline_scenario_id: "test-current", evaluations: [], reused_evaluations: false,
    compatibility: { status: "not_comparable", reasons: ["Metadata fixture only"] }, ranks: [], preferred_scenario_ids: [],
    comparison_incomplete: true, scenario_count: 0, feasible_count: 0, differences: [], explanation: "Metadata fixture only", limitations: [],
  };
  return { important: true, artifact: { schema_version: "site-scenario-comparison/2.0.0", canonicalization: "python-json-sort-keys-ascii/1",
    payload, canonical_json: JSON.stringify(payload), sha256: "0".repeat(64) } };
}

test("coordinates accept zero, whitespace, fractions and inclusive WGS84 endpoints", () => {
  for (const [latitude, longitude, point] of [
    ["0", "0", { lat: 0, lng: 0 }],
    [" 0 ", " -97.7431 ", { lat: 0, lng: -97.7431 }],
    ["41.5", "0", { lat: 41.5, lng: 0 }],
    ["-90", "-180", { lat: -90, lng: -180 }],
    ["90", "180", { lat: 90, lng: 180 }],
  ] as const) expect(parseEarthCoordinates(latitude, longitude)).toEqual(point);
});

test("coordinates reject blank, nonfinite, partial and out-of-range values with axis-specific errors", () => {
  for (const [latitude, longitude, error] of [
    ["", "0", "Latitude is required."], [" \t\n", "0", "Latitude is required."],
    ["0", "", "Longitude is required."], ["0", " \t", "Longitude is required."],
    ["NaN", "0", "Latitude must be a finite number."], ["Infinity", "0", "Latitude must be a finite number."],
    ["0", "-Infinity", "Longitude must be a finite number."], ["1e999", "0", "Latitude must be a finite number."],
    ["0", "hello", "Longitude must be a finite number."], ["12 north", "0", "Latitude must be a finite number."],
    ["90.0001", "0", "Latitude must be between -90 and 90."], ["-90.0001", "0", "Latitude must be between -90 and 90."],
    ["0", "180.0001", "Longitude must be between -180 and 180."], ["0", "-180.0001", "Longitude must be between -180 and 180."],
  ]) expect(() => parseEarthCoordinates(latitude, longitude)).toThrow(error);
});

test("catalog reuses exact site IDs across history and prioritizes working name, revision and source", () => {
  const older = historical(request("site-A", "Old name", 9, "measured"), "comparison-old", "2026-09-13T11:00:00Z");
  const newer = historical(request("site-A", "Renamed history", 10), "comparison-new", "2026-09-13T08:00:00-05:00");
  newer.artifact.payload.input_snapshot.goal.metric = "output_kg";
  const store = freeze({ ...emptySiteComparisonStore(), working: request("site-A", "Working name", 2, "user_assumption"), history: [older, newer] });
  expect(earthSiteCatalog(store)).toEqual([{
    id: "site-A", name: "Working name", revision: 2, source: "user_assumption",
    comparisons: [
      { id: "comparison-new", createdAt: "2026-09-13T08:00:00-05:00", goalMetric: "output_kg", siteRevision: 10 },
      { id: "comparison-old", createdAt: "2026-09-13T11:00:00Z", goalMetric: "energy_kwh", siteRevision: 9 },
    ],
  }]);
  const historyOnly = { ...store, working: null, history: [older, { ...newer, artifact: { ...newer.artifact,
    payload: { ...newer.artifact.payload, input_snapshot: { ...newer.artifact.payload.input_snapshot, site: { ...newer.artifact.payload.input_snapshot.site, revision: 1 } } } } }] };
  expect(earthSiteCatalog(historyOnly)[0]).toMatchObject({ id: "site-A", name: "Renamed history", revision: 1, source: "synthetic_fixture" });
});

test("catalog keeps two same-named sites distinct, handles an empty store, and returns detached metadata", () => {
  expect(earthSiteCatalog(emptySiteComparisonStore())).toEqual([]);
  const entry = historical(request("site-a", "Same name"), "comparison-1", NOW);
  const store = freeze({ ...emptySiteComparisonStore(), working: request("site-A", "Same name"), history: [entry, entry] });
  const before = JSON.stringify(store);
  const catalog = earthSiteCatalog(store);
  expect(catalog.map(site => site.id)).toEqual(["site-A", "site-a"]);
  expect(catalog[0].comparisons).toEqual([]);
  expect(catalog[1].comparisons).toHaveLength(1);
  catalog[1].name = "Changed display";
  catalog[1].comparisons[0].goalMetric = "Changed display";
  expect(JSON.stringify(store)).toBe(before);
});

test("empty stores are independent and reading absent storage never writes defaults", () => {
  const first = emptyEarthStore(), second = emptyEarthStore();
  first.associations.push(association());
  expect(second).toEqual({ version: 1, associations: [] });
  const storage = memoryStorage();
  expect(EARTH_STORAGE_KEY).toBe("acreiq.earth-locations.v1");
  expect(readEarthStore(storage)).toEqual({ ok: true, store: second, raw: null });
  expect(storage.writes).toEqual([]);
});

test("two locations round trip without reading or writing comparison and lighting storage", () => {
  const storage = memoryStorage();
  const otherBytes = [...storage.values.entries()];
  const next = setSiteLocation(populatedStore(), { id: "site-B", revision: 6 }, { lat: -90, lng: 180 }, NOW);
  const result = writeEarthStore(storage, freeze(next), null);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.message);
  expect(result.raw).toBe(JSON.stringify(next));
  expect(readEarthStore(storage)).toEqual({ ok: true, store: next, raw: result.raw });
  expect(storage.reads.every(key => key === EARTH_STORAGE_KEY)).toBe(true);
  expect(storage.writes).toEqual([EARTH_STORAGE_KEY]);
  for (const [key, bytes] of otherBytes) expect(storage.values.get(key)).toBe(bytes);
});

test("upsert versions only the exact site, copies points, and removal leaves immutable evidence untouched", () => {
  const comparisons = freeze({ ...emptySiteComparisonStore(), working: request(), history: [historical(request(), "comparison-1", NOW)] });
  const evidenceBytes = JSON.stringify(comparisons);
  const [site] = earthSiteCatalog(comparisons);
  const point = { lat: 30, lng: -97 };
  const first = freeze(setSiteLocation(emptyEarthStore(), site, point, NOW));
  point.lat = 80;
  expect(first.associations[0]).toEqual(association({ point: { lat: 30, lng: -97 } }));
  const second = freeze(setSiteLocation(first, { id: "site-B", revision: 2 }, { lat: 0, lng: 0 }, NOW));
  const updated = setSiteLocation(second, { id: "site-A", revision: 3 }, { lat: 0, lng: 179 }, "2026-09-14T00:00:00Z");
  expect(updated.associations).toEqual([
    association({ siteRevision: 3, version: 2, point: { lat: 0, lng: 179 }, updatedAt: "2026-09-14T00:00:00Z" }),
    association({ siteId: "site-B", siteRevision: 2 }),
  ]);
  expect(second.associations[0].version).toBe(1);
  updated.associations[1].point.lng = 15;
  expect(second.associations[1].point.lng).toBe(0);
  const removed = removeSiteLocation(second, "site-A");
  expect(removed.associations).toEqual([association({ siteId: "site-B", siteRevision: 2 })]);
  expect(removeSiteLocation(removed, "missing-site")).toEqual(removed);
  expect(removeSiteLocation(removed, "site-B")).toEqual(emptyEarthStore());
  expect(setSiteLocation(removeSiteLocation(first, site.id), site, { lat: 0, lng: 0 }, NOW).associations[0].version).toBe(1);
  expect(JSON.stringify(comparisons)).toBe(evidenceBytes);
  expect(Object.keys(first.associations[0]).sort()).toEqual(["point", "siteId", "siteRevision", "source", "updatedAt", "version"]);
});

test("site identifiers and revisions obey the existing bounded contract without normalization", () => {
  for (const id of ["A", "0", "Site_A.b:c-9", "a".repeat(80), "constructor"]) {
    expect(setSiteLocation(emptyEarthStore(), { id, revision: 1000000 }, { lat: 0, lng: 0 }, NOW).associations[0].siteId).toBe(id);
  }
  for (const id of ["", " site-A", "site-A ", "site/A", "_site", "-site", "a".repeat(81), "site\n", "s\u00edte", "__proto__"]) {
    expect(() => setSiteLocation(emptyEarthStore(), { id, revision: 1 }, { lat: 0, lng: 0 }, NOW)).toThrow("Invalid site ID.");
    expect(() => removeSiteLocation(emptyEarthStore(), id)).toThrow("Invalid site ID.");
  }
  for (const revision of [0, -1, 1.5, 1000001, NaN, Infinity, "1" as unknown as number]) {
    expect(() => setSiteLocation(emptyEarthStore(), { id: SITE.id, revision }, { lat: 0, lng: 0 }, NOW)).toThrow("Invalid site revision.");
  }
});

test("timestamps require real ISO calendar dates, times and timezone offsets", () => {
  for (const updatedAt of [NOW, "2024-02-29T23:59:59Z", "2000-02-29T00:00:00.123456789+05:30", "2026-09-13T00:00:00-05:00"]) {
    expect(setSiteLocation(emptyEarthStore(), SITE, { lat: 0, lng: 0 }, updatedAt).associations[0].updatedAt).toBe(updatedAt);
  }
  for (const updatedAt of ["", "yesterday", "2026-09-13", "2026-09-13T12:00:00", "2026-02-29T00:00:00Z", "1900-02-29T00:00:00Z",
    "2026-02-30T00:00:00Z", "2026-04-31T00:00:00Z", "2026-00-01T00:00:00Z", "2026-13-01T00:00:00Z", "2026-01-00T00:00:00Z",
    "2026-01-01T24:00:00Z", "2026-01-01T23:60:00Z", "2026-01-01T23:59:60Z", "2026-01-01T00:00:00+24:00", "2026-01-01T00:00:00+00:60",
    `${NOW} `, NOW.repeat(3), null as unknown as string]) {
    expect(() => setSiteLocation(emptyEarthStore(), SITE, { lat: 0, lng: 0 }, updatedAt)).toThrow("Updated time must be a valid ISO timestamp.");
  }
});

test("unknown, corrupt and extra storage fields preserve exact prior bytes on read and write", () => {
  const a = association();
  const invalid = ["", "{broken", "null", "[]", "true", "{}", '{"version":2,"associations":[]}', '{"version":1,"associations":null}',
    ...[
      { ...emptyEarthStore(), extra: "unrecognized" }, { version: 1, associations: [null] },
      { version: 1, associations: [a, a] }, { version: 1, associations: [{ ...a, source: "measured" }] },
      { version: 1, associations: [{ ...a, siteId: "invalid/site" }] }, { version: 1, associations: [{ ...a, siteRevision: 0 }] },
      { version: 1, associations: [{ ...a, siteRevision: "1" }] }, { version: 1, associations: [{ ...a, version: 0 }] },
      { version: 1, associations: [{ ...a, version: 1.5 }] }, { version: 1, associations: [{ ...a, version: Number.MAX_SAFE_INTEGER + 1 }] },
      { version: 1, associations: [{ ...a, measured: true }] }, { version: 1, associations: [{ ...a, source: undefined }] },
      { version: 1, associations: [{ ...a, updatedAt: "2026-02-30T00:00:00Z" }] },
      ...[null, [], { lat: 0 }, { lat: "0", lng: 0 }, { lat: 91, lng: 0 }, { lat: 0, lng: -181 }, { lat: null, lng: 0 }, { lat: 0, lng: 0, accuracy: 1 }]
        .map(point => ({ version: 1, associations: [{ ...a, point }] })),
    ].map(value => JSON.stringify(value)),
    '{"version":1,"associations":[],"__proto__":{"polluted":true}}',
    JSON.stringify({ version: 1, associations: [a] }).replace('"lat":0', '"lat":1e999'),
  ];
  for (const raw of invalid) {
    const storage = memoryStorage(raw);
    expect(readEarthStore(storage), raw).toMatchObject({ ok: false, raw, message: expect.any(String) });
    expect(writeEarthStore(storage, populatedStore(), raw), raw).toMatchObject({ ok: false, message: expect.any(String) });
    expect(storage.values.get(EARTH_STORAGE_KEY)).toBe(raw);
    expect(storage.writes).toEqual([]);
  }
});

test("invalid in-memory points, sparse arrays and version overflow fail without changing stored or input data", () => {
  const first = freeze(populatedStore());
  for (const point of [{ lat: NaN, lng: 0 }, { lat: Infinity, lng: 0 }, { lat: 0, lng: -Infinity }, { lat: 0, lng: 181 },
    { lat: 0, lng: 0, evidence: "measured" }, { lat: "0", lng: 0 }]) {
    expect(() => setSiteLocation(first, SITE, point as EarthPoint, NOW)).toThrow();
    const raw = JSON.stringify(first), storage = memoryStorage(raw);
    const next = { version: 1, associations: [association({ point: point as EarthPoint })] } as EarthStore;
    expect(writeEarthStore(storage, next, raw)).toMatchObject({ ok: false });
    expect(storage.values.get(EARTH_STORAGE_KEY)).toBe(raw);
    expect(storage.writes).toEqual([]);
  }
  const maxed: EarthStore = freeze({ version: 1, associations: [association({ version: Number.MAX_SAFE_INTEGER })] });
  expect(() => setSiteLocation(maxed, SITE, { lat: 1, lng: 1 }, NOW)).toThrow("Invalid association version.");
  expect(maxed.associations[0].version).toBe(Number.MAX_SAFE_INTEGER);
  const sparse: EarthStore = { version: 1, associations: new Array(1) };
  expect(writeEarthStore(memoryStorage(), sparse, null)).toMatchObject({ ok: false });
  expect(() => removeSiteLocation(sparse, SITE.id)).toThrow();
});

test("the 1000-association bound rejects additions without evicting and allows updates and explicit removals", () => {
  const full: EarthStore = freeze({ version: 1, associations: Array.from({ length: 1000 }, (_, i) => association({ siteId: `site-${i}` })) });
  const raw = JSON.stringify(full), storage = memoryStorage(raw);
  expect(readEarthStore(storage)).toEqual({ ok: true, store: full, raw });
  expect(() => setSiteLocation(full, SITE, { lat: 0, lng: 0 }, NOW)).toThrow(/1000 association limit/);
  const overflow: EarthStore = { version: 1, associations: [...full.associations, association()] };
  expect(writeEarthStore(storage, overflow, raw)).toMatchObject({ ok: false, message: expect.stringContaining("1000") });
  expect(readEarthStore(memoryStorage(JSON.stringify(overflow)))).toMatchObject({ ok: false, message: expect.stringContaining("1000") });
  expect(storage.values.get(EARTH_STORAGE_KEY)).toBe(raw);
  expect(full.associations).toHaveLength(1000);
  const updated = setSiteLocation(full, { id: "site-0", revision: 2 }, { lat: 1, lng: 2 }, NOW);
  expect(updated.associations).toHaveLength(1000);
  expect(updated.associations[0].version).toBe(2);
  expect(writeEarthStore(storage, updated, raw).ok).toBe(true);
  const updatedRaw = storage.values.get(EARTH_STORAGE_KEY)!;
  const removed = removeSiteLocation(updated, "site-0");
  expect(writeEarthStore(storage, removed, updatedRaw).ok).toBe(true);
  expect(readEarthStore(storage)).toMatchObject({ ok: true, store: removed });
});

test("raw storage has an inclusive 256 KiB UTF-8 bound and writes never truncate oversized stores", () => {
  const small = JSON.stringify(emptyEarthStore());
  const boundary = small.padEnd(MAX_BYTES, " ");
  expect(readEarthStore(memoryStorage(boundary))).toEqual({ ok: true, store: emptyEarthStore(), raw: boundary });
  const multibyte = JSON.stringify({ extra: "\u00e9".repeat(MAX_BYTES / 2) });
  expect(multibyte.length).toBeLessThan(MAX_BYTES);
  for (const raw of [`${boundary} `, multibyte]) {
    const storage = memoryStorage(raw);
    expect(readEarthStore(storage)).toMatchObject({ ok: false, raw, message: expect.stringContaining("256 KiB") });
    expect(writeEarthStore(storage, emptyEarthStore(), raw)).toMatchObject({ ok: false, message: expect.stringContaining("256 KiB") });
    expect(storage.values.get(EARTH_STORAGE_KEY)).toBe(raw);
  }
  const oversized: EarthStore = { version: 1, associations: Array.from({ length: 1000 }, (_, i) => association({
    siteId: `site-${i}`.padEnd(80, "x"), point: { lat: -89.12345678901234, lng: -179.12345678901234 },
    updatedAt: "2026-09-13T00:00:00.123456789+05:30", version: Number.MAX_SAFE_INTEGER,
  })) };
  expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBeGreaterThan(MAX_BYTES);
  const storage = memoryStorage(small);
  expect(writeEarthStore(storage, oversized, small)).toMatchObject({ ok: false, message: expect.stringContaining("256 KiB") });
  expect(storage.values.get(EARTH_STORAGE_KEY)).toBe(small);
  expect(storage.writes).toEqual([]);
});

test("stale writes, including first-save and deletion conflicts, preserve the newer bytes", () => {
  const storage = memoryStorage();
  const first = writeEarthStore(storage, populatedStore(), null);
  if (!first.ok) throw new Error(first.message);
  const next = setSiteLocation(populatedStore(), { id: "site-B", revision: 1 }, { lat: 1, lng: 2 }, NOW);
  const second = writeEarthStore(storage, next, first.raw);
  if (!second.ok) throw new Error(second.message);
  for (const expectedRaw of [null, first.raw]) {
    expect(writeEarthStore(storage, emptyEarthStore(), expectedRaw)).toMatchObject({ ok: false, message: expect.stringContaining("changed") });
    expect(storage.values.get(EARTH_STORAGE_KEY)).toBe(second.raw);
  }
  storage.values.delete(EARTH_STORAGE_KEY);
  expect(writeEarthStore(storage, next, second.raw)).toMatchObject({ ok: false, message: expect.stringContaining("changed") });
  expect(storage.values.has(EARTH_STORAGE_KEY)).toBe(false);
});

test("storage changes during validation are detected before the final write", () => {
  const previous = JSON.stringify(emptyEarthStore()), newer = JSON.stringify(populatedStore());
  let reads = 0, writes = 0;
  const storage = { getItem() { return ++reads === 1 ? previous : newer; }, setItem() { writes++; } };
  expect(writeEarthStore(storage, populatedStore(), previous)).toMatchObject({ ok: false, message: expect.stringContaining("changed") });
  expect(writes).toBe(0);
});

test("unavailable storage and quota failures are contained without replacing previous data", () => {
  let writes = 0;
  const unavailable = { getItem() { throw new Error("denied"); }, setItem() { writes++; } };
  expect(readEarthStore(unavailable)).toEqual({ ok: false, message: "Earth location storage is unavailable.", raw: null });
  expect(writeEarthStore(unavailable, populatedStore(), null)).toMatchObject({ ok: false });
  expect(writes).toBe(0);
  const previous = JSON.stringify(emptyEarthStore());
  for (const name of ["QuotaExceededError", "SecurityError"]) {
    const storage = memoryStorage(previous);
    const failing = { getItem: storage.getItem, setItem() { throw new DOMException("Cannot save", name); } };
    expect(writeEarthStore(failing, populatedStore(), previous)).toMatchObject({ ok: false, message: expect.stringContaining("preserved") });
    expect(storage.values.get(EARTH_STORAGE_KEY)).toBe(previous);
    expect(storage.writes).toEqual([]);
  }
  const noOp = memoryStorage(previous);
  expect(writeEarthStore(noOp, emptyEarthStore(), previous)).toEqual({ ok: true, raw: previous });
  expect(noOp.writes).toEqual([]);
});
