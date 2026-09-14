import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { createCurrentSitePlan, createPlanningSite, siteDraftMissingFields, toSiteComparisonRequest, type SitePlanDraft } from "../lib/site-drafts";
import { activateSiteWorking, appendSiteComparison, deserializeSiteComparisonStore, emptySiteComparisonStore, MAX_OTHER_SITE_DRAFTS, readSiteComparisonStore, selectSiteComparison, serializeSiteComparisonStore, SITE_COMPARISON_STORAGE_KEY, validateSiteComparisonArtifact, validateSitePlanDraft, withSiteWorking, writeSiteComparisonStore, type SiteComparisonStore } from "../lib/site-comparison-storage";
import type { SiteComparisonArtifact, SiteComparisonRequest } from "../lib/site-types";

const root = path.resolve(__dirname, "../..");
const python = path.join(root, process.platform === "win32" ? "backend/.venv/Scripts/python.exe" : "backend/.venv/bin/python");
let artifact: SiteComparisonArtifact;
let fixtureRequest: SiteComparisonRequest;
test.beforeAll(() => {
  const generated = JSON.parse(execFileSync(python, ["-W", "ignore", "-c", `
import json
from backend.site_fixture import fixture
from backend.site_schemas import ComparisonRequest
from backend.site_comparison import compare, ComparisonRegistry
r = ComparisonRequest.model_validate(fixture())
print(json.dumps({'request': r.model_dump(), 'artifact': compare(r, ComparisonRegistry())}))
`], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
  fixtureRequest = generated.request;
  artifact = generated.artifact;
});

function ok<T>(result: { ok: true; value: T } | { ok: false; message: string }): T {
  if (!result.ok) throw new Error(result.message);
  return result.value;
}
function memory(initial: string | null = null) {
  let raw = initial, full = false, writes = 0;
  return { get writes() { return writes; }, fill() { full = true; },
    getItem(key: string) { expect(key).toBe(SITE_COMPARISON_STORAGE_KEY); return raw; },
    setItem(key: string, value: string) { expect(key).toBe(SITE_COMPARISON_STORAGE_KEY); if (full) throw new DOMException("Quota exceeded", "QuotaExceededError"); writes++; raw = value; },
  };
}

/** Explicit test inputs, not factory defaults or measurements. */
function readyDraft(): SitePlanDraft {
  const draft = createCurrentSitePlan(createPlanningSite("Explicit test inputs"));
  Object.assign(draft.operation, { product_definition: "TEST-ONLY marketable fresh leaves after grading", horizon_days: 28, cycle_days: 28, completed_cycles: 1, turnover_days: 0, idle_days: 0 });
  draft.assets = [{ id: "test-light", revision: 1, site_id: draft.site.id, name: "Test light", kind: "lighting", quantity: 1, ownership: "unknown", available: null, power_basis: "aggregate", watts: null, component_ids: ["test-light-component"], footprint_sqft: null, evidence: structuredClone(draft.site.evidence) }];
  const scenario = draft.scenarios[0];
  Object.assign(scenario.lighting, { hours_per_day: 16, dim_fraction: 1, min_hours: 10, max_hours: 18 });
  scenario.loads = [{ id: "test-light-load", asset_id: "test-light", asset_revision: 1, component_ids: ["test-light-component"], accounting: "lighting", hours_per_day: 16, status: "unknown", reason: "Unreviewed test input; wattage unknown." }];
  draft.scenarios.push({ ...structuredClone(scenario), id: "test-alternative", name: "Test alternative", role: "alternative" });
  return draft;
}

test("blank sites have stable, unique identities and no synthetic inputs or geographic claims", () => {
  const first = createPlanningSite("  North site  "), second = createPlanningSite("North site");
  expect(first.site.name).toBe("North site");
  expect(first.site.id).not.toBe(second.site.id);
  expect(first.site.boundary_id).not.toBe(second.site.boundary_id);
  expect(first.operation.site_id).toBe(first.site.id);
  expect(first.assets).toEqual([]); expect(first.scenarios).toEqual([]);
  expect(first.site).toMatchObject({ length_ft: null, width_ft: null, canopy_sqft: null, included_spaces: [], excluded_spaces: [], excluded_costs: [] });
  expect(first.operation).toMatchObject({ operation_type: "indoor_leafy_greens", crop: null, horizon_days: null, cycle_days: null, completed_cycles: null, turnover_days: null, idle_days: null, starts_per_cycle: null });
  expect(first.operation.product_definition).toBe("");
  for (const evidence of [first.site.evidence, first.operation.evidence]) expect(evidence).toMatchObject({ source: "user_assumption", entry_route: "manual", note: expect.stringContaining("Unreviewed"), recorded_at: null, instrument: null });
  expect(first.limits.map(limit => limit.metric)).toEqual(["dli", "peak_watts", "lighting_hours"]);
  expect(first.limits.every(limit => limit.enabled && limit.minimum === null && limit.maximum === null && limit.evidence.source === "user_assumption")).toBe(true);
  expect(first.review).toBeNull(); expect(first.prior_comparison_id).toBeNull();
  expect(first.site.evidence.note).toContain("No parcel boundary or ownership");
  expect(first.operation.evidence.note).toContain("not a whole-farm model");
  expect(validateSitePlanDraft(first)).toMatchObject({ ok: true });
  expect(() => createPlanningSite(" ")).toThrow(/name/);
  expect(() => createPlanningSite("x".repeat(601))).toThrow(/600/);
});

test("create current plan is immutable and idempotent with all eight costs unknown", () => {
  const blank = createPlanningSite("Test site"), before = structuredClone(blank);
  const draft = createCurrentSitePlan(blank), plan = draft.scenarios[0];
  expect(blank).toEqual(before); expect(draft.site).toEqual(blank.site);
  expect(draft.scenarios).toHaveLength(1); expect(plan.role).toBe("current");
  expect(plan.benchmark).toBeNull(); expect(plan.loads).toEqual([]); expect(draft.assets).toEqual([]);
  expect(plan.lighting).toEqual({ hours_per_day: null, dim_fraction: null, dimmable: false, ppfd_full: null, ppfd_basis: null, min_dli: null, min_hours: null, max_hours: null, power_limit_watts: null });
  expect(plan.water_liters_day).toBeNull(); expect(plan.routine_labor_hours_cycle).toBeNull(); expect(plan.setup_labor_hours).toBeNull();
  expect(plan.costs.map(cost => cost.category)).toEqual(["electricity", "water", "routine_labor", "consumables", "maintenance", "new_equipment", "setup_labor", "setup_materials"]);
  for (const cost of plan.costs) {
    expect(cost).toMatchObject({ status: "unknown", rate: null, amount: null, asset_ids: [], evidence: { source: "user_assumption", entry_route: "manual", note: expect.stringContaining("Unreviewed") } });
    expect(cost.reason).toContain("not zero or excluded");
  }
  expect(createCurrentSitePlan(draft)).toEqual(draft);
  expect(createCurrentSitePlan(draft)).not.toBe(draft);
});

test("zero and one-plan drafts save and reload without needing an evaluated result", async () => {
  const storage = memory();
  let state = ok(withSiteWorking(emptySiteComparisonStore(), createPlanningSite("Empty planning site")));
  const first = await writeSiteComparisonStore(storage, state, null);
  expect(first.ok).toBe(true); expect(JSON.parse(first.raw!).schema_version).toBe(3);
  expect(ok(await readSiteComparisonStore(storage))).toEqual(state);
  state = ok(withSiteWorking(state, createCurrentSitePlan(state.working!)));
  const second = await writeSiteComparisonStore(storage, state, first.raw);
  expect(second.ok).toBe(true);
  const read = ok(await readSiteComparisonStore(storage));
  expect(read).toEqual(state); expect(read.working!.scenarios[0].lighting.hours_per_day).toBeNull();
  expect(read.history).toEqual([]);
});

test("legacy v2 migrates on explicit write without changing working inputs or exact history", async () => {
  const legacy: SiteComparisonStore = { working: structuredClone(fixtureRequest), history: [{ artifact: structuredClone(artifact), important: true }], selectedComparisonId: artifact.payload.id, selectedScenarioId: artifact.payload.baseline_scenario_id };
  const raw = JSON.stringify({ schema_version: 2, ...legacy });
  const storage = memory(raw), loaded = await readSiteComparisonStore(storage);
  expect(ok(loaded)).toEqual(legacy); expect(loaded.raw).toBe(raw); expect(storage.writes).toBe(0);
  const saved = await writeSiteComparisonStore(storage, ok(loaded), raw);
  expect(saved.ok).toBe(true); expect(JSON.parse(saved.raw!).schema_version).toBe(3);
  expect(ok(await readSiteComparisonStore(storage))).toEqual(legacy);
  expect(ok(await readSiteComparisonStore(storage)).history[0].artifact.canonical_json).toBe(artifact.canonical_json);
  expect(ok(await readSiteComparisonStore(storage)).history[0].important).toBe(true);
});

test("old caller object literals and optional v3 fields remain accepted", async () => {
  const oldCaller: SiteComparisonStore = { working: fixtureRequest, history: [], selectedComparisonId: null, selectedScenarioId: null };
  expect(ok(await deserializeSiteComparisonStore(ok(await serializeSiteComparisonStore(oldCaller))))).toEqual(oldCaller);
  const empty = emptySiteComparisonStore();
  expect(ok(await deserializeSiteComparisonStore(JSON.stringify({ schema_version: 3, ...empty })))).toEqual(empty);
  expect(ok(await deserializeSiteComparisonStore(JSON.stringify({ schema_version: 3, ...empty, otherWorking: [], selectedSiteId: null })))).toEqual({ ...empty, otherWorking: [], selectedSiteId: null });
});

test("site switching parks exact drafts and retains all historical artifacts without shared mutations", async () => {
  const a = createCurrentSitePlan(createPlanningSite("First site")), b = createCurrentSitePlan(createPlanningSite("Second site"));
  a.site.length_ft = 20; b.site.length_ft = 35;
  const historical = ok(appendSiteComparison(emptySiteComparisonStore(), artifact));
  let state = ok(withSiteWorking(historical, a));
  const before = structuredClone(state);
  state = ok(withSiteWorking(state, b));
  expect(before.working).toEqual(a); expect(state.working).toEqual(b); expect(state.otherWorking).toEqual([a]);
  expect(state.history).toEqual(historical.history); expect(state.selectedSiteId).toBe(b.site.id);
  expect(state.selectedComparisonId).toBeNull(); expect(state.selectedScenarioId).toBe(b.scenarios[0].id);
  b.site.length_ft = 999;
  expect(state.working!.site.length_ft).toBe(35);
  state = ok(activateSiteWorking(state, a.site.id));
  expect(state.working).toEqual(a); expect(state.otherWorking?.[0].site.length_ft).toBe(35);
  const edited = structuredClone(state.working!); edited.site.name = "Edited first site"; edited.operation.idle_days = 2;
  state = ok(withSiteWorking(state, edited));
  state = ok(activateSiteWorking(state, state.otherWorking![0].site.id));
  state = ok(activateSiteWorking(state, a.site.id));
  expect(state.working).toEqual(edited);
  expect(ok(await deserializeSiteComparisonStore(ok(await serializeSiteComparisonStore(state))))).toEqual(state);
});

test("history-only sites never turn into working copies, even after selecting their result", () => {
  const working = createPlanningSite("Real unknown site");
  const state = ok(appendSiteComparison(ok(withSiteWorking(emptySiteComparisonStore(), working)), artifact));
  expect(state.working).toEqual(working);
  expect(state.selectedSiteId).toBe(artifact.payload.input_snapshot.site.id);
  expect(activateSiteWorking(state, artifact.payload.input_snapshot.site.id)).toMatchObject({ ok: false, code: "not_found" });
  expect(ok(selectSiteComparison(state, artifact.payload.id)).working).toEqual(working);
  expect(ok(activateSiteWorking(state, working.site.id))).toMatchObject({ selectedSiteId: working.site.id, selectedComparisonId: null });
  expect(activateSiteWorking(state, "missing")).toMatchObject({ ok: false, code: "not_found" });
});

test("bounded parked sites never evict previous drafts and switching at the bound succeeds", async () => {
  let state = emptySiteComparisonStore();
  for (let i = 0; i <= MAX_OTHER_SITE_DRAFTS; i++) state = ok(withSiteWorking(state, createPlanningSite(`Site ${i}`)));
  expect(state.otherWorking).toHaveLength(MAX_OTHER_SITE_DRAFTS);
  const before = structuredClone(state);
  expect(withSiteWorking(state, createPlanningSite("Too many"))).toMatchObject({ ok: false, code: "too_large" });
  expect(state).toEqual(before);
  const restored = ok(activateSiteWorking(state, state.otherWorking![0].site.id));
  expect(restored.otherWorking).toHaveLength(MAX_OTHER_SITE_DRAFTS);
  expect(ok(await serializeSiteComparisonStore(restored))).toBeTruthy();
  expect(await serializeSiteComparisonStore({ ...state, otherWorking: [...state.otherWorking!, createPlanningSite("Overflow")] })).toMatchObject({ ok: false });
});

test("duplicate working site identities and invalid selected sites fail without overwriting bytes", async () => {
  const draft = createPlanningSite("Original"), state = ok(withSiteWorking(emptySiteComparisonStore(), draft));
  const conflicting = { ...state, otherWorking: [{ ...structuredClone(draft), site: { ...draft.site, name: "Conflicting copy" } }] };
  expect(withSiteWorking(conflicting, draft)).toMatchObject({ ok: false, code: "storage_conflict" });
  expect(await serializeSiteComparisonStore(conflicting)).toMatchObject({ ok: false });
  expect(await serializeSiteComparisonStore({ ...state, selectedSiteId: "missing" })).toMatchObject({ ok: false });
  const storage = memory(), saved = await writeSiteComparisonStore(storage, state, null);
  expect(await writeSiteComparisonStore(storage, conflicting, saved.raw)).toMatchObject({ ok: false, sessionOnly: true });
  expect(storage.getItem(SITE_COMPARISON_STORAGE_KEY)).toBe(saved.raw);
});

test("saving refuses silent loss of a parked or active site as well as historical evidence", async () => {
  let state = ok(withSiteWorking(emptySiteComparisonStore(), createPlanningSite("A")));
  state = ok(withSiteWorking(state, createPlanningSite("B")));
  state = ok(appendSiteComparison(state, artifact));
  const storage = memory(), saved = await writeSiteComparisonStore(storage, state, null);
  for (const dropped of [{ ...state, otherWorking: [] }, { ...state, working: null }, { ...state, history: [] }]) {
    expect(await writeSiteComparisonStore(storage, dropped, saved.raw)).toMatchObject({ ok: false, sessionOnly: true });
    expect(storage.getItem(SITE_COMPARISON_STORAGE_KEY)).toBe(saved.raw);
  }
});

test("corrupt, unsupported and conflicting bytes remain untouched", async () => {
  const state = ok(withSiteWorking(emptySiteComparisonStore(), createPlanningSite("Session only")));
  for (const raw of ["{broken", '{"schema_version":4,"private":"preserve"}', '{"schema_version":3,"working":null}', JSON.stringify({ schema_version: 2, ...state })]) {
    const storage = memory(raw);
    expect(await writeSiteComparisonStore(storage, state, raw)).toMatchObject({ ok: false, sessionOnly: true });
    expect(storage.getItem(SITE_COMPARISON_STORAGE_KEY)).toBe(raw); expect(storage.writes).toBe(0);
  }
  const storage = memory(), first = await writeSiteComparisonStore(storage, state, null);
  const next = ok(withSiteWorking(state, createPlanningSite("Second tab")));
  const second = await writeSiteComparisonStore(storage, next, first.raw);
  expect(second.ok).toBe(true);
  expect(await writeSiteComparisonStore(storage, state, first.raw)).toMatchObject({ ok: false, code: "storage_conflict" });
  expect(storage.getItem(SITE_COMPARISON_STORAGE_KEY)).toBe(second.raw);
  storage.fill();
  expect(await writeSiteComparisonStore(storage, next, second.raw)).toMatchObject({ ok: false, code: "storage_full", sessionOnly: true });
  expect(storage.getItem(SITE_COMPARISON_STORAGE_KEY)).toBe(second.raw);
});

test("the final concurrency check protects against changes during asynchronous artifact validation", async () => {
  const state = ok(appendSiteComparison(emptySiteComparisonStore(), artifact));
  const raw = ok(await serializeSiteComparisonStore(state)), other = `${raw} `;
  let reads = 0, writes = 0;
  const storage = { getItem() { return ++reads === 1 ? raw : other; }, setItem() { writes++; } };
  expect(await writeSiteComparisonStore(storage, state, raw)).toMatchObject({ ok: false, code: "storage_conflict" });
  expect(writes).toBe(0);
});

test("draft type, number bounds, IDs and all supplied references remain protected", async () => {
  const cases: [string, (draft: SitePlanDraft) => void][] = [
    ["string number", d => { d.operation.horizon_days = "28" as unknown as number; }],
    ["fractional cycle", d => { d.operation.completed_cycles = 1.5; }],
    ["range", d => { d.operation.horizon_days = 367; }],
    ["nonfinite", d => { d.scenarios[0].lighting.min_hours = Infinity; }],
    ["zero hours", d => { d.scenarios[0].lighting.hours_per_day = 0; }],
    ["invalid ID", d => { d.site.id = "bad id"; }],
    ["cross-site operation", d => { d.operation.site_id = "another-site"; }],
    ["cross-site asset", d => { d.assets[0].site_id = "another-site"; }],
    ["duplicate scenario", d => { d.scenarios[1].id = d.scenarios[0].id; }],
    ["two current", d => { d.scenarios[1].role = "current"; }],
    ["stale revision", d => { d.scenarios[0].site_revision++; }],
    ["bad load reference", d => { d.scenarios[0].loads[0].asset_id = "missing"; }],
    ["bad load component", d => { d.scenarios[0].loads[0].component_ids = ["wrong"]; }],
    ["bad expense asset", d => { d.scenarios[0].costs[0].asset_ids = ["missing"]; }],
    ["wrong source", d => { d.site.evidence.source = "verified" as "measured"; }],
    ["unsupported operation", d => { d.operation.operation_type = "outdoor" as "indoor_leafy_greens"; }],
    ["extra claim", d => { (d as unknown as Record<string, unknown>).serverVerified = true; }],
  ];
  for (const [name, mutate] of cases) {
    const draft = readyDraft(); mutate(draft);
    expect(validateSitePlanDraft(draft), name).toMatchObject({ ok: false });
    expect(toSiteComparisonRequest(draft), name).toMatchObject({ ok: false });
    expect(await serializeSiteComparisonStore({ ...emptySiteComparisonStore(), working: draft }), name).toMatchObject({ ok: false });
  }
});

test("evaluation gate reports required fields without requiring nullable PPFD, cost or yield inputs", () => {
  const blank = createCurrentSitePlan(createPlanningSite("Incomplete"));
  const missing = siteDraftMissingFields(blank);
  expect(missing).toContain("operation.horizon_days");
  expect(missing).toContain("scenarios[0].lighting.hours_per_day");
  expect(missing.some(field => field.startsWith("assets"))).toBe(true);
  expect(missing.some(field => field.startsWith("scenarios ("))).toBe(true);
  expect(toSiteComparisonRequest(blank)).toMatchObject({ ok: false, missing });
  const draft = readyDraft(), converted = ok(toSiteComparisonRequest(draft));
  expect(siteDraftMissingFields(draft)).toEqual([]); expect(converted).toEqual(draft); expect(converted).not.toBe(draft);
  expect(converted.review).toBeNull(); expect(converted.scenarios[0].benchmark).toBeNull();
  expect(converted.scenarios[0].lighting.ppfd_full).toBeNull(); expect(converted.assets[0].watts).toBeNull();
  expect(converted.scenarios[0].costs.every(cost => cost.status === "unknown" && cost.rate === null && cost.amount === null)).toBe(true);
  const backend = execFileSync(python, ["-c", "import sys; from backend.site_schemas import ComparisonRequest; ComparisonRequest.model_validate_json(sys.stdin.read()); print('accepted')"], { cwd: root, input: JSON.stringify(converted), encoding: "utf8" });
  expect(backend.trim()).toBe("accepted");
});

test("incomplete load assignments can persist but cannot pass the evaluation gate", async () => {
  const draft = readyDraft(); draft.scenarios[1].loads = [];
  expect(validateSitePlanDraft(draft).ok).toBe(true);
  expect(await serializeSiteComparisonStore({ ...emptySiteComparisonStore(), working: draft })).toMatchObject({ ok: true });
  expect(toSiteComparisonRequest(draft)).toMatchObject({ ok: false });
  expect(siteDraftMissingFields(draft)).toContain("scenarios[1].loads (one accounting assignment per asset)");
});

test("evaluation gate enforces existing cross-field schema without rejecting editable partial drafts", () => {
  const cases: ((draft: SitePlanDraft) => void)[] = [
    d => { Object.assign(d.site, { length_ft: 2, width_ft: 2, canopy_sqft: 10 }); },
    d => { d.scenarios[0].lighting.min_hours = 19; },
    d => { d.scenarios[0].lighting.dim_fraction = 0.5; },
    d => { d.scenarios[0].loads[0].hours_per_day = 15; },
    d => { d.scenarios[0].loads[0].status = "excluded"; d.scenarios[0].loads[0].reason = null; },
    d => { d.scenarios[0].loads[0].accounting = "external"; },
    d => { d.scenarios[0].costs[0].basis = "cycle"; },
    d => { d.scenarios[0].costs[0].amount = 10; },
    d => { d.scenarios[0].costs[0].rate = 11; },
    d => { d.scenarios[0].costs[0].status = "excluded"; d.scenarios[0].costs[0].reason = null; },
    d => { const c = d.scenarios[0].costs.find(cost => cost.category === "new_equipment")!; c.status = "known"; c.amount = 200; },
  ];
  for (const mutate of cases) {
    const draft = readyDraft(); mutate(draft);
    expect(validateSitePlanDraft(draft).ok).toBe(true);
    expect(toSiteComparisonRequest(draft)).toMatchObject({ ok: false });
    expect(siteDraftMissingFields(draft).length).toBeGreaterThan(0);
  }
  expect(toSiteComparisonRequest(fixtureRequest).ok).toBe(true);
});

test("strict historical artifact schemas reject incomplete inputs even with newly matching digests", async () => {
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  for (const mutation of ["operation", "lighting", "assets", "scenarios"]) {
    const bad = structuredClone(artifact);
    const input = bad.payload.input_snapshot as unknown as SitePlanDraft;
    if (mutation === "operation") input.operation.horizon_days = null;
    if (mutation === "lighting") input.scenarios[0].lighting.hours_per_day = null;
    if (mutation === "assets") input.assets = [];
    if (mutation === "scenarios") input.scenarios = input.scenarios.slice(0, 1);
    bad.payload.input_canonical_json = JSON.stringify(input); bad.payload.input_sha256 = sha(bad.payload.input_canonical_json);
    bad.canonical_json = JSON.stringify(bad.payload); bad.sha256 = sha(bad.canonical_json);
    expect(await validateSiteComparisonArtifact(bad), mutation).toMatchObject({ ok: false, code: "invalid_artifact" });
    expect(await deserializeSiteComparisonStore(JSON.stringify({ schema_version: 3, ...emptySiteComparisonStore(), history: [{ artifact: bad, important: false }] })), mutation).toMatchObject({ ok: false, code: "invalid_artifact" });
  }
  expect(await validateSiteComparisonArtifact(artifact)).toMatchObject({ ok: true });
});
