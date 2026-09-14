import { test, expect } from "@playwright/test";
import { candidateId, buildCandidateIdentityMetadata } from "../lib/candidate-identity";
import { buildRunCsv, buildRunExportRows, type RunExportRow } from "../lib/run-export";
import { SAMPLE_SCENARIO } from "../lib/sample";
import type { RunReference } from "../lib/live/types";
import type { Candidate, OptimizationResult, RunEvidence } from "../lib/types";

// Synthetic unit fixture with three recorded settings, not a full solver run.
function fixture(): OptimizationResult {
  const baseline: Candidate = {
    photoperiod_hours: 16, dim_fraction: 1, daily_energy_kwh: 10.68,
    period_energy_kwh: 3898.2, period_energy_cost_usd: 584.73, peak_modeled_watts: 645,
    dli_mol_m2_day: 20.16, period_water_liters: null, canopy_sqft: 32,
    feasible: true, rejected_for: [],
  };
  const selected: Candidate = {
    ...baseline, photoperiod_hours: 12, daily_energy_kwh: 8.28,
    period_energy_kwh: 3022.2, period_energy_cost_usd: 453.33, dli_mol_m2_day: 15.12,
  };
  const rejected: Candidate = {
    ...baseline, photoperiod_hours: 11.75, daily_energy_kwh: 8.13,
    period_energy_kwh: 2967.45, period_energy_cost_usd: 445.1175, dli_mol_m2_day: 14.805,
    feasible: false, rejected_for: ["minimum_dli"],
  };
  const savings: NonNullable<OptimizationResult["savings"]> = {
    period_energy_kwh: 876, period_energy_cost_usd: 131.4, energy_pct: 22.47,
    water_liters: null, yield_gain_lb: null, avoided_capex_usd: null,
    new_equipment_required_by_scenario_usd: 0,
  };
  const evidence: RunEvidence = {
    summary: "Synthetic three-setting export test.", inputs: [], baseline, selected, savings,
    formulas: [], objective: "Minimize unrounded daily energy among evaluated feasible settings.",
    constraints: [
      { name: "photoperiod", unit: "h/day", minimum: 10, maximum: 18, evaluated: true,
        baseline_value: 16, baseline_passed: true, selected_value: 12, selected_passed: true, rejected_configurations: 0 },
      { name: "minimum_dli", unit: "mol/m^2/day", minimum: 15, maximum: null, evaluated: true,
        baseline_value: 20.16, baseline_passed: true, selected_value: 15.12, selected_passed: true, rejected_configurations: 1 },
      { name: "modeled_power_limit", unit: "W", minimum: null, maximum: 1800, evaluated: true,
        baseline_value: 645, baseline_passed: true, selected_value: 645, selected_passed: true, rejected_configurations: 0 },
    ],
    configurations_evaluated: 3, feasible_configurations: 2, selection_reason: "Minimum modeled energy in this fixture.",
    alternatives: [{ kind: "selected", reason: null, candidate: selected },
      { kind: "rejected", reason: "minimum_dli", candidate: rejected }],
    horizon: { operating_days: 365, electricity_usd_kwh: 0.15 },
    assumptions: ["All values are synthetic test assumptions."], missing_inputs: [],
    limitations: ["DLI does not establish maintained yield."],
  };
  return {
    model_version: "synthetic-export-test", source: "sample", status: "optimized", operating_days: 365,
    baseline, optimized: selected, savings, configurations_evaluated: 3, feasible_configurations: 2,
    candidates: [rejected, selected, baseline], recommendations: ["Review the synthetic comparison."],
    limitations: evidence.limitations,
    run: {
      id: "synthetic-run-a", created_at: "2026-09-13T15:30:12.123456+00:00",
      model_version: "synthetic-export-test", source: "sample", status: "optimized",
      input_snapshot: { ...SAMPLE_SCENARIO, confirmed: true, water_liters_day: null }, evidence,
    },
  };
}

const reference: RunReference = {
  id: "synthetic-run-a", workspace_revision: 7, accepted_revision: 4,
  proposal_id: "test-proposal", proposal_version: 2,
};

function row(rows: RunExportRow[], section: string, field: string, id?: string): RunExportRow {
  const matches = rows.filter(value => value.section === section && value.field === field && (id === undefined || value.candidate_id === id));
  expect(matches).toHaveLength(1);
  return matches[0];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

// Read complete CSV fields, including embedded commas, doubled quotes and CRLF.
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

test("CSV traces the original run, units, horizon and matched workspace reference", () => {
  const result = fixture();
  const rows = buildRunExportRows(result, { reference, name: "Synthetic test space",
    inputFallback: { ...SAMPLE_SCENARIO, ppfd_full: 999, lighting_watts: 9999 } });
  expect(rows.every(value => value.run_id === result.run!.id)).toBe(true);
  expect(row(rows, "metadata", "created_at").value).toBe(result.run!.created_at);
  expect(row(rows, "metadata", "model_version").value).toBe(result.model_version);
  expect(row(rows, "metadata", "source").value).toBe("sample");
  expect(row(rows, "metadata", "provenance").value).toContain("Synthetic sample");
  expect(row(rows, "metadata", "canonical_record").value).toContain("Complete JSON");
  expect(row(rows, "metadata", "server_verification").value).toBe("not_checked");
  expect(row(rows, "metadata", "input_snapshot_status").value).toBe("recorded_original");
  for (const [field, value] of Object.entries(result.run!.input_snapshot)) {
    expect(row(rows, "inputs", field)).toMatchObject({ value, note: expect.stringContaining("Original run.input_snapshot") });
    expect(row(rows, "inputs", field).unit.length).toBeGreaterThan(0);
  }
  for (const [field, unit] of Object.entries({ lighting_watts: "W", ppfd_full: "umol/m^2/s", min_dli: "mol/m^2/day", electricity_usd_kwh: "USD/kWh", operating_days: "days" })) {
    expect(row(rows, "inputs", field).unit).toBe(unit);
  }
  for (const [field, value] of Object.entries(reference)) expect(row(rows, "workspace_reference", field).value).toBe(value);
  expect(row(rows, "search", "operating_days").value).toBe(365);
  expect(row(rows, "inputs", "dimmable").value).toBe(false);
  expect(row(rows, "inputs", "water_liters_day").value).toBeNull();
});

test("candidate IDs survive filters, reorder, display-rounding collisions and JSON round trips", () => {
  const result = fixture();
  const ids = result.candidates.map(candidateId);
  expect(result.candidates.filter(value => value.feasible).reverse().map(candidateId)).toEqual([ids[2], ids[1]]);
  const closeSettings = [
    { photoperiod_hours: 12, dim_fraction: 1 },
    { photoperiod_hours: 12.000000000000002, dim_fraction: 1 },
    { photoperiod_hours: 12, dim_fraction: 0.9999999999999999 },
    { photoperiod_hours: 12.125, dim_fraction: 0.875 },
    { photoperiod_hours: 1e-7, dim_fraction: 0.5 },
  ];
  expect(new Set(closeSettings.map(candidateId)).size).toBe(closeSettings.length);
  expect(JSON.parse(JSON.stringify(closeSettings)).map(candidateId)).toEqual(closeSettings.map(candidateId));
  expect(candidateId({ ...result.candidates[1], feasible: false } as Candidate)).toBe(ids[1]);
  expect(candidateId({ photoperiod_hours: -0, dim_fraction: 1 })).toBe(candidateId({ photoperiod_hours: 0, dim_fraction: 1 }));
  for (const invalid of [NaN, Infinity, -Infinity]) {
    expect(() => candidateId({ photoperiod_hours: invalid, dim_fraction: 1 })).toThrow(/finite/);
    expect(() => candidateId({ photoperiod_hours: 12, dim_fraction: invalid })).toThrow(/finite/);
  }
});

test("JSON identity metadata and explanation alternatives share CSV IDs without changing canonical results", () => {
  const result = deepFreeze(fixture());
  const original = JSON.stringify(result);
  const metadata = buildCandidateIdentityMetadata(result);
  const rows = buildRunExportRows(result);
  expect(metadata).toMatchObject({ run_id: result.run!.id, scope: "run",
    baseline_candidate_id: candidateId(result.baseline), selected_candidate_id: candidateId(result.optimized!) });
  for (const alternative of metadata.alternatives) {
    expect(row(rows, "candidate", "photoperiod_hours", alternative.candidate_id).value).toBe(metadata.candidates[alternative.candidate_id].photoperiod_hours);
  }
  expect(buildCandidateIdentityMetadata({ ...result, candidates: [...result.candidates].reverse() })).toEqual(metadata);
  const otherRun = buildCandidateIdentityMetadata({ ...result, run: { ...result.run!, id: "synthetic-run-b" } });
  expect(otherRun.candidates).toEqual(metadata.candidates);
  expect(otherRun.run_id).not.toBe(metadata.run_id);
  buildRunCsv(result, { reference });
  const envelope = JSON.parse(JSON.stringify({ result, candidate_identity: metadata }));
  expect(envelope.result).toEqual(result);
  metadata.candidates[candidateId(result.baseline)].photoperiod_hours = 20;
  expect(JSON.stringify(result)).toBe(original);
});

test("all candidate metrics and recorded feasibility survive without recomputation", () => {
  const result = fixture();
  // Deliberately keep a recorded rejection whose rounded DLI appears to pass.
  result.candidates[0].dli_mol_m2_day = 15;
  result.candidates[0].rejected_for.push("modeled_power_limit");
  const rows = buildRunExportRows(result);
  expect(rows.filter(value => value.section === "candidate" && value.field === "feasible")).toHaveLength(3);
  for (const candidate of result.candidates) {
    const id = candidateId(candidate);
    for (const [field, value] of Object.entries(candidate)) {
      expect(row(rows, "candidate", field, id).value).toEqual(field === "rejected_for" ? JSON.stringify(value) : value);
    }
  }
  for (const constraint of result.run!.evidence.constraints) {
    for (const [field, value] of Object.entries(constraint)) {
      if (field !== "name" && field !== "unit") expect(row(rows, "constraints", `${constraint.name}.${field}`).value).toEqual(value);
    }
  }
  expect(row(rows, "baseline", "feasible").value).toBe(true);
  expect(row(rows, "selected", "feasible").value).toBe(true);
  expect(row(rows, "candidate", "rejected_for", candidateId(result.candidates[0])).value).toBe('["minimum_dli","modeled_power_limit"]');
});

test("solver differences preserve positive, zero and negative signs instead of subtracting rounded totals", () => {
  for (const difference of [876.0001, 0, -438]) {
    const result = fixture();
    result.savings = { ...result.savings!, period_energy_kwh: difference, period_energy_cost_usd: difference === 0 ? 0 : -65.7 };
    const rows = buildRunExportRows(result);
    expect(row(rows, "difference", "period_energy_kwh").value).toBe(difference);
    expect(row(rows, "difference", "period_energy_kwh").note).toContain("Baseline minus selected");
    expect(row(rows, "difference", "period_energy_kwh").note).toContain("negative means more");
    const line = buildRunCsv(result).split("\r\n").find(value => value.startsWith('"difference",') && value.includes('"period_energy_kwh"'))!;
    expect(line).toContain(`,"period_energy_kwh",${difference},"kWh",`);
    for (const field of ["water_liters", "yield_gain_lb", "avoided_capex_usd"]) expect(row(rows, "unsupported", field).value).toBeNull();
  }
});

test("missing measurements remain null and have no tested or selected candidate identity", () => {
  const result = fixture();
  result.status = "needs_measurement";
  result.candidates = [];
  result.configurations_evaluated = result.feasible_configurations = 0;
  result.optimized = result.savings = null;
  result.baseline.dli_mol_m2_day = null;
  result.run!.status = result.status;
  result.run!.input_snapshot.ppfd_full = null;
  result.run!.evidence = { ...result.run!.evidence, selected: null, savings: null, alternatives: [],
    missing_inputs: ["ppfd_full"], configurations_evaluated: 0, feasible_configurations: 0,
    constraints: result.run!.evidence.constraints.map(value => ({ ...value, evaluated: false, baseline_passed: null, selected_value: null, selected_passed: null, rejected_configurations: 0 })) };
  const rows = buildRunExportRows(result);
  expect(row(rows, "inputs", "ppfd_full").value).toBeNull();
  expect(row(rows, "selected", "available").value).toBe(false);
  expect(row(rows, "baseline", "tested").value).toBe(false);
  expect(row(rows, "baseline", "feasible")).toMatchObject({ value: null, candidate_id: null });
  expect(row(rows, "difference", "period_energy_kwh").value).toBeNull();
  expect(row(rows, "evidence", "missing_inputs").value).toBe('["ppfd_full"]');
  expect(row(rows, "constraints", "minimum_dli.baseline_passed").value).toBeNull();
  expect(rows.filter(value => value.section === "candidate")).toHaveLength(0);
  expect(buildCandidateIdentityMetadata(result)).toMatchObject({ candidates: {}, baseline_candidate_id: null, selected_candidate_id: null });
});

test("infeasible run exports every failed setting and no selected metrics or differences", () => {
  const result = fixture();
  result.status = "no_feasible_configuration";
  result.run!.status = result.status;
  result.run!.input_snapshot.power_limit_watts = 500;
  result.feasible_configurations = 0;
  result.optimized = result.savings = null;
  result.candidates = result.candidates.map(value => ({ ...value, feasible: false, rejected_for: [...value.rejected_for, "modeled_power_limit"] }));
  const rows = buildRunExportRows(result);
  expect(row(rows, "metadata", "status").value).toBe("no_feasible_configuration");
  expect(row(rows, "baseline", "feasible").value).toBe(false);
  expect(row(rows, "selected", "photoperiod_hours").value).toBeNull();
  expect(row(rows, "difference", "available").value).toBe(false);
  for (const candidate of result.candidates) {
    expect(row(rows, "candidate", "feasible", candidateId(candidate)).value).toBe(false);
    expect(row(rows, "candidate", "rejected_for", candidateId(candidate)).value).toContain("modeled_power_limit");
  }
});

test("legacy results retain unknown identity even with a reference and fallback inputs", () => {
  for (const artifact of [undefined, null]) {
    const result = { ...fixture(), run: artifact };
    const rows = buildRunExportRows(result, { reference, inputFallback: { ...SAMPLE_SCENARIO, ppfd_full: 987 } });
    expect(rows.every(value => value.run_id === "unknown")).toBe(true);
    expect(row(rows, "metadata", "export_scope").value).toContain("Summary only");
    expect(row(rows, "metadata", "created_at").value).toBe("unknown");
    expect(row(rows, "metadata", "input_snapshot_status").value).toBe("unverified_fallback");
    expect(row(rows, "workspace_reference", "id").value).toBeNull();
    expect(row(rows, "workspace_reference", "status").value).toBe("unknown_legacy_identity");
    expect(row(rows, "input_fallback", "ppfd_full")).toMatchObject({ value: 987, note: expect.stringContaining("not verified") });
    expect(rows.some(value => value.section === "inputs")).toBe(false);
    expect(row(rows, "constraints", "evidence_status").value).toContain("unknown");
    expect(buildCandidateIdentityMetadata(result)).toMatchObject({ run_id: null, scope: "unknown_legacy" });
    expect(row(buildRunExportRows(result), "input_fallback", "ppfd_full").value).toBeNull();
  }
});

test("an unrelated workspace reference cannot be attached to a run", () => {
  const rows = buildRunExportRows(fixture(), { reference: { ...reference, id: "different-run" } });
  expect(row(rows, "workspace_reference", "status").value).toBe("mismatch_ignored");
  expect(row(rows, "workspace_reference", "workspace_revision").value).toBeNull();
  expect(row(rows, "workspace_reference", "id").value).toBeNull();
  expect(row(rows, "metadata", "run_id").value).toBe("synthetic-run-a");
});

test("historical input records and assumptions stay separate from immutable server inputs", () => {
  const result = deepFreeze(fixture());
  const options = deepFreeze({ reference, inputRecords: { ppfd_full: { value: 999, source: "User note", measured_at: "2026-09-12", note: "=untrusted()" } },
    assumptions: { min_dli: { label: "Proposed crop requirement", source: "User reference", growth_stage: "Vegetative" } } });
  const original = JSON.stringify({ result, options });
  const rows = buildRunExportRows(result, options);
  expect(row(rows, "inputs", "ppfd_full").value).toBe(350);
  expect(JSON.parse(row(rows, "frontend_unvalidated_input_records", "excluded_metadata").value as string)).toEqual(options.inputRecords);
  expect(row(rows, "frontend_input_records", "metadata_status").value).toBe("invalid_or_stale_excluded");
  expect(JSON.parse(row(rows, "frontend_assumptions", "min_dli").value as string)).toEqual(options.assumptions.min_dli);
  for (const section of ["frontend_assumptions"]) {
    expect(row(rows, section, "metadata_status")).toMatchObject({ value: "frontend_local_unverified", note: expect.stringContaining("not server-verified") });
  }
  buildRunCsv(result, options);
  expect(JSON.stringify({ result, options })).toBe(original);
});

test("CSV round-trips multiline text and escapes spreadsheet formulas without altering signed numbers", () => {
  const dangerous = ["=1+1", "+SUM(A1)", "-438", "@SUM(A1)", "  =1", "\t=1", "\r=1", "\n@x", "\u0000 =1", "\uFF1D1+1"];
  for (const name of dangerous) {
    const result = fixture();
    result.run!.id = "=run()";
    result.run!.model_version = "+model()";
    result.run!.evidence.objective = "@objective()";
    result.savings!.period_energy_kwh = -438;
    const parsed = parseCsv(buildRunCsv(result, { name, reference: { ...reference, id: "=run()", proposal_id: "-proposal()" } }));
    expect(parsed.every(cells => cells.length === 7)).toBe(true);
    const csvValue = (section: string, field: string) => parsed.find(cells => cells[0] === section && cells[3] === field)![4];
    expect(csvValue("metadata", "name")).toBe(`'${name}`);
    expect(csvValue("metadata", "model_version")).toBe("'+model()");
    expect(csvValue("search", "objective")).toBe("'@objective()");
    expect(csvValue("workspace_reference", "proposal_id")).toBe("'-proposal()");
    expect(csvValue("difference", "period_energy_kwh")).toBe("-438");
    expect(parsed.slice(1).every(cells => cells[1] === "'=run()")).toBe(true);
  }
  const result = fixture();
  const name = 'Synthetic room, "north"\r\nsecond line';
  const rows = buildRunExportRows(result, { name });
  const parsed = parseCsv(buildRunCsv(result, { name }));
  expect(parsed[0]).toEqual(["section", "run_id", "candidate_id", "field", "value", "unit", "note"]);
  expect(parsed.slice(1)).toEqual(rows.map(value => [value.section, value.run_id, value.candidate_id, value.field, value.value, value.unit, value.note].map(cell => String(cell))));
});

test("manual and photo provenance never imply measured or server-verified input records", () => {
  for (const source of ["manual", "photo-assisted"] as const) {
    const result = fixture();
    result.source = result.run!.source = result.run!.input_snapshot.source = source;
    const rows = buildRunExportRows(result);
    expect(row(rows, "metadata", "source").value).toBe(source);
    expect(row(rows, "metadata", "provenance").value).toContain(source === "manual" ? "not independently verified" : "does not establish numerical measurements");
    expect(row(rows, "frontend_input_records", "metadata_status").value).toBe("not_provided");
  }
});
