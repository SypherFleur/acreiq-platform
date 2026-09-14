import { candidateId } from "./candidate-identity";
import { exportInputRecords } from "./input-records";
import type { LiveContext, RunReference } from "./live/types";
import type { Candidate, Metrics, OptimizationResult, Scenario } from "./types";

export type RunExportOptions = {
  /** Attached only when its id matches result.run.id. */
  reference?: RunReference | null;
  /** Used only without a run artifact; never represented as verified original inputs. */
  inputFallback?: Scenario | null;
  /** Caller-supplied display name, not immutable run metadata. */
  name?: string | null;
  /** Pass records saved with this historical run, not the current workspace. Frontend-local and unverified. */
  inputRecords?: Readonly<Partial<Record<keyof Scenario, unknown>>> | null;
  /** Frontend-local assumptions saved with this historical run, not server evidence. */
  assumptions?: LiveContext["assumptions"] | null;
};

export type RunExportRow = {
  section: string;
  run_id: string;
  candidate_id: string | null;
  field: string;
  value: string | number | boolean | null;
  unit: string;
  note: string;
};

const INPUT_UNITS: Record<keyof Scenario, string> = {
  source: "label", length_ft: "ft", width_ft: "ft", canopy_sqft: "ft^2",
  light_count: "fixtures", lighting_watts: "W", other_watts: "W", other_hours: "h/day",
  baseline_hours: "h/day", baseline_dim: "fraction", dimmable: "boolean",
  ppfd_full: "umol/m^2/s", min_dli: "mol/m^2/day", min_hours: "h/day", max_hours: "h/day",
  power_limit_watts: "W", electricity_usd_kwh: "USD/kWh", operating_days: "days",
  water_liters_day: "L/day", confirmed: "boolean",
};

const METRIC_UNITS: Record<keyof Metrics, string> = {
  photoperiod_hours: "h/day", dim_fraction: "fraction", daily_energy_kwh: "kWh/day",
  period_energy_kwh: "kWh", period_energy_cost_usd: "USD", peak_modeled_watts: "W",
  dli_mol_m2_day: "mol/m^2/day", period_water_liters: "L", canopy_sqft: "ft^2",
};

const PROVENANCE: Record<Scenario["source"], string> = {
  sample: "Synthetic sample assumptions; not measured site data.",
  manual: "User-entered inputs; measurements and crop requirements are not independently verified.",
  "photo-assisted": "Photo-assisted entry; vision does not establish numerical measurements or crop requirements.",
};

const DIFFERENCE_NOTE = "Baseline minus selected: positive means less energy/cost, negative means more, zero means no difference. Solver-reported values are preserved; rounded totals may not subtract to this value.";

/** A typed, long-form CSV projection. The complete JSON result remains canonical. */
export function buildRunExportRows(result: OptimizationResult, options: RunExportOptions = {}): RunExportRow[] {
  const run = result.run;
  const evidence = run?.evidence;
  const runId = run?.id ?? "unknown";
  const source = run?.source ?? result.source;
  const inputs = run ? run.input_snapshot : options.inputFallback;
  const reference = run && options.reference?.id === run.id ? options.reference : null;
  const rows: RunExportRow[] = [];
  const add = (section: string, field: string, value: RunExportRow["value"], unit = "", note = "", id: string | null = null) => {
    rows.push({ section, run_id: runId, candidate_id: id, field, value, unit, note });
  };

  add("metadata", "csv_schema", "acreiq-run-csv-1");
  add("metadata", "export_scope", run
    ? "Run-linked audit extract; complete JSON remains canonical."
    : "Summary only: legacy result has no run artifact. Run identity, timestamp and original inputs are unknown.");
  add("metadata", "canonical_record", run
    ? "Complete JSON result including run.input_snapshot, run.evidence and all candidates. CSV does not replace the full evidence and raw calculation formulas."
    : "Preserve the complete legacy JSON result; missing run evidence cannot be recovered from this summary.");
  add("metadata", "run_id", runId);
  add("metadata", "created_at", run?.created_at ?? "unknown", "ISO 8601", "Recorded run time, never the CSV export time.");
  add("metadata", "model_version", run?.model_version ?? result.model_version);
  add("metadata", "source", source);
  add("metadata", "provenance", PROVENANCE[source]);
  add("metadata", "status", run?.status ?? result.status);
  add("metadata", "name", options.name ?? null, "", "Caller-supplied display name; not recorded run identity.");
  add("metadata", "server_verification", "not_checked", "", "Saved evidence does not establish current server availability or independent verification.");
  add("metadata", "input_snapshot_status", run ? "recorded_original" : inputs ? "unverified_fallback" : "unknown");
  add("metadata", "null_convention", "null means unavailable or not applicable; it never means zero.");
  add("metadata", "difference_sign_convention", DIFFERENCE_NOTE);
  add("metadata", "candidate_identity_scope", "Use (run_id, candidate_id). Candidate IDs encode exact hours and dim fraction, independent of row order; unknown run_id is not a unique run identity.");
  add("metadata", "csv_string_safety", "Potential spreadsheet formulas in text are prefixed with an apostrophe. Numeric values retain their signs; JSON preserves original strings.");

  add("workspace_reference", "status", reference ? "matched" : !options.reference ? "not_provided" : !run ? "unknown_legacy_identity" : "mismatch_ignored");
  add("workspace_reference", "id", reference?.id ?? null);
  add("workspace_reference", "workspace_revision", reference?.workspace_revision ?? null);
  add("workspace_reference", "accepted_revision", reference?.accepted_revision ?? null);
  add("workspace_reference", "proposal_id", reference?.proposal_id ?? null);
  add("workspace_reference", "proposal_version", reference?.proposal_version ?? null);

  const inputSection = run ? "inputs" : "input_fallback";
  for (const field of Object.keys(INPUT_UNITS) as (keyof Scenario)[]) {
    const role = evidence?.inputs.find(input => input.field === field)?.used_for ?? "";
    add(inputSection, field, inputs?.[field] ?? null, INPUT_UNITS[field], run
      ? `Original run.input_snapshot. ${role}`.trim()
      : "Caller-supplied fallback or unknown; not verified as the original run inputs.");
  }

  const localNote = "Caller-supplied historical frontend metadata; not server-verified. Does not replace immutable run.input_snapshot values or run.evidence.";
  const recordExport = exportInputRecords(options.inputRecords, run?.input_snapshot);
  for (const [section, metadata] of [["frontend_input_records", recordExport.input_records], ["frontend_assumptions", options.assumptions]] as const) {
    add(section, "metadata_status", section === "frontend_input_records" ? recordExport.input_record_status : metadata == null ? "not_provided" : "frontend_local_unverified", "", localNote);
    for (const [field, value] of Object.entries(metadata ?? {})) {
      add(section, field, JSON.stringify(value) ?? null, "JSON", localNote);
    }
  }
  if (recordExport.unvalidated_input_records !== undefined) add("frontend_unvalidated_input_records", "excluded_metadata", JSON.stringify(recordExport.unvalidated_input_records), "JSON", "Invalid or stale for the original run snapshot; excluded from applicable measurement records. Preserved only for review.");

  add("search", "operating_days", result.operating_days, "days", "Operating horizon, not necessarily a calendar year.");
  add("search", "configurations_evaluated", result.configurations_evaluated, "settings");
  add("search", "feasible_configurations", result.feasible_configurations, "settings");
  add("search", "objective", evidence?.objective ?? null);
  add("search", "selection_reason", evidence?.selection_reason ?? null);

  const candidates = new Map(result.candidates.map(candidate => [candidateId(candidate), candidate]));
  const baselineId = candidateId(result.baseline);
  const selectedId = result.optimized ? candidateId(result.optimized) : null;
  const addMetrics = (section: string, metrics: Metrics | null, id: string | null) => {
    for (const field of Object.keys(METRIC_UNITS) as (keyof Metrics)[]) {
      add(section, field, metrics?.[field] ?? null, METRIC_UNITS[field], "Solver-reported value.", id);
    }
  };
  const addFeasibility = (section: string, candidate: Candidate | undefined, id: string | null) => {
    add(section, "feasible", candidate?.feasible ?? null, "boolean", "Recorded outcome; null means not evaluated or absent from the candidate ledger.", id);
    add(section, "rejected_for", candidate ? JSON.stringify(candidate.rejected_for) : null, "JSON array", "All recorded rejection reasons; no constraints are recalculated by the exporter.", id);
  };
  for (const [section, metrics, settingId] of [
    ["baseline", result.baseline, baselineId], ["selected", result.optimized, selectedId],
  ] as const) {
    const candidate = settingId === null ? undefined : candidates.get(settingId);
    const id = candidate ? settingId : null;
    add(section, "available", metrics !== null, "boolean", "", id);
    add(section, "tested", !!candidate, "boolean", "Membership in the recorded candidate ledger.", id);
    addMetrics(section, metrics, id);
    addFeasibility(section, candidate, id);
  }

  add("difference", "available", result.savings !== null, "boolean");
  add("difference", "period_energy_kwh", result.savings?.period_energy_kwh ?? null, "kWh", DIFFERENCE_NOTE, selectedId);
  add("difference", "period_energy_cost_usd", result.savings?.period_energy_cost_usd ?? null, "USD", DIFFERENCE_NOTE, selectedId);
  add("difference", "energy_pct", result.savings?.energy_pct ?? null, "%", `${DIFFERENCE_NOTE} Relative to baseline energy.`, selectedId);
  add("unsupported", "water_liters", result.savings?.water_liters ?? null, "L", "Water savings are not estimated.");
  add("unsupported", "yield_gain_lb", result.savings?.yield_gain_lb ?? null, "lb", "Yield gain is not estimated; maintained DLI does not establish maintained yield.");
  add("unsupported", "avoided_capex_usd", result.savings?.avoided_capex_usd ?? null, "USD", "Avoided purchases are not estimated.");
  add("scenario", "new_equipment_required_by_scenario_usd", result.savings?.new_equipment_required_by_scenario_usd ?? null, "USD", "Recorded candidate-space property, not a verified implementation cost or avoided purchase.");

  add("constraints", "evidence_status", evidence ? "recorded" : "unknown; no run artifact");
  for (const constraint of evidence?.constraints ?? []) {
    for (const field of ["minimum", "maximum", "baseline_value", "selected_value"] as const) {
      add("constraints", `${constraint.name}.${field}`, constraint[field], constraint.unit);
    }
    for (const field of ["evaluated", "baseline_passed", "selected_passed"] as const) {
      add("constraints", `${constraint.name}.${field}`, constraint[field], "boolean");
    }
    add("constraints", `${constraint.name}.rejected_configurations`, constraint.rejected_configurations, "settings", "Counts are independent; one candidate may fail multiple constraints.");
  }

  for (const candidate of result.candidates) {
    const id = candidateId(candidate);
    add("candidate", "is_baseline", id === baselineId, "boolean", "", id);
    add("candidate", "is_selected", id === selectedId, "boolean", "", id);
    addMetrics("candidate", candidate, id);
    addFeasibility("candidate", candidate, id);
  }

  add("evidence", "summary", evidence?.summary ?? null);
  add("evidence", "assumptions", evidence ? JSON.stringify(evidence.assumptions) : null, "JSON array");
  add("evidence", "missing_inputs", evidence ? JSON.stringify(evidence.missing_inputs) : null, "JSON array");
  add("evidence", "limitations", evidence ? JSON.stringify(evidence.limitations) : null, "JSON array");
  add("result", "limitations", JSON.stringify(result.limitations), "JSON array");
  add("result", "recommendations", JSON.stringify(result.recommendations), "JSON array");
  return rows;
}

function csvCell(value: RunExportRow["value"]): string {
  if (value === null) return "null";
  if (typeof value !== "string") return String(value);
  // Quoting alone does not prevent spreadsheet formula execution. Guard text
  // even after leading whitespace/control characters, without altering numbers.
  const safe = /^[\s\u0000-\u001f]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]|^[\t\r\n]/u.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** RFC 4180-style rectangular rows with CRLF separators and formula-safe text. */
export function buildRunCsv(result: OptimizationResult, options: RunExportOptions = {}): string {
  const columns = ["section", "run_id", "candidate_id", "field", "value", "unit", "note"] as const;
  return [columns.join(","), ...buildRunExportRows(result, options).map(row => columns.map(column => csvCell(row[column])).join(","))].join("\r\n") + "\r\n";
}
