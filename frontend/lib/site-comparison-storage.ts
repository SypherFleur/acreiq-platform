import { candidateId } from "./candidate-identity";
import type { SiteComparisonArtifact, SiteComparisonRequest, SiteInputs } from "./site-types";
import type { SitePlanDraft } from "./site-drafts";

export const SITE_COMPARISON_STORAGE_KEY = "acreiq.site-comparisons.v2";
export const MAX_SITE_COMPARISON_IMPORT_BYTES = 16 * 1024 * 1024;
export const MAX_OTHER_SITE_DRAFTS = 20;
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const UTF8 = new TextEncoder();
export type SiteComparisonErrorCode = "invalid_json" | "unsupported_version" | "invalid_artifact" | "digest_mismatch" | "too_large" | "crypto_unavailable" | "storage_unavailable" | "storage_conflict" | "storage_full" | "history_conflict" | "not_found";
export type SiteComparisonResult<T> = { ok: true; value: T } | { ok: false; code: SiteComparisonErrorCode; message: string };
export type SiteComparisonStore = {
  working: SitePlanDraft | null;
  otherWorking?: SitePlanDraft[];
  selectedSiteId?: string | null;
  history: { artifact: SiteComparisonArtifact; important: boolean }[];
  selectedComparisonId: string | null;
  selectedScenarioId: string | null;
};
export type SiteComparisonStorageResult<T> = (SiteComparisonResult<T> & { raw: string | null }) & ({ ok: true } | { ok: false; sessionOnly: true });
export type SiteComparisonStorage = Pick<Storage, "getItem" | "setItem">;

const failure = (code: SiteComparisonErrorCode, message: string): { ok: false; code: SiteComparisonErrorCode; message: string } => ({ ok: false, code, message });
const storageFailure = (code: SiteComparisonErrorCode, message: string, raw: string | null): SiteComparisonStorageResult<never> => ({ ...failure(code, message), raw, sessionOnly: true });
export const emptySiteComparisonStore = (): SiteComparisonStore => ({ working: null, history: [], selectedComparisonId: null, selectedScenarioId: null });

type Check = (value: unknown, path: string) => void;
function invalid(path: string): never { throw new Error(`Invalid comparison data at ${path}.`); }
const text = (max = 10000, min = 0): Check => (v, p) => { if (typeof v !== "string" || v.length < min || v.length > max) invalid(p); };
const num = (min = -Number.MAX_VALUE, max = Number.MAX_VALUE, integer = false): Check => (v, p) => { if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isSafeInteger(v))) invalid(p); };
const bool: Check = (v, p) => { if (typeof v !== "boolean") invalid(p); };
const one = (...allowed: (string | number)[]): Check => (v, p) => { if (!allowed.includes(v as string)) invalid(p); };
const nullable = (check: Check): Check => (v, p) => { if (v !== null) check(v, p); };
const array = (check: Check, max = 10000, min = 0): Check => (v, p) => { if (!Array.isArray(v) || v.length < min || v.length > max) invalid(p); v.forEach((item, i) => check(item, `${p}[${i}]`)); };
const record: Check = (v, p) => { if (v === null || typeof v !== "object" || Array.isArray(v)) invalid(p); };
const shape = (fields: Record<string, Check>): Check => (v, p) => {
  record(v, p);
  const input = v as Record<string, unknown>;
  if (Object.keys(input).length !== Object.keys(fields).length || Object.keys(input).some(key => !Object.hasOwn(fields, key))) invalid(p);
  for (const [key, check] of Object.entries(fields)) check(input[key], `${p}.${key}`);
};
const id: Check = (v, p) => { if (typeof v !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/u.test(v)) invalid(p); };
const digest: Check = (v, p) => { if (typeof v !== "string" || !/^[a-f0-9]{64}$/u.test(v)) invalid(p); };
const timestamp: Check = (v, p) => { text(60, 1)(v, p); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(v as string) || !Number.isFinite(Date.parse(v as string))) invalid(p); };
const rev = num(1, 1000000, true), qty = num(0, 1e9), nullableQty = nullable(qty), shortText = text(600), strings = array(text());
const ids = array(id, 100), source = one("measured", "user_assumption", "synthetic_fixture", "provider_observation");
const status = one("known", "unknown", "excluded"), pass = one("pass", "fail", "unknown");
const metricKeys = ["energy_kwh", "peak_watts", "output_kg", "water_liters", "work_hours", "new_setup_cash_usd", "recurring_cash_usd", "horizon_cash_usd", "energy_per_kg", "water_per_kg", "recurring_cash_per_kg", "horizon_cash_per_kg", "lighting_hours", "dli", "layout_feasibility"] as const;
const metricUnits: Record<typeof metricKeys[number], string> = { energy_kwh: "kWh", peak_watts: "W", output_kg: "kg", water_liters: "L", work_hours: "h", new_setup_cash_usd: "USD", recurring_cash_usd: "USD", horizon_cash_usd: "USD", energy_per_kg: "kWh/kg", water_per_kg: "L/kg", recurring_cash_per_kg: "USD/kg", horizon_cash_per_kg: "USD/kg", lighting_hours: "h/day", dli: "mol/m^2/day", layout_feasibility: "boolean" };
const metric = one(...metricKeys), goalMetric = one("output_kg", "energy_kwh", "recurring_cash_usd", "horizon_cash_usd", "horizon_cash_per_kg");
const direction = one("minimize", "maximize");
const evidence = shape({ id, version: rev, source, entry_route: one("manual", "sample", "photo-assisted"), note: shortText, recorded_at: nullable(shortText), instrument: nullable(shortText), conditions: nullable(shortText), uncertainty: nullable(shortText) });
const site = shape({ id, revision: rev, name: shortText, boundary_id: id, boundary_revision: rev, length_ft: nullable(num(Number.MIN_VALUE, 1000)), width_ft: nullable(num(Number.MIN_VALUE, 1000)), canopy_sqft: nullable(num(Number.MIN_VALUE, 1e6)), included_spaces: array(shortText, 30), excluded_spaces: array(shortText, 30), excluded_costs: array(shortText, 30), evidence });
const asset = shape({ id, revision: rev, site_id: id, name: shortText, kind: text(80, 1), quantity: num(1, 100, true), ownership: one("owned", "proposed", "unknown"), available: nullable(bool), power_basis: one("aggregate", "per_unit"), watts: nullable(num(0, 1e6)), component_ids: array(id, 100, 1), footprint_sqft: nullableQty, evidence });
const operationFields = { id, revision: rev, site_id: id, operation_type: one("indoor_leafy_greens"), operation_schema_version: one(1), name: shortText, crop: nullable(shortText), cultivar: nullable(shortText), method: nullable(shortText), start_stage: nullable(shortText), end_stage: nullable(shortText), product_definition: text(600, 1), output_unit: one("kg_net_marketable_fresh"), horizon_days: num(1, 366, true), cycle_days: num(1, 366, true), completed_cycles: num(1, 366, true), turnover_days: num(0, 366, true), idle_days: num(0, 366, true), identical_cycles: bool, starts_per_cycle: nullable(num(1, 1e6, true)), temperature_c: nullable(num(-20, 60)), humidity_pct: nullable(num(0, 100)), co2_ppm: nullable(num(0, 10000)), ph: nullable(num(0, 14)), ec_ms_cm: nullable(num(0, 100)), nutrient_protocol: nullable(shortText), protocol_version: rev, evidence };
const operation = shape(operationFields);
const load = shape({ id, asset_id: id, asset_revision: rev, component_ids: array(id, 100, 1), accounting: one("lighting", "module_other", "external", "unpowered"), hours_per_day: nullable(num(0, 24)), status, reason: nullable(shortText) });
const lightingFields = { hours_per_day: num(Number.MIN_VALUE, 24), dim_fraction: num(Number.MIN_VALUE, 1), dimmable: bool, ppfd_full: nullable(num(Number.MIN_VALUE, 5000)), ppfd_basis: nullable(shortText), min_dli: nullable(num(Number.MIN_VALUE, 100)), min_hours: num(Number.MIN_VALUE, 24), max_hours: num(Number.MIN_VALUE, 24), power_limit_watts: nullable(num(Number.MIN_VALUE, 2e6)) };
const lighting = shape(lightingFields);
const cost = shape({ id, version: rev, category: one("electricity", "water", "routine_labor", "consumables", "maintenance", "new_equipment", "setup_labor", "setup_materials"), status, basis: one("kwh", "liter", "routine_hour", "setup_hour", "cycle", "horizon"), rate: nullableQty, amount: nullableQty, component_ids: array(id, 100, 1), asset_ids: array(id, 64), reason: nullable(shortText), evidence });
const benchmark = shape({ id, version: rev, scenario_id: id, kg_per_cycle: nullableQty, context: record, uncertainty: nullable(shape({ lower: qty, upper: qty, meaning: shortText })), evidence });
const scenarioFields = { id, revision: rev, name: shortText, role: one("current", "alternative"), site_revision: rev, operation_revision: rev, lighting, loads: array(load, 64, 1), water_liters_day: nullableQty, routine_labor_hours_cycle: nullableQty, setup_labor_hours: nullableQty, costs: array(cost, 8), benchmark: nullable(benchmark), change_description: shortText, evidence };
const scenario = shape(scenarioFields);
const goal = shape({ id, version: rev, metric: goalMetric, direction, secondary: array(shape({ metric: goalMetric, direction }), 4) });
const limit = shape({ id, version: rev, metric, minimum: nullableQty, maximum: nullableQty, unit: text(50), enabled: bool, reason: nullable(shortText), evidence });
const inputFields = { site, assets: array(asset, 64, 1), operation, scenarios: array(scenario, 5, 2), goal, limits: array(limit, 30) };
const inputs = shape(inputFields);
const requestFields = { ...inputFields, review: nullable(shape({ snapshot_json: text(220000), reviewed_at: timestamp })), prior_comparison_id: nullable(id) };
const request = shape(requestFields);
const draftOperation = shape({ ...operationFields, product_definition: shortText, horizon_days: nullable(operationFields.horizon_days), cycle_days: nullable(operationFields.cycle_days), completed_cycles: nullable(operationFields.completed_cycles), turnover_days: nullable(operationFields.turnover_days), idle_days: nullable(operationFields.idle_days) });
const draftLighting = shape({ ...lightingFields, hours_per_day: nullable(lightingFields.hours_per_day), dim_fraction: nullable(lightingFields.dim_fraction), min_hours: nullable(lightingFields.min_hours), max_hours: nullable(lightingFields.max_hours) });
const draftScenario = shape({ ...scenarioFields, lighting: draftLighting, loads: array(load, 64) });
const draftRequest = shape({ ...requestFields, operation: draftOperation, assets: array(asset, 64), scenarios: array(draftScenario, 5) });
const resultMetric = shape({ value: nullable(num()), known_subtotal: num(), complete: bool, unit: text(100), unknown_line_ids: strings, excluded_line_ids: strings, reason: nullable(text()) });
const constraint = shape({ id: text(300, 1), metric, status: one("pass", "fail", "unknown", "not_evaluated"), value: nullable(num()), known_subtotal: num(), minimum: nullableQty, maximum: nullableQty, unit: text(100), reason: text() });
const formula = shape({ id: text(300, 1), metric: text(), expression: text(), operands: record, raw_value: nullable(num()), reported_value: nullable(num()), unit: text(100) });
const ledger = shape({ id: text(300, 1), category: text(), status, value: nullable(num()), unit: text(100), quantity: nullable(num()), rate: nullable(num()), component_ids: strings, reason: nullable(text()) });
const legacySource = one("sample", "manual", "photo-assisted"), legacyStatus = one("optimized", "needs_measurement", "no_feasible_configuration");
const legacyMetricFields = { photoperiod_hours: num(), dim_fraction: num(), daily_energy_kwh: num(), period_energy_kwh: num(), period_energy_cost_usd: num(), peak_modeled_watts: num(), dli_mol_m2_day: nullable(num()), period_water_liters: nullable(num()), canopy_sqft: num() };
const legacyMetrics = shape(legacyMetricFields), candidate = shape({ ...legacyMetricFields, feasible: bool, rejected_for: strings });
const nullOnly: Check = (v, p) => { if (v !== null) invalid(p); };
const savings = nullable(shape({ period_energy_kwh: num(), energy_pct: num(), period_energy_cost_usd: num(), water_liters: nullOnly, yield_gain_lb: nullOnly, avoided_capex_usd: nullOnly, new_equipment_required_by_scenario_usd: num() }));
const legacyInputs = shape({ source: legacySource, length_ft: num(), width_ft: num(), canopy_sqft: num(), light_count: num(0, 1e6, true), lighting_watts: num(), other_watts: num(), other_hours: num(), baseline_hours: num(), baseline_dim: num(), dimmable: bool, ppfd_full: nullable(num()), min_dli: nullable(num()), min_hours: num(), max_hours: num(), power_limit_watts: num(), electricity_usd_kwh: num(), operating_days: num(), water_liters_day: nullable(num()), confirmed: bool });
const scalar: Check = (v, p) => { if (v !== null && !["string", "number", "boolean"].includes(typeof v)) invalid(p); };
const legacyEvidence = shape({ summary: text(), inputs: array(shape({ field: text(), value: scalar, unit: text(), used_for: text() })), baseline: legacyMetrics, selected: nullable(legacyMetrics), savings, formulas: array(shape({ scope: one("baseline", "selected", "savings"), metric: text(), expression: text(), substituted: text(), raw_value: num(), reported_value: num(), unit: text(), round_digits: num(0, 6, true) })), objective: text(), constraints: array(shape({ name: text(), unit: text(), minimum: nullable(num()), maximum: nullable(num()), evaluated: bool, baseline_value: nullable(num()), baseline_passed: nullable(bool), selected_value: nullable(num()), selected_passed: nullable(bool), rejected_configurations: num(0, 100000, true) })), configurations_evaluated: num(0, 100000, true), feasible_configurations: num(0, 100000, true), selection_reason: text(), alternatives: array(shape({ kind: one("selected", "rejected", "nearest_feasible"), reason: nullable(text()), candidate })), horizon: shape({ operating_days: num(), electricity_usd_kwh: num() }), assumptions: strings, missing_inputs: strings, limitations: strings });
const moduleResult = shape({ run: shape({ id, created_at: timestamp, input_snapshot: legacyInputs, model_version: text(), source: legacySource, status: legacyStatus, evidence: legacyEvidence }), model_version: text(), source: legacySource, status: legacyStatus, operating_days: num(), baseline: legacyMetrics, optimized: nullable(legacyMetrics), savings, configurations_evaluated: num(0, 100000, true), feasible_configurations: num(0, 100000, true), candidates: array(candidate, 100000), recommendations: strings, limitations: strings });
const evaluation = shape({ id, created_at: timestamp, scenario_id: id, scenario_revision: rev, snapshot: shape({ site, assets: array(asset, 64, 1), operation, scenario, limits: array(limit, 30) }), review_status: one("reviewed", "unreviewed"), provenance: one("synthetic_fixture", "user_defined"), status: one("evaluated", "partial"), metrics: shape(Object.fromEntries(metricKeys.map(key => [key, resultMetric]))), feasibility: pass, constraints: array(constraint, 100), applicability: shape({ status: pass, checks: array(shape({ path: text(), expected: () => {}, actual: () => {}, status: pass })), reasons: strings }), module_result: nullable(moduleResult), module_status: text(), module_included_components: strings, module_excluded_components: strings, requested_setting: shape({ hours: num(), dim: num(), candidate_id: text() }), usage_lines: array(ledger, 100), cost_lines: array(ledger, 100), formulas: array(formula, 1000), missing_inputs: strings, limitations: strings, explanation: text() });
const payload = shape({ id, created_at: timestamp, parent_id: nullable(id), accounting_version: one("site-scenario-accounting/1.0.0"), benchmark_version: one("user-output-benchmark/1.0.0"), lighting_model_version: text(100, 1), input_snapshot: inputs, input_canonical_json: text(MAX_SITE_COMPARISON_IMPORT_BYTES), input_sha256: digest, review_status: one("reviewed", "unreviewed"), baseline_scenario_id: id, evaluations: array(evaluation, 5, 2), reused_evaluations: bool, compatibility: shape({ status: one("comparable", "not_comparable"), reasons: strings }), ranks: array(shape({ scenario_id: id, evaluation_id: id, eligible: bool, rank: nullable(num(1, 5, true)), value: nullable(num()), reasons: strings }), 5, 2), preferred_scenario_ids: array(id, 5), comparison_incomplete: bool, scenario_count: num(2, 5, true), feasible_count: num(0, 5, true), differences: array(shape({ scenario_id: id, direction: one("scenario_minus_current"), metrics: record }), 5), explanation: text(), limitations: strings });
const artifactShape = shape({ schema_version: one("site-scenario-comparison/2.0.0"), canonicalization: one("python-json-sort-keys-ascii/1"), payload, canonical_json: text(MAX_SITE_COMPARISON_IMPORT_BYTES), sha256: digest });

function checkJsonTree(value: unknown, depth = 0, counter = { nodes: 0 }): void {
  if (depth > 48 || ++counter.nodes > 1000000) invalid("JSON nesting or node bound");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach(item => checkJsonTree(item, depth + 1, counter)); return; }
  record(value, "JSON value");
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) invalid("unsafe JSON key");
    checkJsonTree(item, depth + 1, counter);
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a), right = Object.keys(b);
  return left.length === right.length && left.every(key => Object.hasOwn(b, key) && sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

function unique(values: string[], path: string) { if (new Set(values).size !== values.length) invalid(path); }

function checkReferences(input: SiteInputs | SitePlanDraft, draft = false): void {
  unique(input.assets.map(a => a.id), "asset IDs");
  unique(input.assets.flatMap(a => a.component_ids), "asset component IDs");
  unique(input.scenarios.map(s => s.id), "scenario IDs");
  unique(input.limits.map(l => l.id), "limit IDs");
  const expectedCurrent = draft && input.scenarios.length === 0 ? 0 : 1;
  if (input.operation.site_id !== input.site.id || input.assets.some(a => a.site_id !== input.site.id) || input.scenarios.filter(s => s.role === "current").length !== expectedCurrent) invalid("site references / current scenario");
  for (const limit of input.limits) if (limit.unit !== metricUnits[limit.metric]) invalid("limit units");
  for (const s of input.scenarios) {
    if (s.site_revision !== input.site.revision || s.operation_revision !== input.operation.revision || (s.benchmark && s.benchmark.scenario_id !== s.id)) invalid("scenario revision references");
    unique(s.loads.map(l => l.id), "load IDs"); unique(s.loads.map(l => l.asset_id), "load asset references"); unique(s.loads.flatMap(l => l.component_ids), "load components");
    if (!draft && s.loads.length !== input.assets.length) invalid("asset accounting assignments");
    for (const l of s.loads) {
      const a = input.assets.find(item => item.id === l.asset_id);
      if (!a || a.revision !== l.asset_revision || !sameJson([...a.component_ids].sort(), [...l.component_ids].sort())) invalid("load asset reference");
    }
    unique(s.costs.map(c => c.id), "cost IDs"); unique(s.costs.map(c => c.category), "cost categories"); unique(s.costs.flatMap(c => c.component_ids), "cost components");
    if (s.costs.some(c => c.asset_ids.some(a => !input.assets.some(asset => asset.id === a)))) invalid("cost asset references");
  }
}

/** Drafts may lack assignments, but any reference already supplied must resolve exactly. */
export function validateSitePlanDraft(value: unknown): SiteComparisonResult<SitePlanDraft> {
  try {
    checkJsonTree(value); draftRequest(value, "draft");
    checkReferences(value as SitePlanDraft, true);
    return { ok: true, value: structuredClone(value as SitePlanDraft) };
  } catch (error) { return failure("invalid_artifact", error instanceof Error ? error.message : "Invalid planning draft."); }
}

// Mirror the existing backend schema's cross-field checks, not its numerical calculations.
function checkRequestRules(input: SiteComparisonRequest): void {
  const site = input.site;
  if (site.length_ft !== null && site.width_ft !== null && site.canopy_sqft !== null && site.canopy_sqft > site.length_ft * site.width_ft) invalid("site.canopy_sqft (canopy must fit the entered floor area)");
  for (const limit of input.limits) {
    if (limit.minimum !== null && limit.maximum !== null && limit.minimum > limit.maximum) invalid(`limits.${limit.id} (minimum exceeds maximum)`);
    if (!limit.enabled && !limit.reason) invalid(`limits.${limit.id}.reason (disabled limit)`);
  }
  const bases = { electricity: "kwh", water: "liter", routine_labor: "routine_hour", setup_labor: "setup_hour", consumables: "cycle", maintenance: "cycle", new_equipment: "horizon", setup_materials: "horizon" };
  for (const [index, scenario] of input.scenarios.entries()) {
    const p = `scenarios[${index}]`, lighting = scenario.lighting;
    if (lighting.min_hours > lighting.max_hours) invalid(`${p}.lighting (minimum hours exceed maximum hours)`);
    if (!lighting.dimmable && lighting.dim_fraction !== 1) invalid(`${p}.lighting.dim_fraction (non-dimmable output must be 1)`);
    if (!scenario.loads.some(load => load.accounting === "lighting")) invalid(`${p}.loads (at least one lighting component)`);
    for (const load of scenario.loads) {
      if (load.status === "excluded" && !load.reason) invalid(`${p}.loads.${load.id}.reason (excluded load)`);
      if (load.accounting === "unpowered" && input.assets.find(asset => asset.id === load.asset_id)?.watts !== 0) invalid(`${p}.loads.${load.id} (unpowered requires explicit zero watts)`);
      if (load.accounting === "lighting" && load.hours_per_day !== lighting.hours_per_day) invalid(`${p}.loads.${load.id}.hours_per_day (must equal lighting schedule)`);
    }
    for (const cost of scenario.costs) {
      const cp = `${p}.costs.${cost.id}`;
      if (cost.basis !== bases[cost.category]) invalid(`${cp}.basis (must match category)`);
      if (cost.basis === "horizon" ? cost.rate !== null : cost.amount !== null) invalid(`${cp} (use either the category's rate or horizon amount)`);
      if (cost.status === "excluded" && !cost.reason) invalid(`${cp}.reason (excluded cost)`);
      if (cost.category === "electricity" && cost.rate !== null && cost.rate > 10) invalid(`${cp}.rate (maximum supported tariff is 10 USD/kWh)`);
      if (cost.category === "new_equipment" && cost.status === "known" && cost.amount && (!cost.asset_ids.length || cost.asset_ids.some(id => input.assets.find(asset => asset.id === id)?.ownership !== "proposed"))) invalid(`${cp}.asset_ids (new cash must reference proposed assets)`);
    }
    const uncertainty = scenario.benchmark?.uncertainty;
    if (uncertainty && uncertainty.lower > uncertainty.upper) invalid(`${p}.benchmark.uncertainty (lower exceeds upper)`);
  }
}

/** Schema readiness is not measurement verification or review authorization. */
export function validateSiteComparisonRequest(value: unknown): SiteComparisonResult<SiteComparisonRequest> {
  try {
    checkJsonTree(value); request(value, "request");
    const input = value as SiteComparisonRequest;
    checkReferences(input); checkRequestRules(input);
    return { ok: true, value: structuredClone(input) };
  } catch (error) { return failure("invalid_artifact", error instanceof Error ? error.message : "Invalid comparison inputs."); }
}

async function hash(bytes: string): Promise<string> {
  const output = await globalThis.crypto.subtle.digest("SHA-256", UTF8.encode(bytes));
  return Array.from(new Uint8Array(output), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Structural and byte-integrity checks only: never authorship, measured truth, or server verification. */
export async function validateSiteComparisonArtifact(value: unknown): Promise<SiteComparisonResult<SiteComparisonArtifact>> {
  if (!value || typeof value !== "object" || (value as { schema_version?: unknown }).schema_version !== "site-scenario-comparison/2.0.0") return failure("unsupported_version", "Unsupported site comparison version. The original file and saved history were not changed.");
  if (!globalThis.crypto?.subtle) return failure("crypto_unavailable", "Local SHA-256 integrity checks are unavailable. Keep the original JSON file; nothing was imported.");
  try {
    if (UTF8.encode(JSON.stringify(value)).byteLength > MAX_SITE_COMPARISON_IMPORT_BYTES) return failure("too_large", "Comparison exceeds the 16 MiB import limit. The original file was not changed.");
    checkJsonTree(value); artifactShape(value, "artifact");
    const artifact = value as SiteComparisonArtifact, p = artifact.payload;
    const parsedPayload: unknown = JSON.parse(artifact.canonical_json), parsedInput: unknown = JSON.parse(p.input_canonical_json);
    checkJsonTree(parsedPayload); checkJsonTree(parsedInput);
    if (!sameJson(parsedPayload, p) || !sameJson(parsedInput, p.input_snapshot) || await hash(artifact.canonical_json) !== artifact.sha256 || await hash(p.input_canonical_json) !== p.input_sha256) return failure("digest_mismatch", "Comparison content or canonical-byte digest does not match. Nothing was imported; keep the original file for review.");
    checkReferences(p.input_snapshot);
    unique(p.evaluations.map(e => e.id), "evaluation IDs"); unique(p.evaluations.map(e => e.scenario_id), "evaluation scenario IDs");
    unique(p.ranks.map(r => r.scenario_id), "rank scenario IDs"); unique(p.differences.map(d => d.scenario_id), "difference scenario IDs"); unique(p.preferred_scenario_ids, "preferred scenario IDs");
    if (p.evaluations.length !== p.scenario_count || p.scenario_count !== p.input_snapshot.scenarios.length || p.ranks.length !== p.scenario_count || p.differences.length !== p.scenario_count || p.feasible_count !== p.evaluations.filter(e => e.feasibility === "pass").length || p.baseline_scenario_id !== p.input_snapshot.scenarios.find(s => s.role === "current")?.id) invalid("comparison identities and counts");
    for (const e of p.evaluations) {
      const s = p.input_snapshot.scenarios.find(s => s.id === e.scenario_id);
      if (!s || s.revision !== e.scenario_revision || !sameJson(s, e.snapshot.scenario) || !sameJson(e.snapshot.site, p.input_snapshot.site) || !sameJson(e.snapshot.assets, p.input_snapshot.assets) || !sameJson(e.snapshot.operation, p.input_snapshot.operation) || !sameJson(e.snapshot.limits, p.input_snapshot.limits)) invalid("evaluation snapshot references");
      if (e.requested_setting.hours !== s.lighting.hours_per_day || e.requested_setting.dim !== s.lighting.dim_fraction || e.requested_setting.candidate_id !== candidateId({ photoperiod_hours: e.requested_setting.hours, dim_fraction: e.requested_setting.dim })) invalid("requested setting identity");
      unique(e.constraints.map(c => c.id), "constraint IDs"); unique(e.formulas.map(f => f.id), "formula IDs"); unique(e.usage_lines.map(l => l.id), "usage IDs"); unique(e.cost_lines.map(l => l.id), "expense IDs");
      for (const key of metricKeys) {
        const m = e.metrics[key];
        if (m.complete !== (m.value !== null) || (m.complete && m.unknown_line_ids.length) || m.unit !== metricUnits[key]) invalid("metric completeness or units");
      }
      if (e.constraints.some(c => c.unit !== metricUnits[c.metric])) invalid("constraint units");
      if (e.module_result) {
        const r = e.module_result, run = r.run!;
        if (r.model_version !== p.lighting_model_version || run.model_version !== r.model_version || run.source !== r.source || run.status !== r.status || r.candidates.length !== r.configurations_evaluated || r.candidates.filter(c => c.feasible).length !== r.feasible_configurations || run.input_snapshot.baseline_hours !== e.requested_setting.hours || run.input_snapshot.baseline_dim !== e.requested_setting.dim) invalid("lighting module identity");
        unique(r.candidates.map(candidateId), "module setting IDs");
      }
      const rank = p.ranks.find(r => r.scenario_id === e.scenario_id);
      if (!rank || rank.evaluation_id !== e.id || !p.differences.some(d => d.scenario_id === e.scenario_id)) invalid("rank / difference references");
    }
    if (p.preferred_scenario_ids.some(id => !p.ranks.some(r => r.scenario_id === id && r.eligible && r.rank === 1))) invalid("preferred scenario references");
    return { ok: true, value: structuredClone(artifact) };
  } catch (error) { return failure("invalid_artifact", error instanceof Error && error.message.startsWith("Invalid comparison data") ? error.message : "Comparison structure could not be validated. Nothing was imported."); }
}

export async function importSiteComparisonJson(text: string): Promise<SiteComparisonResult<SiteComparisonArtifact>> {
  if (UTF8.encode(text).byteLength > MAX_SITE_COMPARISON_IMPORT_BYTES) return failure("too_large", "Comparison exceeds the 16 MiB import limit. Nothing was imported.");
  let value: unknown;
  try { value = JSON.parse(text); } catch { return failure("invalid_json", "This file is not valid comparison JSON. The original file and saved history were not changed."); }
  return validateSiteComparisonArtifact(value);
}

async function validateStore(value: unknown, legacy = false): Promise<SiteComparisonResult<SiteComparisonStore>> {
  try {
    checkJsonTree(value);
    const fields: Record<string, Check> = { working: nullable(legacy ? request : draftRequest), history: array(shape({ artifact: record, important: bool }), 100000), selectedComparisonId: nullable(id), selectedScenarioId: nullable(id) };
    if (!legacy && value && typeof value === "object") {
      if (Object.hasOwn(value, "otherWorking")) fields.otherWorking = array(draftRequest, MAX_OTHER_SITE_DRAFTS);
      if (Object.hasOwn(value, "selectedSiteId")) fields.selectedSiteId = nullable(id);
    }
    shape(fields)(value, "store");
    const state = value as SiteComparisonStore;
    const drafts = [...(state.working ? [state.working] : []), ...(state.otherWorking ?? [])];
    unique(drafts.map(draft => draft.site.id), "working site IDs");
    // Older v2 stores were shape-only checked; retain readable historical working data.
    if (!legacy) for (const draft of drafts) checkReferences(draft, true);
    for (const item of state.history) { const result = await validateSiteComparisonArtifact(item.artifact); if (!result.ok) return result; }
    unique(state.history.map(h => h.artifact.payload.id), "saved comparison IDs");
    if (state.selectedSiteId != null && !drafts.some(draft => draft.site.id === state.selectedSiteId) && !state.history.some(entry => entry.artifact.payload.input_snapshot.site.id === state.selectedSiteId)) invalid("selected site reference");
    if (state.selectedComparisonId === null && state.selectedScenarioId !== null && !state.working?.scenarios.some(s => s.id === state.selectedScenarioId)) invalid("selected working scenario");
    if (state.selectedComparisonId !== null) {
      const artifact = state.history.find(h => h.artifact.payload.id === state.selectedComparisonId)?.artifact;
      if (!artifact || (state.selectedScenarioId !== null && !artifact.payload.evaluations.some(e => e.scenario_id === state.selectedScenarioId))) invalid("historical selection");
    }
    return { ok: true, value: structuredClone(state) };
  } catch (error) { return failure("invalid_artifact", error instanceof Error ? error.message : "Invalid comparison storage."); }
}

export async function deserializeSiteComparisonStore(raw: string | null): Promise<SiteComparisonResult<SiteComparisonStore>> {
  if (raw === null) return { ok: true, value: emptySiteComparisonStore() };
  if (UTF8.encode(raw).byteLength > MAX_STORE_BYTES) return failure("too_large", "Saved comparison data exceeds the 64 MiB safe-read limit. It has been preserved unchanged.");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return failure("invalid_json", "Existing comparison storage cannot be read. It has been preserved unchanged; new work is session-only."); }
  if (!value || typeof value !== "object" || ![2, 3].includes((value as { schema_version: number }).schema_version)) return failure("unsupported_version", "Existing comparison storage uses an unsupported version. It has been preserved unchanged.");
  const { schema_version: _version, ...state } = value as Record<string, unknown>;
  return validateStore(state, _version === 2);
}

export async function serializeSiteComparisonStore(state: SiteComparisonStore): Promise<SiteComparisonResult<string>> {
  const result = await validateStore(state);
  if (!result.ok) return result;
  const raw = JSON.stringify({ schema_version: 3, ...result.value });
  return UTF8.encode(raw).byteLength > MAX_STORE_BYTES ? failure("too_large", "Comparison history exceeds the 64 MiB safe-write limit. No history was removed; export this session.") : { ok: true, value: raw };
}

export async function readSiteComparisonStore(storage: SiteComparisonStorage): Promise<SiteComparisonStorageResult<SiteComparisonStore>> {
  let raw: string | null;
  try { raw = storage.getItem(SITE_COMPARISON_STORAGE_KEY); } catch { return storageFailure("storage_unavailable", "Browser comparison storage is unavailable. Work remains session-only; JSON export is available.", null); }
  const result = await deserializeSiteComparisonStore(raw);
  return result.ok ? { ...result, raw } : { ...result, raw, sessionOnly: true };
}

/** Compare-and-write, no eviction. Never overwrite unreadable bytes or another tab's newer data. */
export async function writeSiteComparisonStore(storage: SiteComparisonStorage, state: SiteComparisonStore, expectedRaw: string | null): Promise<SiteComparisonStorageResult<SiteComparisonStore>> {
  let previous: string | null;
  try { previous = storage.getItem(SITE_COMPARISON_STORAGE_KEY); } catch { return storageFailure("storage_unavailable", "Browser comparison storage is unavailable. Work remains session-only; export remains available.", expectedRaw); }
  if (previous !== expectedRaw) return storageFailure("storage_conflict", "Saved comparisons changed in another tab. Existing bytes were preserved; reload or export this session before reconciling.", previous);
  const old = await deserializeSiteComparisonStore(previous);
  if (!old.ok) return { ...old, raw: previous, sessionOnly: true };
  for (const entry of old.value.history) {
    const next = state.history.find(h => h.artifact.payload.id === entry.artifact.payload.id);
    if (!next || next.artifact.sha256 !== entry.artifact.sha256) return storageFailure("history_conflict", "Saving would remove or replace existing comparison evidence. Existing history was preserved; export this session.", previous);
  }
  const previousDrafts = [...(old.value.working ? [old.value.working] : []), ...(old.value.otherWorking ?? [])];
  const nextDrafts = [...(state.working ? [state.working] : []), ...(state.otherWorking ?? [])];
  if (previousDrafts.some(draft => !nextDrafts.some(next => next.site.id === draft.site.id))) return storageFailure("storage_conflict", "Saving would remove an existing planning site. Park its working draft before switching sites; saved bytes were preserved.", previous);
  const serialized = await serializeSiteComparisonStore(state);
  if (!serialized.ok) return { ...serialized, raw: previous, sessionOnly: true };
  // Hash validation yields to the event loop, so repeat the concurrency check immediately before setItem.
  try {
    if (storage.getItem(SITE_COMPARISON_STORAGE_KEY) !== previous) return storageFailure("storage_conflict", "Saved comparisons changed during validation. Existing bytes were preserved; export this session.", previous);
    storage.setItem(SITE_COMPARISON_STORAGE_KEY, serialized.value);
  } catch (error) {
    const quota = error instanceof Error && /quota|storage.*full/i.test(`${error.name} ${error.message}`);
    return storageFailure(quota ? "storage_full" : "storage_unavailable", quota ? "Browser storage is full. No comparisons were evicted. This change is session-only; download JSON or the evidence ZIP." : "Browser storage could not save this change. Prior saved bytes remain intact; export this session.", previous);
  }
  return { ok: true, value: structuredClone(state), raw: serialized.value };
}

/** Select an authored draft, parking the previous site without touching saved comparisons. */
export function withSiteWorking(state: SiteComparisonStore, draft: SitePlanDraft): SiteComparisonResult<SiteComparisonStore> {
  const checked = validateSitePlanDraft(draft);
  if (!checked.ok) return checked;
  const existing = [...(state.working ? [state.working] : []), ...(state.otherWorking ?? [])];
  if (new Set(existing.map(item => item.site.id)).size !== existing.length) return failure("storage_conflict", "Multiple working drafts have the same site ID. Nothing was replaced; reconcile the existing drafts first.");
  for (const item of existing) {
    const result = validateSitePlanDraft(item);
    if (!result.ok) return result;
  }
  const parked = existing.filter(item => item.site.id !== draft.site.id);
  if (parked.length > MAX_OTHER_SITE_DRAFTS) return failure("too_large", `At most ${MAX_OTHER_SITE_DRAFTS} other planning sites can be parked in this browser. Nothing was evicted or replaced.`);
  const selectedScenarioId = state.working?.site.id === draft.site.id && state.selectedComparisonId === null && checked.value.scenarios.some(scenario => scenario.id === state.selectedScenarioId)
    ? state.selectedScenarioId : checked.value.scenarios.find(scenario => scenario.role === "current")?.id ?? null;
  return { ok: true, value: { ...state, working: checked.value, otherWorking: structuredClone(parked), selectedSiteId: draft.site.id, selectedComparisonId: null, selectedScenarioId } };
}

/** History alone is not a working draft; restoration never silently copies historical inputs. */
export function activateSiteWorking(state: SiteComparisonStore, siteId: string): SiteComparisonResult<SiteComparisonStore> {
  const draft = state.working?.site.id === siteId ? state.working : state.otherWorking?.find(item => item.site.id === siteId);
  if (!draft) return failure("not_found", "That site has no saved working draft. Historical comparisons remain read-only; explicitly create or import a planning draft to continue.");
  return withSiteWorking(state, draft);
}

/** Call only with a freshly returned or successfully validated artifact; persistence validates again. */
export function appendSiteComparison(state: SiteComparisonStore, artifact: SiteComparisonArtifact): SiteComparisonResult<SiteComparisonStore> {
  const prior = state.history.find(h => h.artifact.payload.id === artifact.payload.id);
  if (prior && prior.artifact.sha256 !== artifact.sha256) return failure("history_conflict", "That comparison ID already has different saved content. Existing evidence was not replaced.");
  return { ok: true, value: { ...state, history: prior ? state.history : [{ artifact: structuredClone(artifact), important: false }, ...state.history], selectedSiteId: artifact.payload.input_snapshot.site.id, selectedComparisonId: artifact.payload.id, selectedScenarioId: artifact.payload.baseline_scenario_id } };
}

export function selectSiteComparison(state: SiteComparisonStore, comparisonId: string | null, scenarioId?: string | null): SiteComparisonResult<SiteComparisonStore> {
  if (comparisonId === null) {
    const selected = scenarioId ?? state.working?.scenarios.find(s => s.role === "current")?.id ?? null;
    if (selected !== null && !state.working?.scenarios.some(s => s.id === selected)) return failure("not_found", "That working scenario is not available. Current working inputs were not changed.");
    return { ok: true, value: { ...state, selectedSiteId: state.working?.site.id ?? null, selectedComparisonId: null, selectedScenarioId: selected } };
  }
  const artifact = state.history.find(h => h.artifact.payload.id === comparisonId)?.artifact;
  const selected = scenarioId ?? artifact?.payload.baseline_scenario_id;
  if (!artifact || !selected || !artifact.payload.evaluations.some(e => e.scenario_id === selected)) return failure("not_found", "That historical comparison or scenario is not available. Current working inputs were not changed.");
  return { ok: true, value: { ...state, selectedSiteId: artifact.payload.input_snapshot.site.id, selectedComparisonId: comparisonId, selectedScenarioId: selected } };
}

export function markSiteComparisonImportant(state: SiteComparisonStore, comparisonId: string, important: boolean): SiteComparisonStore {
  return { ...state, history: state.history.map(h => h.artifact.payload.id === comparisonId ? { ...h, important } : h) };
}
