import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { candidateId } from "../lib/candidate-identity";
import {
  SITE_COMPARISON_STORAGE_KEY, MAX_SITE_COMPARISON_IMPORT_BYTES, emptySiteComparisonStore,
  validateSiteComparisonArtifact, importSiteComparisonJson, appendSiteComparison, selectSiteComparison,
  markSiteComparisonImportant, readSiteComparisonStore, writeSiteComparisonStore,
  deserializeSiteComparisonStore, serializeSiteComparisonStore, type SiteComparisonStore,
} from "../lib/site-comparison-storage";
import { buildSiteComparisonCsvBundle, buildSiteComparisonCsvZip, buildSiteComparisonEvidenceRows, buildSiteComparisonZip, exportSiteComparisonJson, siteComparisonCsv } from "../lib/site-comparison-export";
import type { SiteComparisonArtifact, SiteComparisonRequest } from "../lib/site-types";

let artifacts: Record<string, SiteComparisonArtifact>;
let nonround: SiteComparisonArtifact[];
let request: SiteComparisonRequest;

test.beforeAll(() => {
  const root = path.resolve(__dirname, "../..");
  const python = path.join(root, process.platform === "win32" ? "backend/.venv/Scripts/python.exe" : "backend/.venv/bin/python");
  const code = `
import json
from copy import deepcopy
from backend.site_fixture import fixture
from backend.site_schemas import ComparisonRequest
from backend.site_comparison import compare, input_snapshot, canonical, ComparisonRegistry
r = fixture()
if not isinstance(r, ComparisonRequest): r = ComparisonRequest.model_validate(r)
def reviewed(r):
    r.review = {'snapshot_json': canonical(input_snapshot(r)), 'reviewed_at': '2026-09-13T00:00:00Z'}
    return ComparisonRequest.model_validate(r.model_dump())
r = reviewed(r)
store = ComparisonRegistry()
a = compare(r, store)
out = {'base': a}
for name in ['maintenance', 'incompatible', 'infeasible', 'missing_ppfd']:
    c = deepcopy(r)
    if name == 'maintenance':
        line = next(x for x in c.scenarios[2].costs if x.category == 'maintenance')
        line.status = 'unknown'; line.rate = None
    if name == 'incompatible':
        c.scenarios[2].lighting.hours_per_day = 17.0
        next(x for x in c.scenarios[2].loads if x.accounting == 'lighting').hours_per_day = 17.0
    if name == 'infeasible':
        next(x for x in c.limits if x.metric == 'peak_watts').maximum = 800.0
    if name == 'missing_ppfd': c.scenarios[2].lighting.ppfd_full = None
    out[name] = compare(reviewed(c), store)
g = deepcopy(r)
g.goal.metric = 'energy_kwh'; g.goal.direction = 'minimize'; g.goal.version += 1
g.prior_comparison_id = a['payload']['id']
out['goal'] = compare(reviewed(g), store)
nonround = []
for hours in [12.123456789, 16.123456789123456, 0.12345678912345678, 0.000001, 0.0000001]:
    c = deepcopy(r)
    c.scenarios[0].lighting.hours_per_day = hours
    next(x for x in c.scenarios[0].loads if x.accounting == 'lighting').hours_per_day = hours
    nonround.append(compare(reviewed(c), store))
print(json.dumps({'artifacts': out, 'request': r.model_dump(), 'nonround': nonround}))
`;
  const generated = JSON.parse(execFileSync(python, ["-W", "ignore", "-c", code], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
  artifacts = generated.artifacts;
  request = generated.request;
  nonround = generated.nonround;
});

function sha(value: string) { return createHash("sha256").update(value, "utf8").digest("hex"); }
function seal(artifact: SiteComparisonArtifact): SiteComparisonArtifact {
  artifact.payload.input_canonical_json = JSON.stringify(artifact.payload.input_snapshot);
  artifact.payload.input_sha256 = sha(artifact.payload.input_canonical_json);
  artifact.canonical_json = JSON.stringify(artifact.payload);
  artifact.sha256 = sha(artifact.canonical_json);
  return artifact;
}
function ok<T>(result: { ok: true; value: T } | { ok: false; message: string }): T {
  if (!result.ok) throw new Error(result.message);
  return result.value;
}
function memoryStorage() {
  const values = new Map<string, string>([["acreiq.workspace.v1", '{"privateLegacyHistory":"untouched"}']]);
  let full = false;
  return { values, setFull(value: boolean) { full = value; },
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { if (full) throw new DOMException("Quota exceeded", "QuotaExceededError"); values.set(key, value); },
  };
}
function withArtifact(artifact = artifacts.base): SiteComparisonStore {
  return ok(appendSiteComparison({ ...emptySiteComparisonStore(), working: structuredClone(request) }, artifact));
}
function parseCsv(csv: string): string[][] {
  const records: string[][] = [];
  let cells: string[] = [];
  for (const match of csv.matchAll(/("(?:[^"]|"")*"|[^",\r\n]*)(,|\r\n)/g)) {
    cells.push(match[1].startsWith('"') ? match[1].slice(1, -1).replace(/""/g, '"') : match[1]);
    if (match[2] === "\r\n") { records.push(cells); cells = []; }
  }
  expect(cells).toHaveLength(0);
  return records;
}
function objects(csv: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(csv);
  return rows.map(row => { expect(row).toHaveLength(header.length); return Object.fromEntries(header.map((key, i) => [key, row[i]])); });
}

test("real numerical artifacts pass both canonical-byte checks, including partial and reused evaluations", async () => {
  for (const [name, artifact] of Object.entries(artifacts)) {
    const result = await validateSiteComparisonArtifact(artifact);
    expect(result, name).toMatchObject({ ok: true });
    expect(ok(result)).toEqual(artifact);
    expect(ok(result)).not.toBe(artifact);
  }
  expect(artifacts.base.payload.preferred_scenario_ids).toEqual(["fixture-C"]);
  expect(artifacts.goal.payload.preferred_scenario_ids).toEqual(["fixture-A"]);
  expect(artifacts.goal.payload.evaluations.map(e => e.id)).toEqual(artifacts.base.payload.evaluations.map(e => e.id));
});

test("Python non-round setting identities match frontend tuples, strict import and CSV requested settings", async () => {
  for (const artifact of nonround) {
    expect(await validateSiteComparisonArtifact(artifact)).toMatchObject({ ok: true });
    const e = artifact.payload.evaluations[0];
    const expected = candidateId({ photoperiod_hours: e.requested_setting.hours, dim_fraction: e.requested_setting.dim });
    expect(e.requested_setting.candidate_id).toBe(expected);
    expect(e.module_result!.candidates.some(c => candidateId(c) === expected)).toBe(true);
    const requested = objects(buildSiteComparisonCsvBundle(artifact)["candidates.csv"]).filter(row => row.evaluation_id === e.id && row.requested_setting === "true");
    expect(requested).toHaveLength(9);
    expect(requested.every(row => row.candidate_id === expected && row.module_run_id === e.module_result!.run!.id)).toBe(true);
  }
});

test("complete JSON round trip retains exact backend canonical strings, raw values and local-only integrity", async () => {
  const artifact = artifacts.base;
  const result = ok(await importSiteComparisonJson(exportSiteComparisonJson(artifact)));
  expect(result).toEqual(artifact);
  expect(result.canonical_json).toBe(artifact.canonical_json);
  expect(result.payload.input_canonical_json).toBe(artifact.payload.input_canonical_json);
  expect(result.payload.evaluations[0].metrics.recurring_cash_usd.value).toBe(510.944);
  expect(Object.keys(result)).not.toContain("server_verified");
  const before = JSON.stringify(artifact);
  buildSiteComparisonCsvBundle(artifact);
  expect(JSON.stringify(artifact)).toBe(before);
});

test("tampering, canonical mismatch, unsupported versions and corrupt JSON are rejected without storage changes", async () => {
  const store = memoryStorage(), old = withArtifact();
  const written = await writeSiteComparisonStore(store, old, null);
  expect(written.ok).toBe(true);
  const original = store.getItem(SITE_COMPARISON_STORAGE_KEY);
  const changed = structuredClone(artifacts.base);
  changed.payload.evaluations[0].metrics.energy_kwh.value = 123;
  expect(await validateSiteComparisonArtifact(changed)).toMatchObject({ ok: false, code: "digest_mismatch" });
  changed.canonical_json = JSON.stringify(changed.payload);
  expect(await validateSiteComparisonArtifact(changed)).toMatchObject({ ok: false, code: "digest_mismatch" });
  const inputTamper = structuredClone(artifacts.base);
  inputTamper.payload.input_sha256 = "0".repeat(64);
  inputTamper.canonical_json = JSON.stringify(inputTamper.payload);
  inputTamper.sha256 = sha(inputTamper.canonical_json);
  expect(await validateSiteComparisonArtifact(inputTamper)).toMatchObject({ ok: false, code: "digest_mismatch" });
  expect(await importSiteComparisonJson('{"schema_version":"site-scenario-comparison/999"}')).toMatchObject({ ok: false, code: "unsupported_version" });
  expect(await importSiteComparisonJson('{"broken":')).toMatchObject({ ok: false, code: "invalid_json" });
  expect(await importSiteComparisonJson(" ".repeat(MAX_SITE_COMPARISON_IMPORT_BYTES + 1))).toMatchObject({ ok: false, code: "too_large" });
  expect(store.getItem(SITE_COMPARISON_STORAGE_KEY)).toBe(original);
});

test("valid digests do not excuse schema, identity, unit-shape or reference corruption", async () => {
  const cases = [
    (a: SiteComparisonArtifact) => { a.payload.evaluations[0].metrics.output_kg.value = "48" as unknown as number; },
    (a: SiteComparisonArtifact) => { a.payload.evaluations[0].scenario_id = "missing-scenario"; },
    (a: SiteComparisonArtifact) => { a.payload.evaluations[0].scenario_revision++; },
    (a: SiteComparisonArtifact) => { a.payload.ranks[0].evaluation_id = a.payload.evaluations[1].id; },
    (a: SiteComparisonArtifact) => { a.payload.evaluations[0].metrics.energy_kwh.complete = false; },
    (a: SiteComparisonArtifact) => { a.payload.evaluations[0].metrics.energy_kwh.unit = "USD"; },
    (a: SiteComparisonArtifact) => { a.payload.evaluations[0].requested_setting.candidate_id = "row-1"; },
    (a: SiteComparisonArtifact) => { a.payload.input_snapshot.operation.operation_type = "other" as "indoor_leafy_greens"; },
    (a: SiteComparisonArtifact) => { (a.payload as unknown as Record<string, unknown>).extra = true; },
  ];
  for (const change of cases) {
    const a = structuredClone(artifacts.base); change(a);
    expect(await validateSiteComparisonArtifact(seal(a))).toMatchObject({ ok: false, code: "invalid_artifact" });
  }
});

test("historical selection and working C reload independently without mutating current inputs or Phase 1", async () => {
  const storage = memoryStorage();
  const legacy = storage.getItem("acreiq.workspace.v1");
  let state = withArtifact();
  state.working!.scenarios[0].lighting.hours_per_day = 15;
  state.working!.scenarios[0].loads.find(l => l.accounting === "lighting")!.hours_per_day = 15;
  state = ok(appendSiteComparison(state, artifacts.goal));
  state = ok(selectSiteComparison(state, artifacts.base.payload.id, "fixture-C"));
  const saved = await writeSiteComparisonStore(storage, state, null);
  expect(saved.ok).toBe(true);
  let read = ok(await readSiteComparisonStore(storage));
  expect(read.selectedComparisonId).toBe(artifacts.base.payload.id);
  expect(read.selectedScenarioId).toBe("fixture-C");
  expect(read.working!.scenarios[0].lighting.hours_per_day).toBe(15);
  expect(read.history.find(h => h.artifact.payload.id === read.selectedComparisonId)!.artifact.payload.input_snapshot.scenarios[0].lighting.hours_per_day).toBe(16);
  read = ok(selectSiteComparison(read, null, "fixture-C"));
  expect((await writeSiteComparisonStore(storage, read, saved.raw)).ok).toBe(true);
  expect(ok(await readSiteComparisonStore(storage))).toMatchObject({ selectedComparisonId: null, selectedScenarioId: "fixture-C" });
  expect(ok(selectSiteComparison(read, null)).selectedScenarioId).toBe("fixture-A");
  expect(selectSiteComparison(read, null, "absent")).toMatchObject({ ok: false, code: "not_found" });
  expect(storage.getItem("acreiq.workspace.v1")).toBe(legacy);
});

test("history grows beyond twelve, important flags persist, duplicate IDs cannot replace exact evidence", async () => {
  let state = emptySiteComparisonStore();
  for (let index = 0; index < 14; index++) {
    const a = seal({ ...structuredClone(artifacts.base), payload: { ...structuredClone(artifacts.base.payload), id: `retention-${index}` } });
    state = ok(appendSiteComparison(state, a));
  }
  state = markSiteComparisonImportant(state, "retention-0", true);
  state = ok(appendSiteComparison(state, state.history.find(h => h.artifact.payload.id === "retention-0")!.artifact));
  expect(state.history).toHaveLength(14);
  expect(state.history.find(h => h.artifact.payload.id === "retention-0")!.important).toBe(true);
  const collision = structuredClone(state.history[0].artifact); collision.payload.explanation = "Changed immutable evidence";
  expect(appendSiteComparison(state, seal(collision))).toMatchObject({ ok: false, code: "history_conflict" });
  const storage = memoryStorage();
  const saved = await writeSiteComparisonStore(storage, state, null);
  expect(saved.ok).toBe(true);
  expect(ok(await readSiteComparisonStore(storage))).toEqual(state);
  const wouldEvict = { ...state, history: state.history.slice(0, 12) };
  expect(await writeSiteComparisonStore(storage, wouldEvict, saved.raw)).toMatchObject({ ok: false, code: "history_conflict", sessionOnly: true });
  expect(storage.getItem(SITE_COMPARISON_STORAGE_KEY)).toBe(saved.raw);
});

test("quota and concurrent writes preserve old bytes while session export remains available", async () => {
  const storage = memoryStorage(), first = withArtifact();
  const old = await writeSiteComparisonStore(storage, first, null);
  const second = ok(appendSiteComparison(first, artifacts.goal));
  storage.setFull(true);
  expect(await writeSiteComparisonStore(storage, second, old.raw)).toMatchObject({ ok: false, code: "storage_full", sessionOnly: true, raw: old.raw });
  expect(storage.getItem(SITE_COMPARISON_STORAGE_KEY)).toBe(old.raw);
  expect(ok(await importSiteComparisonJson(exportSiteComparisonJson(second.history[0].artifact)))).toEqual(artifacts.goal);
  storage.setFull(false);
  const newer = await writeSiteComparisonStore(storage, second, old.raw);
  expect(newer.ok).toBe(true);
  expect(await writeSiteComparisonStore(storage, first, old.raw)).toMatchObject({ ok: false, code: "storage_conflict", sessionOnly: true });
  expect(storage.getItem(SITE_COMPARISON_STORAGE_KEY)).toBe(newer.raw);
});

test("unreadable, future and unavailable storage never becomes an overwrite of old history", async () => {
  for (const raw of ["{broken", '{"schema_version":99,"private":"preserve"}', '{"schema_version":2,"working":null}']) {
    const storage = memoryStorage(); storage.values.set(SITE_COMPARISON_STORAGE_KEY, raw);
    expect(await readSiteComparisonStore(storage)).toMatchObject({ ok: false, sessionOnly: true, raw });
    expect(await writeSiteComparisonStore(storage, withArtifact(), raw)).toMatchObject({ ok: false, sessionOnly: true, raw });
    expect(storage.getItem(SITE_COMPARISON_STORAGE_KEY)).toBe(raw);
  }
  const storage = { getItem() { throw new Error("Storage denied"); }, setItem() { throw new Error("Never write"); } };
  expect(await readSiteComparisonStore(storage)).toMatchObject({ ok: false, code: "storage_unavailable", sessionOnly: true });
  expect(await writeSiteComparisonStore(storage, withArtifact(), null)).toMatchObject({ ok: false, code: "storage_unavailable", sessionOnly: true });
  expect(await deserializeSiteComparisonStore(null)).toEqual({ ok: true, value: emptySiteComparisonStore() });
});

test("summary CSV matches exact run metrics, revisions, applicability and unambiguous subtotal status", () => {
  for (const artifact of [artifacts.base, artifacts.maintenance, artifacts.incompatible]) {
    const bundle = buildSiteComparisonCsvBundle(artifact), rows = objects(bundle["summary.csv"]);
    expect(JSON.parse(bundle["comparison.json"])).toEqual(artifact);
    for (const e of artifact.payload.evaluations) {
      for (const [metric, m] of Object.entries(e.metrics)) {
        const row = rows.find(row => row.evaluation_id === e.id && row.metric === metric)!;
        expect(row).toMatchObject({ comparison_id: artifact.payload.id, scenario_id: e.scenario_id, value: m.value === null ? "" : String(m.value), known_subtotal: String(m.known_subtotal), unit: m.unit, status: m.complete ? "complete" : "unknown", source: e.provenance, benchmark_applicability: e.applicability.status, payload_sha256: artifact.sha256, server_verification: "not_checked" });
      }
    }
    expect(bundle["README.txt"]).toContain("summary.csv is summary only");
    expect(bundle["README.txt"]).toContain("scenario_minus_current");
  }
});

test("evidence exports preserve operands, raw values, units, complete inputs and scoped cost lines", () => {
  const a = artifacts.base;
  const bundle = buildSiteComparisonCsvBundle(a), rows = buildSiteComparisonEvidenceRows(a);
  const costRows = objects(bundle["costs.csv"]);
  for (const kind of ["input", "assumption", "benchmark", "formula", "cost", "usage", "constraint", "metadata"]) expect(rows.some(r => r.record_kind === kind), kind).toBe(true);
  for (let i = 0; i < a.payload.evaluations.length; i++) {
    const e = a.payload.evaluations[i];
    for (let j = 0; j < e.formulas.length; j++) {
      const f = e.formulas[j];
      const found = rows.find(row => row.json_path === `/payload/evaluations/${i}/formulas/${j}/raw_value`)!;
      expect(found).toMatchObject({ entity_id: f.id, evaluation_id: e.id, expression: f.expression, raw_value: f.raw_value, reported_value: f.reported_value, unit: f.unit });
      expect(JSON.parse(found.value_json)).toBe(f.raw_value);
    }
    for (const line of e.cost_lines) expect(costRows.some(row => row.entity_id === line.id && row.json_path.endsWith("/value") && row.value === (line.value === null ? "" : String(line.value)))).toBe(true);
  }
  expect(rows.filter(row => row.value === null).every(row => ["unknown", "excluded"].includes(row.status))).toBe(true);
  expect(rows.some(row => row.json_path === "/payload/differences/1/metrics/energy_kwh" && row.value === -134.4)).toBe(true);
  expect(rows.some(row => row.json_path === "/payload/input_snapshot/site/length_ft" && row.unit === "ft")).toBe(true);
  expect(rows.some(row => row.json_path === "/payload/input_snapshot/scenarios/0/costs/0/rate" && row.unit === "USD/kWh")).toBe(true);
});

test("candidate CSV uses run plus exact tuple IDs independent of sorting and includes rejected alternatives", () => {
  const a = artifacts.base, rows = objects(buildSiteComparisonCsvBundle(a)["candidates.csv"]);
  for (const e of a.payload.evaluations) {
    const result = e.module_result!;
    expect(new Set(rows.filter(r => r.evaluation_id === e.id).map(r => r.candidate_id)).size).toBe(result.candidates.length);
    for (const c of result.candidates) {
      const matches = rows.filter(r => r.evaluation_id === e.id && r.candidate_id === candidateId(c));
      expect(matches).toHaveLength(9);
      expect(matches.every(r => r.module_run_id === result.run!.id && r.feasible === String(c.feasible) && r.rejection_reasons_json === JSON.stringify(c.rejected_for))).toBe(true);
    }
  }
  expect(rows.some(r => r.feasible === "false")).toBe(true);
  const reversed = structuredClone(a);
  reversed.payload.evaluations.forEach(e => e.module_result!.candidates.reverse());
  const sorted = (r: Record<string, string>[]) => r.map(x => JSON.stringify(x)).sort();
  expect(sorted(objects(buildSiteComparisonCsvBundle(reversed)["candidates.csv"]))).toEqual(sorted(rows));
});

test("CSV strings are reversibly formula escaped and numeric signs, quotes, newlines remain exact", () => {
  const dangerous = ["=1+1", "+SUM(A1)", "-438", "@SUM(A1)", "  =1", "\t=1", "\r=1", "\n@x", "\u0000 =1", "\uFF1D1+1", "'already", "''two"];
  for (const value of dangerous) {
    const parsed = parseCsv(siteComparisonCsv([[value, -438, 0, null, 'Text, "quoted"\r\nnext line']]));
    expect(parsed[0]).toEqual([`'${value}`, "-438", "0", "", 'Text, "quoted"\r\nnext line']);
    expect(parsed[0][0].slice(1)).toBe(value);
  }
  const a = structuredClone(artifacts.base);
  a.payload.input_snapshot.scenarios[0].name = "=HYPERLINK()";
  a.payload.evaluations[0].snapshot.scenario.name = "=HYPERLINK()";
  const bundle = buildSiteComparisonCsvBundle(a);
  expect(objects(bundle["summary.csv"])[0].name).toBe("'=HYPERLINK()");
  expect(JSON.parse(bundle["comparison.json"]).payload.input_snapshot.scenarios[0].name).toBe("=HYPERLINK()");
});

test("CSV bundle is a standards-readable UTF-8 ZIP with CRCs and complete JSON", () => {
  const bytes = buildSiteComparisonCsvZip(artifacts.base);
  const root = path.resolve(__dirname, "../..");
  const python = path.join(root, process.platform === "win32" ? "backend/.venv/Scripts/python.exe" : "backend/.venv/bin/python");
  const result = JSON.parse(execFileSync(python, ["-c", "import sys,io,zipfile,json; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); print(json.dumps({'bad':z.testzip(),'names':z.namelist(),'artifact':json.loads(z.read('comparison.json'))}))"], { input: bytes, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
  expect(result.bad).toBeNull();
  expect(result.names.sort()).toEqual(Object.keys(buildSiteComparisonCsvBundle(artifacts.base)).sort());
  expect(result.artifact).toEqual(artifacts.base);
  expect(() => buildSiteComparisonZip({ "../unsafe.csv": "bad" })).toThrow(/basenames/);
});

test("serialization keeps checked status outside immutable artifacts and never accepts extra persisted claims", async () => {
  const state = withArtifact();
  const serialized = ok(await serializeSiteComparisonStore(state));
  expect(JSON.parse(serialized).schema_version).toBe(3);
  expect(ok(await deserializeSiteComparisonStore(serialized))).toEqual(state);
  const forged = JSON.parse(serialized); forged.history[0].serverVerified = true;
  expect(await deserializeSiteComparisonStore(JSON.stringify(forged))).toMatchObject({ ok: false, code: "invalid_artifact" });
});
