import type { Scenario } from "./types";

export type NumericScenarioField = {
  [Field in keyof Scenario]: Scenario[Field] extends number | null ? Field : never;
}[keyof Scenario];

export const PPFD_RECORD_UNIT = "umol/m2/s";

export type PPFDRecordContext = Pick<Scenario,
  "length_ft" | "width_ft" | "canopy_sqft" | "lighting_watts" | "light_count"
>;

export type InputRecord = {
  kind: "user-recorded";
  source: Exclude<Scenario["source"], "sample">;
  value: number;
  unit: typeof PPFD_RECORD_UNIT;
  measured_on: string;
  method: string;
  note: string;
  recorded_at: string;
  context: PPFDRecordContext;
  context_fingerprint: string;
};

// The map can grow to other numeric fields; only ppfd_full records are supported now.
export type InputRecords = Partial<Record<NumericScenarioField, InputRecord>>;
export type PPFDRecordDetails = Pick<InputRecord, "measured_on" | "method" | "note">;
export type InputOrigin = "missing" | "sample-assumption" | "assumption" | "user-entered" | "user-recorded";

const contextFields = ["length_ft", "width_ft", "canopy_sqft", "lighting_watts", "light_count"] as const;
const recordFields = ["kind", "source", "value", "unit", "measured_on", "method", "note", "recorded_at", "context", "context_fingerprint"];

function plainObject(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object") return false;
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function contextSnapshot(scenario: Scenario): PPFDRecordContext {
  const { length_ft, width_ft, canopy_sqft, lighting_watts, light_count } = scenario;
  return { length_ft, width_ft, canopy_sqft, lighting_watts, light_count };
}

// An equality token for input context, not a signature or independent verification.
export function ppfdContextFingerprint(scenario: PPFDRecordContext): string | null {
  if (!contextFields.every(field => positive(scenario[field])) || !Number.isInteger(scenario.light_count)) return null;
  return JSON.stringify(["ppfd-context-v1", ...contextFields.map(field => scenario[field])]);
}

function calendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function recordedTime(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return calendarDate(value.slice(0, 10)) && Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function validPPFDRecord(input: unknown, scenario: Scenario): input is InputRecord {
  if (!plainObject(input) || Object.keys(input).length !== recordFields.length ||
    !recordFields.every(field => Object.hasOwn(input, field))) return false;
  if ((scenario.source !== "manual" && scenario.source !== "photo-assisted") ||
    !positive(scenario.ppfd_full) || input.kind !== "user-recorded" ||
    input.source !== scenario.source || input.value !== scenario.ppfd_full ||
    input.unit !== PPFD_RECORD_UNIT) return false;
  if (!calendarDate(input.measured_on) || !recordedTime(input.recorded_at) ||
    typeof input.method !== "string" || !input.method.trim() || input.method.length > 300 ||
    typeof input.note !== "string" || input.note.length > 2000) return false;
  const context = input.context;
  if (!plainObject(context) || Object.keys(context).length !== contextFields.length ||
    !contextFields.every(field => Object.hasOwn(context, field) && context[field] === scenario[field])) return false;
  const fingerprint = ppfdContextFingerprint(scenario);
  return fingerprint !== null && input.context_fingerprint === fingerprint;
}

/** Strict, non-mutating type guard. Empty maps are valid; undefined and stale entries are not. */
export function validInputRecords(input: unknown, scenario: Scenario): input is InputRecords {
  return plainObject(input) && Object.entries(input).every(([field, record]) =>
    field === "ppfd_full" && validPPFDRecord(record, scenario));
}

/** Invalid metadata is preserved separately, never attached as an applicable measurement record. */
export function exportInputRecords(input: unknown, scenario?: Scenario) {
  const valid = !!scenario && validInputRecords(input, scenario);
  const supplied = input != null && (!plainObject(input) || Object.keys(input).length > 0);
  return {
    input_records: valid ? input as InputRecords : {},
    input_record_status: !supplied ? "not_provided" : valid ? "frontend_local_unverified" : "invalid_or_stale_excluded",
    ...(supplied && !valid ? { unvalidated_input_records: input } : {}),
  };
}

/** Snapshots existing inputs only. Dates/method are explicit; no values or review flags are changed. */
export function createPPFDRecord(
  scenario: Scenario,
  details: PPFDRecordDetails,
  recordedAt: string = new Date().toISOString(),
): InputRecord | null {
  const record = {
    kind: "user-recorded",
    source: scenario.source,
    value: scenario.ppfd_full,
    unit: PPFD_RECORD_UNIT,
    measured_on: details.measured_on,
    method: details.method,
    note: details.note,
    recorded_at: recordedAt,
    context: contextSnapshot(scenario),
    context_fingerprint: ppfdContextFingerprint(scenario),
  };
  return validPPFDRecord(record, scenario) ? record : null;
}

/** Classification is provenance, never validation of the number or a measurement's accuracy. */
export function inputOrigin(
  field: NumericScenarioField,
  scenario: Scenario,
  records: InputRecords | undefined,
  assumptions?: Partial<Record<NumericScenarioField, unknown>>,
): InputOrigin {
  const value = scenario[field];
  if (typeof value !== "number" || !Number.isFinite(value) || (field === "ppfd_full" && value <= 0)) return "missing";
  if (scenario.source === "sample") return "sample-assumption";
  if (assumptions && Object.hasOwn(assumptions, field) && assumptions[field] != null) return "assumption";
  if (validInputRecords(records, scenario) && records[field]) return "user-recorded";
  return "user-entered";
}
