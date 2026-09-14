import { candidateId } from "./candidate-identity";
import type { SiteComparisonArtifact, SiteEvaluation } from "./site-types";

type CsvCell = string | number | boolean | null;

const UTF8 = new TextEncoder();

// Prefix potentially executable text, and double existing leading apostrophes,
// so removing one prefix is reversible. Numbers keep their numeric signs.
function csvCell(value: CsvCell): string {
  let text = value === null ? "" : String(value);
  if (typeof value === "string" && (/^'/u.test(text) || /^[\s\u0000-\u001f]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/u.test(text))) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function siteComparisonCsv(rows: readonly (readonly CsvCell[])[]): string {
  return rows.map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** ZIP STORE entries: local files only, UTF-8 names, CRC32, no dependency or compression. */
export function buildSiteComparisonZip(files: Readonly<Record<string, string>>): Uint8Array<ArrayBuffer> {
  const entries = Object.entries(files).map(([name, text]) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(name)) throw new Error("ZIP filenames must be safe local basenames.");
    const filename = UTF8.encode(name);
    const data = UTF8.encode(text);
    return { filename, data, crc: crc32(data), offset: 0 };
  });
  if (entries.length > 0xffff) throw new Error("Too many ZIP entries.");
  let size = 22;
  for (const entry of entries) size += 30 + entry.filename.length + entry.data.length + 46 + entry.filename.length;
  if (size > 0xffffffff) throw new Error("ZIP exceeds the supported size.");
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  const u16 = (value: number) => { view.setUint16(offset, value, true); offset += 2; };
  const u32 = (value: number) => { view.setUint32(offset, value, true); offset += 4; };
  const copy = (value: Uint8Array) => { bytes.set(value, offset); offset += value.length; };
  for (const entry of entries) {
    entry.offset = offset;
    u32(0x04034b50); u16(20); u16(0x0800); u16(0); u16(0); u16(33);
    u32(entry.crc); u32(entry.data.length); u32(entry.data.length);
    u16(entry.filename.length); u16(0); copy(entry.filename); copy(entry.data);
  }
  const centralOffset = offset;
  for (const entry of entries) {
    u32(0x02014b50); u16(20); u16(20); u16(0x0800); u16(0); u16(0); u16(33);
    u32(entry.crc); u32(entry.data.length); u32(entry.data.length);
    u16(entry.filename.length); u16(0); u16(0); u16(0); u16(0); u32(0); u32(entry.offset);
    copy(entry.filename);
  }
  const centralSize = offset - centralOffset;
  u32(0x06054b50); u16(0); u16(0); u16(entries.length); u16(entries.length);
  u32(centralSize); u32(centralOffset); u16(0);
  return bytes;
}

export function exportSiteComparisonJson(artifact: SiteComparisonArtifact): string {
  return JSON.stringify(artifact, null, 2) + "\n";
}

const INPUT_UNITS: Record<string, string> = {
  length_ft: "ft", width_ft: "ft", canopy_sqft: "ft^2", footprint_sqft: "ft^2",
  watts: "W", entered_watts: "W", aggregate_watts: "W", lighting_watts: "W", other_watts: "W", power_limit_watts: "W",
  peak_modeled_watts: "W", hours_per_day: "h/day", baseline_hours: "h/day", other_hours: "h/day",
  hours: "h/day", photoperiod_hours: "h/day", min_hours: "h/day", max_hours: "h/day",
  dim: "fraction", dim_fraction: "fraction", baseline_dim: "fraction", humidity_pct: "%",
  ppfd_full: "umol/m^2/s", min_dli: "mol/m^2/day", dli_mol_m2_day: "mol/m^2/day",
  horizon_days: "days", operating_days: "days", cycle_days: "days/cycle", completed_cycles: "cycles",
  turnover_days: "days", idle_days: "days", starts_per_cycle: "starts/cycle", temperature_c: "degC",
  co2_ppm: "ppm", ph: "pH", ec_ms_cm: "mS/cm", water_liters_day: "L/day",
  routine_labor_hours_cycle: "h/cycle", setup_labor_hours: "h", kg_per_cycle: "kg/cycle",
  electricity_usd_kwh: "USD/kWh", daily_energy_kwh: "kWh/day", period_energy_kwh: "kWh",
  period_energy_cost_usd: "USD", period_water_liters: "L", energy_pct: "%",
  energy_kwh: "kWh", peak_watts: "W", output_kg: "kg", water_liters: "L", work_hours: "h",
  new_setup_cash_usd: "USD", recurring_cash_usd: "USD", horizon_cash_usd: "USD",
  energy_per_kg: "kWh/kg", water_per_kg: "L/kg", recurring_cash_per_kg: "USD/kg", horizon_cash_per_kg: "USD/kg",
  light_count: "fixtures", configurations_evaluated: "settings", feasible_configurations: "settings",
  scenario_count: "scenarios", feasible_count: "scenarios", version: "version", revision: "revision",
  explicit_horizon_amount: "USD", ppfd_umol_m2_s: "umol/m^2/s", conversion: "mol/umol * s/h",
};
const COST_BASIS: Record<string, string> = { electricity: "kwh", water: "liter", routine_labor: "routine_hour", setup_labor: "setup_hour", consumables: "cycle", maintenance: "cycle", new_equipment: "horizon", setup_materials: "horizon" };
const BASIS_UNITS: Record<string, { quantity: string; rate: string }> = { kwh: { quantity: "kWh", rate: "USD/kWh" }, liter: { quantity: "L", rate: "USD/L" }, routine_hour: { quantity: "h", rate: "USD/h" }, setup_hour: { quantity: "h", rate: "USD/h" }, cycle: { quantity: "cycles", rate: "USD/cycle" }, horizon: { quantity: "horizon", rate: "not applicable" }, daily_load: { quantity: "h/day", rate: "kW" }, asset: { quantity: "assets", rate: "not applicable" } };

export type SiteComparisonEvidenceRow = {
  record_kind: string; comparison_id: string; evaluation_id: string; scenario_id: string;
  module_run_id: string; entity_id: string; version: number | null; json_path: string;
  value_json: string; value: CsvCell; unit: string; source: string; evidence_reference: string;
  raw_value: number | null; reported_value: number | null; expression: string; status: string; reason: string;
};

const EVIDENCE_COLUMNS: (keyof SiteComparisonEvidenceRow)[] = ["record_kind", "comparison_id", "evaluation_id", "scenario_id", "module_run_id", "entity_id", "version", "json_path", "value_json", "value", "unit", "source", "evidence_reference", "raw_value", "reported_value", "expression", "status", "reason"];
const asObject = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const stringValue = (v: unknown): string => typeof v === "string" ? v : "";
const numberValue = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;

function recordKind(path: string): string {
  if (path.includes("/formulas/")) return "formula";
  if (path.includes("/constraints/") || path.includes("/limits/")) return "constraint";
  if (path.includes("/usage_lines/") || path.includes("/loads/")) return "usage";
  if (path.includes("/cost_lines/") || path.includes("/costs/")) return "cost";
  if (path.includes("/benchmark/") || path.includes("/applicability/")) return "benchmark";
  if (path.includes("/evidence/")) return "assumption";
  if (path.includes("/module_result/")) return "lighting_module";
  if (path.includes("/metrics/") || path.includes("/differences/")) return "metric";
  if (path.includes("/input_snapshot/") || path.includes("/snapshot/")) return "input";
  return "metadata";
}

/** Exact scalar projection with JSON pointers. No current form values or recomputed metrics. */
export function buildSiteComparisonEvidenceRows(artifact: SiteComparisonArtifact): SiteComparisonEvidenceRow[] {
  const rows: SiteComparisonEvidenceRow[] = [];
  type Context = { evaluation?: SiteEvaluation; entityId: string; version: number | null; source: string; evidence: string; unit: string; status: string; reason: string; basis?: string; formula?: Record<string, unknown> };
  const walk = (value: unknown, path: string, key: string, ctx: Context): void => {
    // Canonical byte strings are retained unchanged in the paired JSON, not repeated as giant CSV cells.
    if (key === "canonical_json" || key === "input_canonical_json") return;
    if (path.includes("/module_result/candidates")) return;
    const obj = asObject(value);
    if (obj) {
      const ev = asObject(obj.evidence);
      const evaluation = path.match(/^\/payload\/evaluations\/(\d+)$/u) ? artifact.payload.evaluations[Number(path.split("/").pop())] : ctx.evaluation;
      const next: Context = {
        ...ctx, evaluation,
        entityId: stringValue(obj.id) || ctx.entityId,
        version: numberValue(obj.version) ?? numberValue(obj.revision) ?? ctx.version,
        source: stringValue(ev?.source) || stringValue(obj.provenance) || stringValue(obj.source) || ctx.source,
        evidence: ev ? `${stringValue(ev.id)}@${String(ev.version)}` : ctx.evidence,
        unit: stringValue(obj.unit) || (obj.basis ? "USD" : ctx.unit),
        basis: stringValue(obj.basis) || COST_BASIS[stringValue(obj.category)] || (obj.unit === "kWh/day" ? "daily_load" : obj.power_basis ? "asset" : ctx.basis),
        status: stringValue(obj.status) || (typeof obj.complete === "boolean" ? obj.complete ? "complete" : "unknown" : ctx.status),
        reason: stringValue(obj.reason) || ctx.reason,
        formula: typeof obj.expression === "string" ? obj : ctx.formula,
      };
      for (const [childKey, child] of Object.entries(obj)) walk(child, `${path}/${childKey.replace(/~/g, "~0").replace(/\//g, "~1")}`, childKey, next);
      if (Object.keys(obj).length) return;
    } else if (Array.isArray(value) && value.length) {
      value.forEach((child, i) => walk(child, `${path}/${i}`, String(i), ctx)); return;
    }
    const scalar: CsvCell = value === null ? null : ["string", "number", "boolean"].includes(typeof value) ? value as CsvCell : JSON.stringify(value);
    const nullStatus = value === null ? ctx.status === "excluded" ? "excluded" : "unknown" : ctx.status || "recorded";
    const basisUnit = (key === "rate" || key === "quantity") && ctx.basis ? BASIS_UNITS[ctx.basis]?.[key] : null;
    const unit = INPUT_UNITS[key] || basisUnit || (typeof value === "number" || value === null ? ctx.unit || "not specified" : typeof value === "boolean" ? "boolean" : "label");
    rows.push({ record_kind: recordKind(path), comparison_id: artifact.payload.id, evaluation_id: ctx.evaluation?.id ?? "", scenario_id: ctx.evaluation?.scenario_id ?? "", module_run_id: ctx.evaluation?.module_result?.run?.id ?? "", entity_id: ctx.entityId, version: ctx.version, json_path: path, value_json: JSON.stringify(value), value: scalar, unit, source: ctx.source || "not specified", evidence_reference: ctx.evidence, raw_value: numberValue(ctx.formula?.raw_value), reported_value: numberValue(ctx.formula?.reported_value), expression: stringValue(ctx.formula?.expression), status: nullStatus, reason: ctx.reason });
  };
  walk(artifact, "", "", { entityId: artifact.payload.id, version: null, source: "", evidence: "", unit: "", status: "", reason: "" });
  return rows;
}

function summaryRows(artifact: SiteComparisonArtifact): CsvCell[][] {
  const p = artifact.payload;
  const rows: CsvCell[][] = [["schema_version", "comparison_id", "created_at", "payload_sha256", "paired_json", "evaluation_id", "module_run_id", "scenario_id", "scenario_revision", "name", "role", "site_id", "site_revision", "boundary_id", "boundary_revision", "operation_id", "operation_revision", "operation_type", "horizon_days", "currency", "output_unit", "accounting_version", "benchmark_rules_version", "lighting_model_version", "source", "review_status", "benchmark_id", "benchmark_version", "benchmark_applicability", "goal_id", "goal_version", "goal_metric", "goal_direction", "feasibility", "eligible", "rank", "metric", "value", "known_subtotal", "unit", "status", "unknown_line_ids_json", "excluded_line_ids_json", "reason", "rank_reasons_json", "server_verification"]];
  for (const e of p.evaluations) {
    const s = e.snapshot.scenario, site = e.snapshot.site, op = e.snapshot.operation;
    const rank = p.ranks.find(r => r.evaluation_id === e.id);
    for (const [key, value] of Object.entries(e.metrics)) rows.push([
      artifact.schema_version, p.id, p.created_at, artifact.sha256, "comparison.json", e.id, e.module_result?.run?.id ?? null,
      s.id, s.revision, s.name, s.role, site.id, site.revision, site.boundary_id, site.boundary_revision,
      op.id, op.revision, op.operation_type, op.horizon_days, "USD", op.output_unit, p.accounting_version, p.benchmark_version, p.lighting_model_version,
      e.provenance, e.review_status, s.benchmark?.id ?? null, s.benchmark?.version ?? null, e.applicability.status,
      p.input_snapshot.goal.id, p.input_snapshot.goal.version, p.input_snapshot.goal.metric, p.input_snapshot.goal.direction,
      e.feasibility, rank?.eligible ?? false, rank?.rank ?? null, key, value.value, value.known_subtotal, value.unit,
      value.complete ? "complete" : "unknown", JSON.stringify(value.unknown_line_ids), JSON.stringify(value.excluded_line_ids), value.reason, JSON.stringify(rank?.reasons ?? []), "not_checked",
    ]);
  }
  return rows;
}

function candidateRows(artifact: SiteComparisonArtifact): CsvCell[][] {
  const rows: CsvCell[][] = [["comparison_id", "evaluation_id", "scenario_id", "module_run_id", "module_model_version", "candidate_id", "metric", "value", "unit", "status", "feasible", "rejection_reasons_json", "requested_setting", "module_selected_setting"]];
  for (const e of artifact.payload.evaluations) {
    const result = e.module_result;
    if (!result) continue;
    const selected = result.optimized ? candidateId(result.optimized) : null;
    for (const c of result.candidates) {
      const id = candidateId(c);
      for (const [key, value] of Object.entries(c)) {
        if (key === "feasible" || key === "rejected_for") continue;
        rows.push([artifact.payload.id, e.id, e.scenario_id, result.run?.id ?? null, result.model_version, id, key, value as number | null, INPUT_UNITS[key] || "not specified", value === null ? "unknown" : "recorded", c.feasible, JSON.stringify(c.rejected_for), id === e.requested_setting.candidate_id, id === selected]);
      }
    }
  }
  return rows;
}

export function buildSiteComparisonCsvBundle(artifact: SiteComparisonArtifact): Record<string, string> {
  const evidenceRows = buildSiteComparisonEvidenceRows(artifact);
  const evidenceCsv = (rows: SiteComparisonEvidenceRow[]) => siteComparisonCsv([EVIDENCE_COLUMNS, ...rows.map(row => EVIDENCE_COLUMNS.map(key => row[key]))]);
  return {
    "comparison.json": exportSiteComparisonJson(artifact),
    "summary.csv": siteComparisonCsv(summaryRows(artifact)),
    "evidence.csv": evidenceCsv(evidenceRows),
    "inputs.csv": evidenceCsv(evidenceRows.filter(row => ["input", "assumption", "benchmark"].includes(row.record_kind))),
    "usage.csv": evidenceCsv(evidenceRows.filter(row => row.record_kind === "usage")),
    "costs.csv": evidenceCsv(evidenceRows.filter(row => row.record_kind === "cost")),
    "constraints.csv": evidenceCsv(evidenceRows.filter(row => row.record_kind === "constraint")),
    "formulas.csv": evidenceCsv(evidenceRows.filter(row => row.record_kind === "formula")),
    "candidates.csv": siteComparisonCsv(candidateRows(artifact)),
    "README.txt": [
      `AcreIQ site comparison ${artifact.payload.id}`,
      `Envelope: ${artifact.schema_version}; created: ${artifact.payload.created_at}`,
      `Payload SHA-256: ${artifact.sha256}`,
      `Input SHA-256: ${artifact.payload.input_sha256}`,
      "comparison.json is the complete canonical decision record, including exact backend canonical strings, all snapshots and candidate ledgers.",
      "CSV files are inspectable projections, not lossless import formats. summary.csv is summary only; evidence.csv contains typed JSON-pointer scalar evidence. Smaller evidence CSV files are subsets of evidence.csv, not additional accounting charges.",
      "Candidate identity is (module_run_id, candidate_id), using exact hours and dim fraction, never row order. Module-selected settings are not silently substituted for the requested scenario setting.",
      "Signed new differences use scenario_minus_current: negative energy/cash means less, positive means more, zero means no change. Legacy lighting savings inside module evidence retain baseline-minus-selected.",
      "All CSV fields are quoted, UTF-8, with CRLF records and escaped quotes. Numeric nulls are blank with unknown/excluded status; zero remains numeric zero. value_json preserves exact typed values, including JSON null.",
      "Text beginning with apostrophe or spreadsheet formula-like prefixes is prefixed with one apostrophe. To reverse, remove exactly one leading apostrophe from that escaped text. Numeric signs are unchanged. JSON preserves original text.",
      "Raw numeric values are preserved; reported values carry their recorded rounding. Do not derive exact differences from rounded display values. Formula operands and expression versions remain in JSON and evidence CSV.",
      "Synthetic test fixture, where labeled, is not agronomic evidence. Output is conditional on the entered benchmark and applicability, not predicted yield or measured savings.",
      "Scoped costs exclude the explicitly listed boundary items. Unknown costs are not zero; incomplete totals are known subtotals.",
      "Local structural/hash integrity is content consistency only, not measured truth, authorship, server availability, or durable cloud storage. Server verification: not checked by export.",
    ].join("\r\n") + "\r\n",
  };
}

export function buildSiteComparisonCsvZip(artifact: SiteComparisonArtifact): Uint8Array<ArrayBuffer> {
  return buildSiteComparisonZip(buildSiteComparisonCsvBundle(artifact));
}
